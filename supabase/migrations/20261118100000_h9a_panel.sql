-- H9a: panel del dueño (operación). Solo funciones de lectura y registro para el dueño; las decisiones sensibles
-- siguen en las funciones de H4, H6 y H8 (restringir_pedidos_web, emitir/revocar_dispositivo, resolver_alerta).
-- Todo exige rol de dueño con segundo factor (aal2) y, donde cambia algo importante, el PIN.

-- =============================================================================================
-- 1. Alertas legibles: con el cliente (nombre y correo, solo para el dueño) y, si se pide, las ya resueltas
-- =============================================================================================
drop function public.lista_alertas();
create function public.lista_alertas(p_resueltas boolean default false) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  return coalesce((
    select jsonb_agg(x.j order by x.orden)
    from (
      select jsonb_build_object(
               'id', a.id, 'tipo', a.tipo, 'venta_id', a.venta_id, 'detalle', a.detalle, 'creada_en', a.creada_en,
               'cliente_id', a.cliente_id,
               'cliente', case when a.cliente_id is null then null
                               else jsonb_build_object('nombre', p.nombre, 'correo', u.email) end,
               'resuelta_en', a.resuelta_en, 'nota', a.nota) as j,
             case when p_resueltas then -extract(epoch from a.resuelta_en) else extract(epoch from a.creada_en) end as orden
        from public.alertas a
        left join public.perfiles p on p.user_id = a.cliente_id
        left join auth.users u on u.id = a.cliente_id
       where (a.resuelta_en is not null) = coalesce(p_resueltas, false)
       order by 2
       limit case when coalesce(p_resueltas, false) then 50 else 500 end) x), '[]'::jsonb);
end;
$$;

-- =============================================================================================
-- 2. Cuentas con restricción para pedidos web (prepago o bloqueo), con cuántas veces no llegaron
-- =============================================================================================
create function public.cuentas_restringidas() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'cliente_id', c.cliente_id, 'nombre', p.nombre, 'correo', u.email, 'modo', c.modo, 'motivo', c.motivo,
             'fijada_en', c.fijada_en,
             'no_llego', (select count(*) from public.pedidos_web w where w.cliente_id = c.cliente_id and w.estado = 'no_llego'))
           order by c.fijada_en desc)
      from public.cuentas_pedidos_web c
      left join public.perfiles p on p.user_id = c.cliente_id
      left join auth.users u on u.id = c.cliente_id), '[]'::jsonb);
end;
$$;

-- =============================================================================================
-- 3. Conciliación de Bold: cada corrida deja una fila (aunque no haya nada que revisar) para ver que el cron vive
-- =============================================================================================
create table public.bold_conciliaciones (
  id         bigint generated always as identity primary key,
  corrida_en timestamptz not null default now(),
  revisados  integer not null check (revisados >= 0),
  resumen    jsonb not null default '{}'::jsonb      -- conteo por resultado, sin referencias ni datos de personas
);
alter table public.bold_conciliaciones enable row level security;
revoke all on public.bold_conciliaciones from anon, authenticated;
-- Sin políticas: el dueño la ve por pagos_bold_resumen().

create function public.registrar_conciliacion_bold(p_revisados integer, p_resumen jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.bold_conciliaciones (revisados, resumen) values (greatest(coalesce(p_revisados, 0), 0), coalesce(p_resumen, '{}'::jsonb));
  delete from public.bold_conciliaciones where corrida_en < now() - interval '30 days';
end;
$$;
revoke all on function public.registrar_conciliacion_bold(integer, jsonb) from public, anon, authenticated;
grant execute on function public.registrar_conciliacion_bold(integer, jsonb) to service_role;

-- =============================================================================================
-- 4. Pagos Bold para el dueño: pendientes, devoluciones por resolver (alertas pago_bold abiertas), recientes y última corrida
-- =============================================================================================
create function public.pagos_bold_resumen() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  return jsonb_build_object(
    'activo', private.bandera_activa('pago_en_linea_bold'),
    'pendientes', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', g.order_id, 'pedido', w.numero, 'monto_cop', g.monto_cop, 'creado_en', g.creado_en,
               'cliente', p.nombre) order by g.creado_en)
        from public.pagos_bold g
        join public.pedidos_web w on w.id = g.pedido_id
        left join public.perfiles p on p.user_id = w.cliente_id
       where g.estado = 'pendiente' and g.creado_en > now() - interval '48 hours'), '[]'::jsonb),
    'devoluciones', coalesce((
      select jsonb_agg(jsonb_build_object(
               'alerta_id', a.id, 'creada_en', a.creada_en, 'motivo', a.detalle ->> 'motivo', 'pedido', a.detalle -> 'pedido',
               'order_id', a.detalle ->> 'order_id', 'cliente', p.nombre, 'correo', u.email,
               'monto_cop', coalesce(g.monto_cop, nullif(a.detalle ->> 'monto', '')::integer), 'bold_payment_id', g.bold_payment_id,
               'detalle', a.detalle) order by a.creada_en)
        from public.alertas a
        left join public.pagos_bold g on g.order_id = a.detalle ->> 'order_id'
        left join public.perfiles p on p.user_id = a.cliente_id
        left join auth.users u on u.id = a.cliente_id
       where a.tipo = 'pago_bold' and a.resuelta_en is null), '[]'::jsonb),
    'recientes', coalesce((
      select jsonb_agg(x.j order by x.creado_en desc)
        from (select g.creado_en,
                     jsonb_build_object('order_id', g.order_id, 'pedido', w.numero, 'monto_cop', g.monto_cop, 'estado', g.estado,
                       'medio', g.medio, 'creado_en', g.creado_en, 'confirmado_en', g.confirmado_en) as j
                from public.pagos_bold g join public.pedidos_web w on w.id = g.pedido_id
               order by g.creado_en desc limit 15) x), '[]'::jsonb),
    'ultima_conciliacion', (select jsonb_build_object('corrida_en', c.corrida_en, 'revisados', c.revisados, 'resumen', c.resumen)
                              from public.bold_conciliaciones c order by c.id desc limit 1));
end;
$$;

-- =============================================================================================
-- 5. Auditoría reciente (solo lectura, para el dueño)
-- =============================================================================================
create function public.auditoria_reciente(p_limite integer default 50) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'en', x.en, 'accion', x.accion, 'entidad', x.entidad, 'entidad_id', x.entidad_id,
             'actor', coalesce(s.nombre, p.nombre), 'detalle', x.detalle) order by x.en desc, x.id desc)
      from (select * from public.auditoria order by en desc, id desc limit least(greatest(coalesce(p_limite, 50), 1), 200)) x
      left join public.staff s on s.user_id = x.actor
      left join public.perfiles p on p.user_id = x.actor), '[]'::jsonb);
end;
$$;

-- =============================================================================================
-- 6. Permisos de las funciones nuevas: solo usuarios con sesión (y dentro, solo el dueño aal2)
-- =============================================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.lista_alertas(boolean)', 'public.cuentas_restringidas()', 'public.pagos_bold_resumen()', 'public.auditoria_reciente(integer)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- =============================================================================================
-- 7. Programar bold-conciliar (pg_cron + pg_net). La URL y el token viven en el Vault, nunca en el repositorio.
-- No se programa sola: el dueño técnico la corre una vez por entorno (ver docs/naidi/DECISIONES.md).
-- =============================================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

create function private.programar_conciliacion_bold(p_url text, p_token text, p_minutos integer default 10) returns text
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if p_url is null or p_url !~ '^(https://|http://host\.docker\.internal)' then
    raise exception 'La URL de la función debe empezar por https:// (solo en local se admite http://host.docker.internal).';
  end if;
  if p_token is null or length(p_token) < 24 then raise exception 'El token de conciliación debe tener al menos 24 caracteres.'; end if;
  if p_minutos is null or p_minutos not between 1 and 59 then raise exception 'Los minutos deben estar entre 1 y 59.'; end if;

  select id into v_id from vault.secrets where name = 'bold_conciliar_url';
  if found then perform vault.update_secret(v_id, p_url); else perform vault.create_secret(p_url, 'bold_conciliar_url'); end if;
  select id into v_id from vault.secrets where name = 'bold_conciliar_token';
  if found then perform vault.update_secret(v_id, p_token); else perform vault.create_secret(p_token, 'bold_conciliar_token'); end if;

  if exists (select 1 from cron.job where jobname = 'bold-conciliar') then perform cron.unschedule('bold-conciliar'); end if;
  perform cron.schedule('bold-conciliar', '*/' || p_minutos || ' * * * *', $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'bold_conciliar_url'),
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-conciliacion-token', (select decrypted_secret from vault.decrypted_secrets where name = 'bold_conciliar_token')),
      body := '{}'::jsonb,
      timeout_milliseconds := 20000);
  $cmd$);
  return 'bold-conciliar programada cada ' || p_minutos || ' min';
end;
$$;
revoke all on function private.programar_conciliacion_bold(text, text, integer) from public, anon, authenticated, service_role;

create function private.desprogramar_conciliacion_bold() returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from cron.job where jobname = 'bold-conciliar') then
    perform cron.unschedule('bold-conciliar');
    return 'bold-conciliar desprogramada';
  end if;
  return 'bold-conciliar no estaba programada';
end;
$$;
revoke all on function private.desprogramar_conciliacion_bold() from public, anon, authenticated, service_role;
