-- H9a: panel del dueño. Quién puede leer qué, alertas legibles, cuentas restringidas, pagos Bold, auditoría y la programación
-- de bold-conciliar. Las pruebas no suponen una base vacía: filtran por sus propios identificadores.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000011c1', 'authenticated', 'authenticated', 'ana11@prueba.test',  '{"full_name":"Ana María Torres Gil"}'),
  ('00000000-0000-0000-0000-0000000011c2', 'authenticated', 'authenticated', 'beto11@prueba.test', '{"full_name":"Beto Ruiz"}'),
  ('00000000-0000-0000-0000-0000000011ca', 'authenticated', 'authenticated', 'cajero11@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000011d0', 'authenticated', 'authenticated', 'dueno11@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000011ca', 'cajero', 'Cajero Once'),
  ('00000000-0000-0000-0000-0000000011d0', 'dueno',  'Dueño Once');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;
create function pg_temp.regla(p_clave text, p_valor jsonb) returns void language plpgsql as $$
declare r public.reglas_negocio;
begin
  select * into r from public.reglas_negocio where clave = p_clave and vigente_hasta is null;
  update public.reglas_negocio set vigente_hasta = now() where id = r.id;
  insert into public.reglas_negocio (clave, version, valor, descripcion, publica, vigente_desde)
  values (r.clave, r.version + 1, p_valor, r.descripcion, r.publica, now());
end $$;
create function pg_temp.manana(p_hora time) returns timestamptz language sql as $$
  select ((now() at time zone 'America/Bogota')::date + 1 + p_hora) at time zone 'America/Bogota' $$;
create function pg_temp.evento(p_id text, p_tipo text, p_order text, p_monto integer, p_moneda text default 'COP', p_pago text default 'bp-11') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role service_role;
  select public.aplicar_evento_bold(p_id, p_tipo, p_order, p_pago, p_monto, p_moneda, 'CARD', '{}'::jsonb) into r;
  reset role;
  return r;
end $$;
-- Cuántas alertas de la lista (abiertas o resueltas) cumplen una condición sobre el cliente indicado.
create function pg_temp.de_cliente(p_resueltas boolean, p_cliente text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(public.lista_alertas(p_resueltas)) e where e ->> 'cliente_id' = p_cliente $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Permisos: solo el dueño con segundo factor
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000011ca');
select throws_ok($$select public.lista_alertas()$$,        '42501', null, 'el cajero no lee las alertas');
select throws_ok($$select public.cuentas_restringidas()$$, '42501', null, 'ni las cuentas restringidas');
select throws_ok($$select public.pagos_bold_resumen()$$,   '42501', null, 'ni los pagos de Bold');
select throws_ok($$select public.auditoria_reciente()$$,   '42501', null, 'ni la auditoría');
select pg_temp.como('00000000-0000-0000-0000-0000000011c1');
select throws_ok($$select public.lista_alertas(true)$$,    '42501', null, 'un cliente tampoco');
select throws_ok($$select public.pagos_bold_resumen()$$,   '42501', null, 'ni los pagos de Bold');
select pg_temp.como('00000000-0000-0000-0000-0000000011d0', 'aal1');
select throws_ok($$select public.lista_alertas()$$,        '42501', null, 'el dueño sin segundo factor no ve las alertas');
select throws_ok($$select public.auditoria_reciente()$$,   '42501', null, 'ni la auditoría');
select ok(not has_function_privilege('anon', 'public.lista_alertas(boolean)', 'execute'), 'anon no ejecuta lista_alertas');
select ok(not has_function_privilege('anon', 'public.pagos_bold_resumen()', 'execute'), 'ni pagos_bold_resumen');
select ok(not has_function_privilege('anon', 'public.cuentas_restringidas()', 'execute'), 'ni cuentas_restringidas');
select ok(not has_function_privilege('anon', 'public.auditoria_reciente(integer)', 'execute'), 'ni auditoria_reciente');
select ok(not has_function_privilege('authenticated', 'public.registrar_conciliacion_bold(integer, jsonb)', 'execute'), 'una sesión de usuario no registra conciliaciones');
select ok(has_function_privilege('service_role', 'public.registrar_conciliacion_bold(integer, jsonb)', 'execute'), 'solo la service_role de la Edge Function');
set local role authenticated;
select throws_ok($$select * from public.bold_conciliaciones$$, '42501', null, 'la tabla de conciliaciones no se lee directo');
reset role;

-- ---------------------------------------------------------------------------------------------
-- 2. Alertas legibles
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000011d0');
select is(public.fijar_pin('4321') ->> 'ok', 'true', 'el dueño fija su PIN');
reset role;
insert into public.alertas (tipo, cliente_id, detalle) values
  ('no_llego', '00000000-0000-0000-0000-0000000011c1', '{"pedidos_no_llego":3,"ultimo_numero":7}'),
  ('compras_inusuales', '00000000-0000-0000-0000-0000000011c2', '{"ventas":9}');
insert into ids select 'a_c2', (id::text) from public.alertas where tipo = 'compras_inusuales' and cliente_id = '00000000-0000-0000-0000-0000000011c2';

select pg_temp.como('00000000-0000-0000-0000-0000000011d0');
select is(jsonb_array_length(pg_temp.de_cliente(false, '00000000-0000-0000-0000-0000000011c1')), 1, 'el dueño ve la alerta abierta de la cuenta');
select is(pg_temp.de_cliente(false, '00000000-0000-0000-0000-0000000011c1') -> 0 -> 'cliente' ->> 'nombre', 'Ana María Torres Gil', 'con el nombre completo de la cuenta');
select is(pg_temp.de_cliente(false, '00000000-0000-0000-0000-0000000011c1') -> 0 -> 'cliente' ->> 'correo', 'ana11@prueba.test', 'y su correo');
select is(pg_temp.de_cliente(false, '00000000-0000-0000-0000-0000000011c1') -> 0 -> 'detalle' ->> 'pedidos_no_llego', '3', 'y el detalle de la alerta');
select ok(public.lista_alertas() = public.lista_alertas(false), 'sin argumentos sigue devolviendo las abiertas (compatible con el POS)');
select is(jsonb_array_length(pg_temp.de_cliente(true, '00000000-0000-0000-0000-0000000011c1')), 0, 'una abierta no sale entre las resueltas');
select lives_ok(format($f$select public.resolver_alerta(%L, 'Hablé con la cliente')$f$, (select v::bigint from ids where k = 'a_c2')), 'el dueño resuelve una alerta con nota');
select is(jsonb_array_length(pg_temp.de_cliente(false, '00000000-0000-0000-0000-0000000011c2')), 0, 'ya no está entre las abiertas');
select is(pg_temp.de_cliente(true, '00000000-0000-0000-0000-0000000011c2') -> 0 ->> 'nota', 'Hablé con la cliente', 'y aparece resuelta con su nota');
select ok((pg_temp.de_cliente(true, '00000000-0000-0000-0000-0000000011c2') -> 0 ->> 'resuelta_en') is not null, 'y con la fecha en que se resolvió');

-- ---------------------------------------------------------------------------------------------
-- 3. Cuentas "No llegó": restringir y quitar la restricción
-- ---------------------------------------------------------------------------------------------
select is(public.restringir_pedidos_web('00000000-0000-0000-0000-0000000011c1', 'prepago', 'No llegó tres veces', '0000') ->> 'error', 'pin_incorrecto', 'con un PIN incorrecto no se restringe');
select is((select count(*) from public.cuentas_pedidos_web where cliente_id = '00000000-0000-0000-0000-0000000011c1'), 0::bigint, 'y no queda restricción');
select is(public.restringir_pedidos_web('00000000-0000-0000-0000-0000000011c1', 'prepago', 'No llegó tres veces', '4321') ->> 'ok', 'true', 'con el PIN correcto queda en prepago');
select is((select e ->> 'modo' from jsonb_array_elements(public.cuentas_restringidas()) e where e ->> 'cliente_id' = '00000000-0000-0000-0000-0000000011c1'), 'prepago', 'la lista de cuentas restringidas la muestra');
select is((select e ->> 'nombre' from jsonb_array_elements(public.cuentas_restringidas()) e where e ->> 'cliente_id' = '00000000-0000-0000-0000-0000000011c1'), 'Ana María Torres Gil', 'con su nombre');
select is((select e ->> 'motivo' from jsonb_array_elements(public.cuentas_restringidas()) e where e ->> 'cliente_id' = '00000000-0000-0000-0000-0000000011c1'), 'No llegó tres veces', 'y el motivo');
select is(jsonb_array_length(pg_temp.de_cliente(false, '00000000-0000-0000-0000-0000000011c1')), 0, 'la decisión resolvió la alerta');
select is(pg_temp.de_cliente(true, '00000000-0000-0000-0000-0000000011c1') -> 0 ->> 'nota', 'Decisión: prepago', 'y dejó su nota');
select is(public.restringir_pedidos_web('00000000-0000-0000-0000-0000000011c1', null, null, '4321') ->> 'ok', 'true', 'el dueño quita la restricción');
select is((select count(*) from jsonb_array_elements(public.cuentas_restringidas()) e where e ->> 'cliente_id' = '00000000-0000-0000-0000-0000000011c1'), 0::bigint, 'y la cuenta sale de la lista');

-- ---------------------------------------------------------------------------------------------
-- 4. Pagos Bold: pendientes, devoluciones por resolver, recientes y última corrida
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.regla('pedido_web.ventana', '{"min_anticipacion_min":20,"max_anticipacion_horas":72,"max_duracion_min":60}'::jsonb);
select pg_temp.regla('pedido_web.pagos', '{"al_recoger":true,"en_linea":true}'::jsonb);
update public.banderas set activa = true where clave in ('pedidos_web', 'pago_en_linea_bold');
update public.pedidos_web_interruptor set abierta = true where id = 1;
select pg_temp.como('00000000-0000-0000-0000-0000000011c1');
select public.registrar_consentimiento('datos', (private.regla_vigente('privacidad.version') #>> '{}'), true);
insert into ids select 'p1', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('11:00'), pg_temp.manana('11:30'), 'en_linea') ->> 'id');
insert into ids select 'o1', public.iniciar_pago_pedido_web(pg_temp.id('p1')) ->> 'order_id';

select pg_temp.como('00000000-0000-0000-0000-0000000011d0');
select is((select e ->> 'cliente' from jsonb_array_elements(public.pagos_bold_resumen() -> 'pendientes') e where e ->> 'order_id' = (select v from ids where k = 'o1')),
          'Ana María Torres Gil', 'el intento pendiente aparece con su cliente');
select is((select (e ->> 'monto_cop')::integer from jsonb_array_elements(public.pagos_bold_resumen() -> 'pendientes') e where e ->> 'order_id' = (select v from ids where k = 'o1')),
          4000, 'y con el monto del pedido');
select is((public.pagos_bold_resumen() ->> 'activo')::boolean, true, 'el resumen dice si el pago en línea está encendido');

-- Un monto distinto no se acredita y deja una devolución por resolver
select is(pg_temp.evento('e1', 'SALE_APPROVED', (select v from ids where k = 'o1'), 3000) ->> 'resultado', 'monto_distinto', 'un monto distinto no se acredita');
select is((select e ->> 'motivo' from jsonb_array_elements(public.pagos_bold_resumen() -> 'devoluciones') e where e ->> 'order_id' = (select v from ids where k = 'o1')),
          'monto_distinto', 'queda una devolución por revisar con su motivo');
select is((select (e ->> 'monto_cop')::integer from jsonb_array_elements(public.pagos_bold_resumen() -> 'devoluciones') e where e ->> 'order_id' = (select v from ids where k = 'o1')),
          4000, 'con el monto esperado del intento');
select is((select e ->> 'correo' from jsonb_array_elements(public.pagos_bold_resumen() -> 'devoluciones') e where e ->> 'order_id' = (select v from ids where k = 'o1')),
          'ana11@prueba.test', 'y el correo de la persona para contactarla');
select lives_ok(format($f$select public.resolver_alerta(%L, 'Devolución hecha en el panel de Bold')$f$,
                (select (e ->> 'alerta_id')::bigint from jsonb_array_elements(public.pagos_bold_resumen() -> 'devoluciones') e where e ->> 'order_id' = (select v from ids where k = 'o1'))),
          'el dueño la marca como resuelta con una nota');
select is((select count(*) from jsonb_array_elements(public.pagos_bold_resumen() -> 'devoluciones') e where e ->> 'order_id' = (select v from ids where k = 'o1')), 0::bigint, 'y sale de las devoluciones por resolver');
select is(pg_temp.evento('e2', 'SALE_APPROVED', (select v from ids where k = 'o1'), 4000) ->> 'resultado', 'aprobado', 'la aprobación correcta marca el pago');
select is((select e ->> 'estado' from jsonb_array_elements(public.pagos_bold_resumen() -> 'recientes') e where e ->> 'order_id' = (select v from ids where k = 'o1')), 'aprobado', 'aparece entre los recientes como aprobado');
select is((select count(*) from jsonb_array_elements(public.pagos_bold_resumen() -> 'pendientes') e where e ->> 'order_id' = (select v from ids where k = 'o1')), 0::bigint, 'y ya no está pendiente');

-- Conciliación: cada corrida queda registrada, aun sin nada que revisar
reset role;
set local role service_role;
select lives_ok($$select public.registrar_conciliacion_bold(0, '{}'::jsonb)$$, 'la service_role registra una corrida sin pendientes');
select lives_ok($$select public.registrar_conciliacion_bold(2, '{"aprobado":1,"sin_cambio":1}'::jsonb)$$, 'y otra con resultados');
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000011d0');
select is((public.pagos_bold_resumen() -> 'ultima_conciliacion' ->> 'revisados')::integer, 2, 'el dueño ve la última corrida');
select is(public.pagos_bold_resumen() -> 'ultima_conciliacion' -> 'resumen' ->> 'aprobado', '1', 'con su resumen por resultado');

-- ---------------------------------------------------------------------------------------------
-- 5. Auditoría reciente
-- ---------------------------------------------------------------------------------------------
select ok(exists (select 1 from jsonb_array_elements(public.auditoria_reciente(200)) e where e ->> 'accion' = 'restringir_pedidos_web' and e ->> 'actor' = 'Dueño Once'),
          'la auditoría muestra la decisión del dueño con su nombre');
select is(jsonb_array_length(public.auditoria_reciente(1)), 1, 'el límite se respeta');
select ok(jsonb_array_length(public.auditoria_reciente(100000)) <= 200, 'y nunca pasa de 200');

-- ---------------------------------------------------------------------------------------------
-- 6. Programar bold-conciliar
-- ---------------------------------------------------------------------------------------------
reset role;
select ok(not has_function_privilege('authenticated', 'private.programar_conciliacion_bold(text, text, integer)', 'execute'), 'un usuario no programa la conciliación');
select ok(not has_function_privilege('service_role', 'private.programar_conciliacion_bold(text, text, integer)', 'execute'), 'ni la service_role: la corre quien administra la base');
select throws_like($$select private.programar_conciliacion_bold('http://malo.example.com/bold-conciliar', 'un-token-largo-de-prueba-123456', 10)$$, '%https://%', 'no admite una URL sin https');
select throws_like($$select private.programar_conciliacion_bold('https://x.supabase.co/functions/v1/bold-conciliar', 'corto', 10)$$, '%token%', 'ni un token corto');
select throws_like($$select private.programar_conciliacion_bold('https://x.supabase.co/functions/v1/bold-conciliar', 'un-token-largo-de-prueba-123456', 0)$$, '%minutos%', 'ni minutos fuera de rango');
select is(private.programar_conciliacion_bold('https://x.supabase.co/functions/v1/bold-conciliar', 'un-token-largo-de-prueba-123456', 10), 'bold-conciliar programada cada 10 min', 'programa la conciliación');
select is((select schedule from cron.job where jobname = 'bold-conciliar'), '*/10 * * * *', 'cada diez minutos');
select is((select count(*) from cron.job where jobname = 'bold-conciliar'), 1::bigint, 'con una sola tarea');
select ok((select command from cron.job where jobname = 'bold-conciliar') not like '%un-token-largo%' and (select command from cron.job where jobname = 'bold-conciliar') not like '%x.supabase.co%', 'ni el token ni la URL quedan en la tarea: están en el Vault');
select is((select decrypted_secret from vault.decrypted_secrets where name = 'bold_conciliar_token'), 'un-token-largo-de-prueba-123456', 'el token está en el Vault');
select is(private.programar_conciliacion_bold('https://x.supabase.co/functions/v1/bold-conciliar', 'otro-token-largo-de-prueba-9876', 5), 'bold-conciliar programada cada 5 min', 'se puede reprogramar');
select is((select count(*) from cron.job where jobname = 'bold-conciliar'), 1::bigint, 'sin duplicar la tarea');
select is((select count(*) from vault.secrets where name in ('bold_conciliar_url', 'bold_conciliar_token')), 2::bigint, 'ni los secretos');
select is(private.desprogramar_conciliacion_bold(), 'bold-conciliar desprogramada', 'se puede desprogramar');
select is((select count(*) from cron.job where jobname = 'bold-conciliar'), 0::bigint, 'y la tarea desaparece');

select * from finish();
rollback;
