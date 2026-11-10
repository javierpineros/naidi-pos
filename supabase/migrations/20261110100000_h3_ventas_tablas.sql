-- H3 (1/3): tablas de ventas, vouchers, libro de puntos y QR posterior a la venta.
-- Ningún rol de la API escribe directo: todo pasa por funciones del servidor (migración 2/3).
-- Los clientes no leen ventas, vouchers, puntos ni tokens directamente: solo por funciones propias.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Perfil mínimo del cliente. H4 lo amplía (foto, celular, cumpleaños, consentimientos).
-- ---------------------------------------------------------------------------------------------
create table public.perfiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  nombre     text not null check (length(btrim(nombre)) > 0),
  created_at timestamptz not null default now()
);
alter table public.perfiles enable row level security;
revoke all on public.perfiles from anon, authenticated;
grant select on public.perfiles to authenticated;
create policy perfiles_ver on public.perfiles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.es_staff()));

-- ---------------------------------------------------------------------------------------------
-- Ventas. Estados: alistando -> confirmada -> pagada; cancelada (antes de pagar) y anulada (después).
-- ---------------------------------------------------------------------------------------------
create table public.ventas (
  id                    uuid primary key default gen_random_uuid(),
  numero                bigint generated always as identity unique,
  idempotency_key       uuid not null unique,
  estado                text not null default 'alistando'
                          check (estado in ('alistando', 'confirmada', 'pagada', 'cancelada', 'anulada')),
  canal                 text not null default 'tienda' check (canal in ('tienda', 'web')),
  cliente_id            uuid references auth.users (id),
  creada_por            uuid references auth.users (id),
  creada_offline        boolean not null default false,
  creada_en             timestamptz not null default now(),
  registrada_en         timestamptz not null default now(),
  subtotal_cop          integer not null default 0 check (subtotal_cop >= 0),
  descuento_cop         integer not null default 0 check (descuento_cop >= 0),
  total_cop             integer not null default 0 check (total_cop >= 0),
  confirmada_en         timestamptz,
  pagada_en             timestamptz,
  cancelada_en          timestamptz,
  anulada_en            timestamptz,
  motivo_cancelacion    text,
  motivo_anulacion      text,
  anulada_por           uuid references auth.users (id),
  medio_pago            text check (medio_pago in ('efectivo', 'datafono_bold', 'transferencia', 'bold_online')),
  efectivo_recibido_cop integer check (efectivo_recibido_cop >= 0),
  cambio_cop            integer check (cambio_cop >= 0),
  constraint ventas_total_coherente check (total_cop = subtotal_cop - descuento_cop),
  constraint ventas_pago_coherente check ((pagada_en is not null) = (estado in ('pagada', 'anulada'))),
  constraint ventas_medio_coherente check ((medio_pago is not null) = (estado in ('pagada', 'anulada'))),
  constraint ventas_cancelacion_coherente check ((cancelada_en is not null) = (estado = 'cancelada'))
);
create index ventas_estado_idx   on public.ventas (estado);
create index ventas_cliente_idx  on public.ventas (cliente_id) where cliente_id is not null;
create index ventas_pagada_idx   on public.ventas (pagada_en) where pagada_en is not null;

-- ---------------------------------------------------------------------------------------------
-- Vouchers (premio canjeado o regalo de bienvenida). Un solo uso.
-- activo -> reservado (aplicado a una venta en alistando) -> usado (venta confirmada).
-- ---------------------------------------------------------------------------------------------
create table public.vouchers (
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references auth.users (id),
  tipo               text not null check (tipo in ('premio', 'bienvenida')),
  descuento_pct      smallint not null check (descuento_pct between 1 and 100),
  tamanos_permitidos text[] not null check (cardinality(tamanos_permitidos) > 0),
  estado             text not null default 'activo' check (estado in ('activo', 'reservado', 'usado')),
  vence_en           timestamptz not null,
  creado_en          timestamptz not null default now(),
  usado_en           timestamptz,
  venta_id           uuid references public.ventas (id)
);
create index vouchers_cliente_idx on public.vouchers (cliente_id);
-- El regalo de bienvenida se otorga una sola vez por cuenta.
create unique index vouchers_una_bienvenida on public.vouchers (cliente_id) where tipo = 'bienvenida';

-- ---------------------------------------------------------------------------------------------
-- Líneas de la venta: guardan el precio con que se vendió (no cambia si cambia el catálogo).
-- ---------------------------------------------------------------------------------------------
create table public.venta_lineas (
  id                 uuid primary key default gen_random_uuid(),
  venta_id           uuid not null references public.ventas (id),
  orden              smallint not null,
  producto_clave     text not null references public.productos (clave),
  producto_nombre    text not null,
  categoria          text not null,
  tamano             text references public.tamanos (clave),
  presentacion       text references public.presentaciones (clave),
  base               text references public.bases (clave),
  toppings           jsonb not null default '[]'::jsonb,
  cantidad           smallint not null default 1 check (cantidad between 1 and 20),
  precio_unitario_cop integer not null check (precio_unitario_cop >= 0),
  voucher_id         uuid references public.vouchers (id),
  descuento_cop      integer not null default 0 check (descuento_cop >= 0),
  unique (venta_id, orden),
  check (descuento_cop <= precio_unitario_cop)
);

-- Historial de transiciones (inmutable).
create table public.venta_eventos (
  id        bigint generated always as identity primary key,
  venta_id  uuid not null references public.ventas (id),
  de_estado text,
  a_estado  text not null,
  actor     uuid,
  motivo    text,
  detalle   jsonb not null default '{}'::jsonb,
  en        timestamptz not null default now()
);
create index venta_eventos_venta_idx on public.venta_eventos (venta_id);

-- ---------------------------------------------------------------------------------------------
-- Libro de puntos: inmutable. Cada movimiento es una fila nueva con la versión de reglas usada.
-- El saldo es la suma del libro. Las restricciones únicas son la garantía contra duplicados.
-- ---------------------------------------------------------------------------------------------
create table public.puntos_libro (
  id              bigint generated always as identity primary key,
  cliente_id      uuid not null references auth.users (id),
  tipo            text not null check (tipo in ('suma', 'canje', 'anulacion', 'bono')),
  puntos          integer not null check (puntos <> 0),
  venta_id        uuid references public.ventas (id),
  voucher_id      uuid references public.vouchers (id),
  regla_versiones jsonb not null default '{}'::jsonb,
  nota            text,
  creado_en       timestamptz not null default now(),
  constraint puntos_signo check (
    (tipo in ('suma', 'bono') and puntos > 0) or (tipo in ('canje', 'anulacion') and puntos < 0)),
  constraint puntos_referencia check (
    (tipo in ('suma', 'anulacion') and venta_id is not null)
    or (tipo = 'canje' and voucher_id is not null)
    or tipo = 'bono')
);
create index puntos_cliente_idx on public.puntos_libro (cliente_id);
create unique index puntos_una_suma_por_venta       on public.puntos_libro (venta_id)   where tipo = 'suma';
create unique index puntos_una_anulacion_por_venta  on public.puntos_libro (venta_id)   where tipo = 'anulacion';
create unique index puntos_un_canje_por_voucher     on public.puntos_libro (voucher_id) where tipo = 'canje';

-- ---------------------------------------------------------------------------------------------
-- QR posterior a la venta: solo se guarda el hash (SHA-256) del token de 256 bits.
-- ---------------------------------------------------------------------------------------------
create table public.qr_posventa (
  id            uuid primary key default gen_random_uuid(),
  venta_id      uuid not null unique references public.ventas (id),
  token_hash    bytea not null unique,
  creado_en     timestamptz not null default now(),
  vence_en      timestamptz not null,
  usado_en      timestamptz,
  usado_por     uuid references auth.users (id),
  invalidado_en timestamptz
);
create index qr_usado_por_idx on public.qr_posventa (usado_por, usado_en) where usado_por is not null;

-- ---------------------------------------------------------------------------------------------
-- Inmutabilidad
-- ---------------------------------------------------------------------------------------------
create trigger puntos_libro_inmutable before update or delete on public.puntos_libro
  for each row execute function private.bloquear_mutacion();
create trigger puntos_libro_sin_truncate before truncate on public.puntos_libro
  for each statement execute function private.bloquear_mutacion();
create trigger venta_eventos_inmutable before update or delete on public.venta_eventos
  for each row execute function private.bloquear_mutacion();
create trigger venta_eventos_sin_truncate before truncate on public.venta_eventos
  for each statement execute function private.bloquear_mutacion();

-- Transiciones válidas de la venta y campos que no se pueden tocar fuera de "alistando".
create function private.validar_transicion_venta() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.estado in ('cancelada', 'anulada') then
    raise exception 'La venta % ya está %; no admite cambios.', old.numero, old.estado using errcode = 'restrict_violation';
  end if;
  if new.idempotency_key <> old.idempotency_key or new.numero <> old.numero then
    raise exception 'La identidad de la venta no se puede cambiar.' using errcode = 'restrict_violation';
  end if;
  if new.estado <> old.estado and not ((old.estado, new.estado) in (
      ('alistando', 'confirmada'), ('alistando', 'cancelada'),
      ('confirmada', 'pagada'), ('confirmada', 'cancelada'), ('pagada', 'anulada'))) then
    raise exception 'Transición no permitida: % -> %.', old.estado, new.estado using errcode = 'restrict_violation';
  end if;
  if new.cliente_id is distinct from old.cliente_id and (old.cliente_id is not null or old.estado not in ('alistando', 'pagada')) then
    raise exception 'El cliente de la venta no se puede cambiar así.' using errcode = 'restrict_violation';
  end if;
  if old.estado <> 'alistando' and new.estado = old.estado
     and (new.subtotal_cop, new.descuento_cop, new.total_cop) is distinct from (old.subtotal_cop, old.descuento_cop, old.total_cop) then
    raise exception 'Los montos de una venta % no se pueden cambiar.', old.estado using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger ventas_transiciones before update on public.ventas
  for each row execute function private.validar_transicion_venta();

create function private.lineas_solo_alistando() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_estado text;
  v_id uuid := coalesce(new.venta_id, old.venta_id);
begin
  select estado into v_estado from public.ventas where id = v_id;
  if v_estado is distinct from 'alistando' then
    raise exception 'Solo se pueden cambiar las líneas de una venta en alistando (estado actual: %).', v_estado
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger lineas_solo_alistando before insert or update or delete on public.venta_lineas
  for each row execute function private.lineas_solo_alistando();

-- ---------------------------------------------------------------------------------------------
-- RLS: denegación por defecto. Solo el personal lee ventas; solo el dueño lee puntos y vouchers.
-- qr_posventa no tiene permisos ni políticas: nadie de la API la toca.
-- ---------------------------------------------------------------------------------------------
alter table public.ventas        enable row level security;
alter table public.venta_lineas  enable row level security;
alter table public.venta_eventos enable row level security;
alter table public.vouchers      enable row level security;
alter table public.puntos_libro  enable row level security;
alter table public.qr_posventa   enable row level security;

revoke all on public.ventas, public.venta_lineas, public.venta_eventos, public.vouchers,
              public.puntos_libro, public.qr_posventa from anon, authenticated;
grant select on public.ventas, public.venta_lineas, public.venta_eventos to authenticated;
grant select on public.vouchers, public.puntos_libro to authenticated;

create policy ventas_ver_staff        on public.ventas        for select to authenticated using ((select private.es_staff()));
create policy venta_lineas_ver_staff  on public.venta_lineas  for select to authenticated using ((select private.es_staff()));
create policy venta_eventos_ver_staff on public.venta_eventos for select to authenticated using ((select private.es_staff()));
create policy vouchers_ver_dueno      on public.vouchers      for select to authenticated using ((select private.es_dueno()));
create policy puntos_ver_dueno        on public.puntos_libro  for select to authenticated using ((select private.es_dueno()));
