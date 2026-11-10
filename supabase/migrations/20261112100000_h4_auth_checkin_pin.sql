-- H4: cuentas (perfil automático y consentimientos), check-in con el QR de entrada, PIN del dueño,
-- verificación en dos pasos (aal2) y acciones sensibles que exigen PIN.
-- El inicio de sesión (Google, correo con código, TOTP) lo gestiona Supabase Auth; ver supabase/config.toml.

-- =============================================================================================
-- 1. Verificación en dos pasos del dueño: sin sesión aal2 no hay permisos de dueño
-- =============================================================================================
create or replace function private.es_dueno() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.activo and s.rol = 'dueno')
     and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2';
$$;

-- El personal: cajeros con su sesión normal; el dueño solo con segundo factor.
create or replace function private.es_staff() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = (select auth.uid()) and s.activo
      and (s.rol = 'cajero' or coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'));
$$;

-- Un cliente es quien tiene perfil y no es personal (el personal no reclama puntos ni canjea).
create or replace function private.exigir_cliente() returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null
     or not exists (select 1 from public.perfiles where user_id = v_uid)
     or exists (select 1 from public.staff where user_id = v_uid) then
    raise exception 'Inicia sesión con tu cuenta de cliente para continuar.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- =============================================================================================
-- 2. Perfil automático al crearse la cuenta (Google o correo con código) y datos por etapas
-- =============================================================================================
alter table public.perfiles
  add column foto_url text check (foto_url is null or foto_url ~ '^https://'),
  add column celular text check (celular is null or celular ~ '^[0-9+() -]{7,20}$'),
  add column cumpleanos date;

create function private.crear_perfil() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_nombre text;
  v_foto text;
begin
  v_nombre := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '');
  if v_nombre is null then
    v_nombre := nullif(initcap(replace(split_part(coalesce(new.email, ''), '@', 1), '.', ' ')), '');
  end if;
  v_foto := nullif(coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture', ''), '');
  insert into public.perfiles (user_id, nombre, foto_url)
  values (new.id, coalesce(v_nombre, 'Cliente'), case when v_foto ~ '^https://' then v_foto end)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
create trigger crear_perfil after insert on auth.users for each row execute function private.crear_perfil();

-- El POS muestra solo nombre de pila e inicial del apellido.
create function private.nombre_pila(p text) returns text
language sql immutable set search_path = ''
as $$ select split_part(btrim(coalesce(p, '')), ' ', 1) $$;

create function private.inicial_apellido(p text) returns text
language sql immutable set search_path = ''
as $$
  select case when cardinality(regexp_split_to_array(btrim(coalesce(p, '')), '\s+')) > 1
              then upper(left((regexp_split_to_array(btrim(p), '\s+'))[cardinality(regexp_split_to_array(btrim(p), '\s+'))], 1))
              else '' end
$$;

-- Celular y cumpleaños se piden después, con un motivo claro; ambos son opcionales.
create function public.actualizar_mi_perfil(p_celular text default null, p_cumpleanos date default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  if p_cumpleanos is not null and (p_cumpleanos > current_date or p_cumpleanos < date '1900-01-01') then
    raise exception 'Revisa la fecha de tu cumpleaños.';
  end if;
  if p_celular is not null and btrim(p_celular) !~ '^[0-9+() -]{7,20}$' then
    raise exception 'Revisa tu número de celular.';
  end if;
  update public.perfiles
     set celular = coalesce(nullif(btrim(p_celular), ''), celular), cumpleanos = coalesce(p_cumpleanos, cumpleanos)
   where user_id = v_uid;
end;
$$;

-- =============================================================================================
-- 3. Consentimientos (Ley 1581): explícitos, versionados e inmutables
-- =============================================================================================
create table public.consentimientos (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  tipo    text not null check (tipo in ('datos', 'mensajes')),
  version text not null check (length(btrim(version)) > 0),
  acepta  boolean not null,
  en      timestamptz not null default now()
);
create index consentimientos_user_idx on public.consentimientos (user_id, tipo, en desc);
create trigger consentimientos_inmutable before update or delete on public.consentimientos
  for each row execute function private.bloquear_mutacion();
alter table public.consentimientos enable row level security;
revoke all on public.consentimientos from anon, authenticated;
grant select on public.consentimientos to authenticated;
create policy consentimientos_ver_propio on public.consentimientos for select to authenticated
  using (user_id = (select auth.uid()));
create policy consentimientos_ver_dueno on public.consentimientos for select to authenticated
  using ((select private.es_dueno()));

create function private.tiene_consentimiento_datos(p_user uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select c.acepta and c.version = (private.regla_vigente('privacidad.version') #>> '{}')
    from public.consentimientos c where c.user_id = p_user and c.tipo = 'datos'
    order by c.en desc, c.id desc limit 1), false);
$$;

create function public.registrar_consentimiento(p_tipo text, p_version text, p_acepta boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  if p_tipo not in ('datos', 'mensajes') then raise exception 'Tipo de consentimiento no válido.'; end if;
  if p_acepta is null then raise exception 'Indica si aceptas o no.'; end if;
  if p_tipo = 'datos' and p_version is distinct from (private.regla_vigente('privacidad.version') #>> '{}') then
    raise exception 'La política de privacidad cambió; vuelve a leerla y acéptala.';
  end if;
  insert into public.consentimientos (user_id, tipo, version, acepta) values (v_uid, p_tipo, p_version, p_acepta);
end;
$$;

-- =============================================================================================
-- 4. QR de entrada (token del punto de venta) y check-in
-- =============================================================================================
create table public.punto_venta (
  id         smallint primary key default 1 check (id = 1),
  token      text not null check (length(token) >= 32),
  rotado_en  timestamptz not null default now(),
  rotado_por uuid references auth.users (id)
);
-- El token se genera al aplicar la migración en cada entorno; no vive en el repositorio.
insert into public.punto_venta (token) values (encode(extensions.gen_random_bytes(24), 'hex'));
alter table public.punto_venta enable row level security;
revoke all on public.punto_venta from anon, authenticated;
grant select on public.punto_venta to authenticated;
create policy punto_venta_ver_staff on public.punto_venta for select to authenticated using ((select private.es_staff()));

create table public.checkins (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references auth.users (id),
  estado           text not null default 'activo' check (estado in ('activo', 'atendido', 'vencido', 'se_fue')),
  llegada_en       timestamptz not null default now(),
  vence_en         timestamptz not null,
  cliente_nuevo    boolean not null default false,
  alerta_vista_en  timestamptz,
  cerrado_en       timestamptz,
  cerrado_por      uuid references auth.users (id),
  constraint checkins_cierre_coherente check ((estado = 'activo') = (cerrado_en is null))
);
create index checkins_estado_idx on public.checkins (estado, llegada_en);
-- Un solo check-in activo por cuenta.
create unique index checkins_un_activo_por_cuenta on public.checkins (cliente_id) where estado = 'activo';
alter table public.checkins enable row level security;
revoke all on public.checkins from anon, authenticated;
grant select on public.checkins to authenticated;
create policy checkins_ver_staff on public.checkins for select to authenticated using ((select private.es_staff()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.checkins;
  end if;
end $$;

create function public.hacer_checkin(p_token text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  v_token text;
  v_hoy timestamptz := (date_trunc('day', now() at time zone 'America/Bogota')) at time zone 'America/Bogota';
  v_c public.checkins;
  v_nuevo boolean;
begin
  select token into v_token from public.punto_venta where id = 1;
  if p_token is null or p_token is distinct from v_token then
    raise exception 'Este QR de entrada no es válido. Escanea el que está en la tienda.';
  end if;
  if not private.tiene_consentimiento_datos(v_uid) then
    raise exception 'consentimiento_requerido: antes de continuar necesitamos tu autorización para tratar tus datos.';
  end if;
  perform 1 from public.perfiles where user_id = v_uid for update;   -- serializa check-ins simultáneos de la misma cuenta

  update public.checkins set estado = 'vencido', cerrado_en = now()
   where cliente_id = v_uid and estado = 'activo' and vence_en <= now();

  select * into v_c from public.checkins where cliente_id = v_uid and estado = 'activo';
  if found then
    return jsonb_build_object('checkin_id', v_c.id, 'llegada_en', v_c.llegada_en, 'vence_en', v_c.vence_en,
                              'cliente_nuevo', v_c.cliente_nuevo, 'ya_estaba', true);
  end if;

  if (select count(*) from public.checkins where cliente_id = v_uid and llegada_en >= v_hoy)
       >= private.regla_int('antifraude.max_checkins_dia') then
    raise exception 'Hoy ya registraste varias llegadas. Si necesitas algo, habla con el personal.';
  end if;

  v_nuevo := not exists (select 1 from public.checkins where cliente_id = v_uid)
         and not exists (select 1 from public.ventas where cliente_id = v_uid and estado in ('confirmada', 'pagada'));
  insert into public.checkins (cliente_id, vence_en, cliente_nuevo)
  values (v_uid, now() + make_interval(mins => private.regla_int('checkin.vigencia_min')), v_nuevo)
  returning * into v_c;
  perform private.otorgar_bienvenida(v_uid);   -- el regalo ya está listo cuando el vendedor lo ve
  return jsonb_build_object('checkin_id', v_c.id, 'llegada_en', v_c.llegada_en, 'vence_en', v_c.vence_en,
                            'cliente_nuevo', v_c.cliente_nuevo, 'ya_estaba', false);
end;
$$;

create function public.mi_checkin() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return (select jsonb_build_object('checkin_id', c.id, 'llegada_en', c.llegada_en, 'vence_en', c.vence_en, 'cliente_nuevo', c.cliente_nuevo)
            from public.checkins c where c.cliente_id = v_uid and c.estado = 'activo' and c.vence_en > now());
end;
$$;

-- Lista de clientes en espera para el POS: solo nombre de pila e inicial, foto y hora de llegada.
create function public.lista_espera() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'checkin_id', c.id, 'cliente_id', c.cliente_id,
      'nombre_pila', private.nombre_pila(p.nombre), 'inicial', private.inicial_apellido(p.nombre),
      'foto_url', p.foto_url, 'llegada_en', c.llegada_en, 'vence_en', c.vence_en,
      'cliente_nuevo', c.cliente_nuevo,
      'alerta_pendiente', (c.cliente_nuevo and c.alerta_vista_en is null),
      'regalo_bienvenida', exists (select 1 from public.vouchers w where w.cliente_id = c.cliente_id and w.tipo = 'bienvenida' and w.estado = 'activo' and w.vence_en > now()),
      'premio_listo', exists (select 1 from public.vouchers w where w.cliente_id = c.cliente_id and w.tipo = 'premio' and w.estado = 'activo' and w.vence_en > now()),
      'pedido_web_listo', false) order by c.llegada_en)
    from public.checkins c join public.perfiles p on p.user_id = c.cliente_id
    where c.estado = 'activo' and c.vence_en > now()
  ), '[]'::jsonb);
end;
$$;

create function public.marcar_alerta_vista(p_checkin uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  update public.checkins set alerta_vista_en = coalesce(alerta_vista_en, now()) where id = p_checkin;
end;
$$;

create function public.marcar_se_fue(p_checkin uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  update public.checkins set estado = 'se_fue', cerrado_en = now(), cerrado_por = (select auth.uid())
   where id = p_checkin and estado = 'activo';
end;
$$;

-- Al asignar el cliente a una venta, su check-in pasa a atendido.
create function private.checkin_atendido() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.checkins set estado = 'atendido', cerrado_en = now()
   where cliente_id = new.cliente_id and estado = 'activo';
  return new;
end;
$$;
create trigger ventas_checkin_atendido_ins after insert on public.ventas
  for each row when (new.cliente_id is not null) execute function private.checkin_atendido();
create trigger ventas_checkin_atendido_upd after update of cliente_id on public.ventas
  for each row when (new.cliente_id is not null and new.cliente_id is distinct from old.cliente_id) execute function private.checkin_atendido();

-- Reasignar el cliente de una venta sin pagar es posible (con PIN, más abajo); en una venta pagada no.
create or replace function private.validar_transicion_venta() returns trigger
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
  if new.cliente_id is distinct from old.cliente_id
     and not (old.estado in ('alistando', 'confirmada') or (old.cliente_id is null and old.estado = 'pagada')) then
    raise exception 'El cliente de la venta no se puede cambiar así.' using errcode = 'restrict_violation';
  end if;
  if old.estado <> 'alistando' and new.estado = old.estado
     and (new.subtotal_cop, new.descuento_cop, new.total_cop) is distinct from (old.subtotal_cop, old.descuento_cop, old.total_cop) then
    raise exception 'Los montos de una venta % no se pueden cambiar.', old.estado using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- =============================================================================================
-- 5. PIN del dueño (cifrado, con límite de intentos)
-- Un PIN incorrecto NO lanza error: devuelve {ok:false}. Así el conteo de intentos y la auditoría
-- se confirman; un error revertiría la transacción y los intentos fallidos no contarían.
-- =============================================================================================
create table private.staff_pin (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  pin_hash        text not null,
  intentos        smallint not null default 0,
  bloqueado_hasta timestamptz,
  updated_at      timestamptz not null default now()
);
alter table private.staff_pin enable row level security;
revoke all on private.staff_pin from public, anon, authenticated;

create function private.chequear_pin(p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  r private.staff_pin;
  v_max integer := private.regla_int('pin.max_intentos');
  v_nuevos integer;
begin
  select * into r from private.staff_pin where user_id = v_uid for update;
  if not found then return jsonb_build_object('estado', 'sin_pin'); end if;
  if r.bloqueado_hasta is not null and r.bloqueado_hasta > now() then
    return jsonb_build_object('estado', 'bloqueado', 'bloqueado_hasta', r.bloqueado_hasta);
  end if;
  if p_pin is not null and r.pin_hash = extensions.crypt(p_pin, r.pin_hash) then
    update private.staff_pin set intentos = 0, bloqueado_hasta = null where user_id = v_uid;
    return jsonb_build_object('estado', 'ok');
  end if;
  v_nuevos := r.intentos + 1;
  if v_nuevos >= v_max then
    update private.staff_pin set intentos = 0, bloqueado_hasta = now() + make_interval(mins => private.regla_int('pin.bloqueo_min'))
     where user_id = v_uid;
    return jsonb_build_object('estado', 'bloqueado', 'bloqueado_hasta', now() + make_interval(mins => private.regla_int('pin.bloqueo_min')));
  end if;
  update private.staff_pin set intentos = v_nuevos where user_id = v_uid;
  return jsonb_build_object('estado', 'incorrecto', 'intentos_restantes', v_max - v_nuevos);
end;
$$;

-- Exige dueño con segundo factor (lanza error si no lo es) y valida el PIN.
-- Devuelve null si todo está bien, o el resultado {ok:false,...} que la función debe devolver tal cual.
create function private.exigir_pin(p_pin text, p_accion text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v jsonb;
begin
  if not (select private.es_dueno()) then
    raise exception 'Solo el dueño, con verificación en dos pasos, puede hacer esto.' using errcode = '42501';
  end if;
  v := private.chequear_pin(p_pin);
  if v ->> 'estado' = 'ok' then return null; end if;
  perform private.auditar('pin_fallido', 'pin', p_accion, jsonb_build_object('estado', v ->> 'estado'));
  return jsonb_build_object('ok', false, 'error', case v ->> 'estado'
      when 'sin_pin' then 'sin_pin' when 'bloqueado' then 'pin_bloqueado' else 'pin_incorrecto' end)
    || (v - 'estado');
end;
$$;

create function public.fijar_pin(p_nuevo text, p_actual text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_fallo jsonb;
begin
  if not (select private.es_dueno()) then
    raise exception 'Solo el dueño, con verificación en dos pasos, puede hacer esto.' using errcode = '42501';
  end if;
  if p_nuevo is null or p_nuevo !~ '^[0-9]{4,8}$' then
    raise exception 'El PIN debe tener entre 4 y 8 dígitos.';
  end if;
  if exists (select 1 from private.staff_pin where user_id = v_uid) then
    v_fallo := private.exigir_pin(p_actual, 'fijar_pin');
    if v_fallo is not null then return v_fallo; end if;
  end if;
  insert into private.staff_pin (user_id, pin_hash) values (v_uid, extensions.crypt(p_nuevo, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set pin_hash = excluded.pin_hash, intentos = 0, bloqueado_hasta = null, updated_at = now();
  perform private.auditar('fijar_pin', 'pin', v_uid::text);
  return jsonb_build_object('ok', true);
end;
$$;

-- =============================================================================================
-- 6. Acciones sensibles: dueño con segundo factor + PIN, siempre auditadas
-- =============================================================================================
-- Anular una venta pagada ahora exige PIN (reemplaza la versión sin PIN de H3).
drop function public.anular_venta(uuid, text);
create function public.anular_venta(p_venta uuid, p_motivo text, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v public.ventas;
  v_pts integer;
  v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'anular_venta');
  if v_fallo is not null then return v_fallo; end if;
  if p_motivo is null or length(btrim(p_motivo)) = 0 then raise exception 'Escribe el motivo de la anulación.'; end if;
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'pagada' then raise exception 'Solo se anula una venta pagada (estado actual: %).', v.estado; end if;

  update public.ventas
     set estado = 'anulada', anulada_en = now(), anulada_por = (select auth.uid()), motivo_anulacion = btrim(p_motivo)
   where id = p_venta;
  update public.qr_posventa set invalidado_en = now() where venta_id = p_venta and invalidado_en is null;
  perform private.liberar_vouchers(p_venta);

  select puntos into v_pts from public.puntos_libro where venta_id = p_venta and tipo = 'suma';
  if v_pts is not null then
    insert into public.puntos_libro (cliente_id, tipo, puntos, venta_id, regla_versiones, nota)
    select cliente_id, 'anulacion', -puntos, venta_id, regla_versiones, btrim(p_motivo)
      from public.puntos_libro where venta_id = p_venta and tipo = 'suma'
    on conflict (venta_id) where tipo = 'anulacion' do nothing;
  end if;

  perform private.evento(p_venta, 'pagada', 'anulada', btrim(p_motivo));
  perform private.auditar('anular_venta', 'venta', p_venta::text,
    jsonb_build_object('motivo', btrim(p_motivo), 'total_cop', v.total_cop, 'puntos_revertidos', coalesce(v_pts, 0)));
  return jsonb_build_object('ok', true, 'venta_id', p_venta, 'estado', 'anulada', 'puntos_revertidos', coalesce(v_pts, 0));
end;
$$;

-- Reasignar el cliente de una venta que aún no se paga (alistando o confirmada).
create function public.reasignar_cliente(p_venta uuid, p_cliente uuid, p_motivo text, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v public.ventas;
  v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'reasignar_cliente');
  if v_fallo is not null then return v_fallo; end if;
  if p_motivo is null or length(btrim(p_motivo)) = 0 then raise exception 'Escribe el motivo de la reasignación.'; end if;
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado not in ('alistando', 'confirmada') then
    raise exception 'Solo se reasigna el cliente de una venta sin pagar; si ya está pagada, anúlala y regístrala de nuevo.';
  end if;
  if not exists (select 1 from public.perfiles where user_id = p_cliente) then raise exception 'Ese cliente no existe.'; end if;
  if v.cliente_id is not distinct from p_cliente then raise exception 'La venta ya es de ese cliente.'; end if;
  if v.voucher_compra_id is not null or exists (select 1 from public.venta_lineas where venta_id = p_venta and voucher_id is not null) then
    raise exception 'Quita primero los premios aplicados: son del cliente anterior.';
  end if;
  update public.ventas set cliente_id = p_cliente where id = p_venta;
  perform private.otorgar_bienvenida(p_cliente);
  perform private.auditar('reasignar_cliente', 'venta', p_venta::text,
    jsonb_build_object('motivo', btrim(p_motivo), 'de', v.cliente_id, 'a', p_cliente));
  return jsonb_build_object('ok', true, 'venta_id', p_venta);
end;
$$;

-- Cambiar una regla de negocio: versión nueva con fecha de vigencia; la anterior se cierra.
create function public.cambiar_regla(p_clave text, p_valor jsonb, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.reglas_negocio;
  v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'cambiar_regla');
  if v_fallo is not null then return v_fallo; end if;
  select * into r from public.reglas_negocio where clave = p_clave and vigente_hasta is null for update;
  if not found then raise exception 'La regla "%" no existe.', p_clave; end if;
  if p_valor is null then raise exception 'Falta el valor de la regla.'; end if;
  if jsonb_typeof(r.valor) <> 'null' and jsonb_typeof(p_valor) <> 'null' and jsonb_typeof(r.valor) <> jsonb_typeof(p_valor) then
    raise exception 'El valor de "%" debe ser de tipo %.', p_clave, jsonb_typeof(r.valor);
  end if;
  if p_clave = 'puntos.cop_por_punto' and (jsonb_typeof(p_valor) <> 'number' or (p_valor #>> '{}')::numeric <= 0) then
    raise exception 'Los pesos por punto deben ser un número mayor que cero.';
  end if;
  update public.reglas_negocio set vigente_hasta = now() where id = r.id;
  insert into public.reglas_negocio (clave, version, valor, descripcion, publica, vigente_desde, creado_por)
  values (r.clave, r.version + 1, p_valor, r.descripcion, r.publica, now(), (select auth.uid()));
  perform private.auditar('cambiar_regla', 'regla', p_clave,
    jsonb_build_object('version', r.version + 1, 'anterior', r.valor, 'nuevo', p_valor));
  return jsonb_build_object('ok', true, 'clave', p_clave, 'version', r.version + 1);
end;
$$;

create function public.cambiar_bandera(p_clave text, p_activa boolean, p_desde timestamptz, p_hasta timestamptz, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  b public.banderas;
  v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'cambiar_bandera');
  if v_fallo is not null then return v_fallo; end if;
  if p_activa is null then raise exception 'Indica si la bandera queda activa.'; end if;
  select * into b from public.banderas where clave = p_clave for update;
  if not found then raise exception 'La bandera "%" no existe.', p_clave; end if;
  update public.banderas set activa = p_activa, desde = p_desde, hasta = p_hasta, updated_at = now() where clave = p_clave;
  perform private.auditar('cambiar_bandera', 'bandera', p_clave,
    jsonb_build_object('anterior', jsonb_build_object('activa', b.activa, 'desde', b.desde, 'hasta', b.hasta),
                       'nuevo', jsonb_build_object('activa', p_activa, 'desde', p_desde, 'hasta', p_hasta)));
  return jsonb_build_object('ok', true, 'clave', p_clave, 'activa', p_activa);
end;
$$;

-- Si el QR de entrada se filtra, el dueño lo rota: el anterior deja de servir al instante.
create function public.rotar_token_entrada(p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_fallo jsonb;
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  v_fallo := private.exigir_pin(p_pin, 'rotar_token_entrada');
  if v_fallo is not null then return v_fallo; end if;
  update public.punto_venta set token = v_token, rotado_en = now(), rotado_por = (select auth.uid()) where id = 1;
  perform private.auditar('rotar_token_entrada', 'punto_venta', '1');
  return jsonb_build_object('ok', true, 'token', v_token);
end;
$$;

-- Personal: cuentas individuales, nunca compartidas. La cuenta de acceso se crea en Auth; aquí se le da el rol.
create function public.registrar_personal(p_user uuid, p_rol text, p_nombre text, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'registrar_personal');
  if v_fallo is not null then return v_fallo; end if;
  if p_rol not in ('cajero', 'dueno') then raise exception 'Rol no válido.'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'Esa cuenta no existe.'; end if;
  insert into public.staff (user_id, rol, nombre) values (p_user, p_rol, btrim(p_nombre));
  perform private.auditar('registrar_personal', 'staff', p_user::text, jsonb_build_object('rol', p_rol));
  return jsonb_build_object('ok', true);
exception when unique_violation then
  raise exception 'Esa cuenta ya es parte del personal.';
end;
$$;

create function public.desactivar_personal(p_user uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'desactivar_personal');
  if v_fallo is not null then return v_fallo; end if;
  if p_user = (select auth.uid()) then raise exception 'No puedes desactivar tu propia cuenta.'; end if;
  update public.staff set activo = false where user_id = p_user and activo;
  if not found then raise exception 'Esa persona no está activa en el personal.'; end if;
  perform private.auditar('desactivar_personal', 'staff', p_user::text);
  return jsonb_build_object('ok', true);
end;
$$;

-- =============================================================================================
-- 7. Reglas nuevas y permisos de ejecución
-- =============================================================================================
insert into public.reglas_negocio (clave, version, valor, descripcion, publica) values
  ('pin.max_intentos',            1, '5'::jsonb,  'Intentos fallidos de PIN antes de bloquear.', false),
  ('pin.bloqueo_min',             1, '15'::jsonb, 'Minutos de bloqueo tras agotar los intentos de PIN.', false),
  ('privacidad.version',          1, '"2026-11-v1"'::jsonb, 'Versión vigente de la política de privacidad y del consentimiento de datos (Ley 1581).', true),
  ('antifraude.max_checkins_dia', 1, '10'::jsonb, 'Máximo de llegadas (check-ins) por cliente por día, hora de Bogotá.', false);

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'private'::regnamespace
             and p.proname not in ('es_staff', 'es_dueno', 'es_cajero', 'bloquear_mutacion') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
