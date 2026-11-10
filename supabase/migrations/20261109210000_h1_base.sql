-- H1: cimientos. Roles del personal, reglas versionadas, banderas y auditoría.
-- Principio: RLS activado y denegación por defecto. Nada se escribe directo desde el navegador;
-- las escrituras sensibles llegan en hitos posteriores como funciones del servidor con search_path fijo.

create extension if not exists btree_gist with schema extensions;

-- Esquema interno: no está expuesto por la API. Aquí viven los ayudantes que usan las políticas.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Personal (cajero, dueño). El rol vive aquí, en el servidor; el usuario no lo puede editar
-- (no se lee de user_metadata ni de ningún dato que el usuario controle).
-- ---------------------------------------------------------------------------------------------
create table public.staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  rol        text not null check (rol in ('cajero', 'dueno')),
  nombre     text not null check (length(btrim(nombre)) > 0),
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.staff is 'Personal con acceso al POS. Cuentas individuales, nunca compartidas.';

create function private.es_staff() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.activo);
$$;

create function private.es_dueno() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.activo and s.rol = 'dueno');
$$;

create function private.es_cajero() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.activo and s.rol = 'cajero');
$$;

revoke all on function private.es_staff(), private.es_dueno(), private.es_cajero() from public;
grant execute on function private.es_staff(), private.es_dueno(), private.es_cajero() to authenticated;

alter table public.staff enable row level security;
revoke all on public.staff from anon, authenticated;
grant select on public.staff to authenticated;

create policy staff_ver_propio_o_dueno on public.staff
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.es_dueno()));

-- ---------------------------------------------------------------------------------------------
-- Inmutabilidad: ayudante para tablas que solo admiten inserciones.
-- ---------------------------------------------------------------------------------------------
create function private.bloquear_mutacion() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'La tabla % es inmutable: no se permite % de filas.', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Auditoría: anulaciones, descuentos, reasignaciones y cambios de reglas. Solo el dueño la lee.
-- Se escribe únicamente desde funciones del servidor mediante private.auditar().
-- ---------------------------------------------------------------------------------------------
create table public.auditoria (
  id         bigint generated always as identity primary key,
  en         timestamptz not null default now(),
  actor      uuid,
  accion     text not null check (length(btrim(accion)) > 0),
  entidad    text not null,
  entidad_id text,
  detalle    jsonb not null default '{}'::jsonb
);
create index auditoria_en_idx on public.auditoria (en desc);
create index auditoria_entidad_idx on public.auditoria (entidad, entidad_id);

create trigger auditoria_inmutable
  before update or delete on public.auditoria
  for each row execute function private.bloquear_mutacion();
create trigger auditoria_sin_truncate
  before truncate on public.auditoria
  for each statement execute function private.bloquear_mutacion();

alter table public.auditoria enable row level security;
revoke all on public.auditoria from anon, authenticated;
grant select on public.auditoria to authenticated;

create policy auditoria_ver_dueno on public.auditoria
  for select to authenticated
  using ((select private.es_dueno()));

create function private.auditar(p_accion text, p_entidad text, p_entidad_id text default null, p_detalle jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.auditoria (actor, accion, entidad, entidad_id, detalle)
  values ((select auth.uid()), p_accion, p_entidad, p_entidad_id, coalesce(p_detalle, '{}'::jsonb));
$$;
revoke all on function private.auditar(text, text, text, jsonb) from public;

-- ---------------------------------------------------------------------------------------------
-- Reglas de negocio: tabla versionada con fecha de vigencia. Nada de esto va en el código.
-- Una fila nueva por cambio; la anterior solo se cierra poniéndole vigente_hasta.
-- ---------------------------------------------------------------------------------------------
create table public.reglas_negocio (
  id            bigint generated always as identity primary key,
  clave         text not null check (length(btrim(clave)) > 0),
  version       integer not null check (version > 0),
  valor         jsonb not null,
  descripcion   text,
  publica       boolean not null default false,
  vigente_desde timestamptz not null default now(),
  vigente_hasta timestamptz,
  creado_por    uuid,
  created_at    timestamptz not null default now(),
  unique (clave, version),
  check (vigente_hasta is null or vigente_hasta > vigente_desde),
  -- Una sola versión vigente por clave en cada instante.
  constraint reglas_sin_solape exclude using gist (
    clave with =, tstzrange(vigente_desde, vigente_hasta) with &&
  )
);
comment on column public.reglas_negocio.publica is 'true: la puede leer cualquier usuario autenticado (p. ej. umbrales de premios).';

create function private.reglas_solo_cerrar() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Las reglas no se borran: se cierran con vigente_hasta.' using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new) - 'vigente_hasta') is distinct from (to_jsonb(old) - 'vigente_hasta')
     or old.vigente_hasta is not null then
    raise exception 'Una regla solo admite cerrar su vigencia (vigente_hasta); crea una versión nueva para cambiarla.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger reglas_solo_cerrar
  before update or delete on public.reglas_negocio
  for each row execute function private.reglas_solo_cerrar();

alter table public.reglas_negocio enable row level security;
revoke all on public.reglas_negocio from anon, authenticated;
grant select on public.reglas_negocio to authenticated;

create policy reglas_ver on public.reglas_negocio
  for select to authenticated
  using (publica or (select private.es_staff()));

-- Valor vigente de una regla en un instante dado (por defecto, ahora). Lo usan las funciones del servidor.
create function private.regla_vigente(p_clave text, p_en timestamptz default now())
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select r.valor
  from public.reglas_negocio r
  where r.clave = p_clave
    and r.vigente_desde <= p_en
    and (r.vigente_hasta is null or r.vigente_hasta > p_en);
$$;
revoke all on function private.regla_vigente(text, timestamptz) from public;

-- ---------------------------------------------------------------------------------------------
-- Banderas: interruptores de funciones, con ventana opcional de fechas.
-- ---------------------------------------------------------------------------------------------
create table public.banderas (
  clave       text primary key check (length(btrim(clave)) > 0),
  activa      boolean not null default false,
  desde       timestamptz,
  hasta       timestamptz,
  descripcion text,
  updated_at  timestamptz not null default now(),
  check (hasta is null or desde is null or hasta > desde)
);

alter table public.banderas enable row level security;
revoke all on public.banderas from anon, authenticated;
grant select on public.banderas to authenticated;

create policy banderas_ver_staff on public.banderas
  for select to authenticated
  using ((select private.es_staff()));

create function private.bandera_activa(p_clave text, p_en timestamptz default now())
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select b.activa and (b.desde is null or b.desde <= p_en) and (b.hasta is null or b.hasta > p_en)
     from public.banderas b where b.clave = p_clave),
    false);
$$;
revoke all on function private.bandera_activa(text, timestamptz) from public;
