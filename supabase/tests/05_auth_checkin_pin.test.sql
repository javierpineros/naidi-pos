-- H4: perfil automático, consentimientos, check-in con QR de entrada, PIN del dueño, segundo factor (aal2)
-- y acciones sensibles. Cada rol intenta lo que no debe poder hacer.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ----------------------------------------------------------------------------------------------
-- Cuentas de prueba. Los perfiles de clientes los crea el trigger al insertarse en auth.users.
-- ----------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000005e1', 'authenticated', 'authenticated', 'maria@prueba.test',
     '{"full_name":"María Fernanda López Pérez","avatar_url":"https://fotos.prueba.test/maria.jpg"}'),
  ('00000000-0000-0000-0000-0000000005e2', 'authenticated', 'authenticated', 'juan.perez@prueba.test', '{"picture":"http://inseguro.test/x.jpg"}'),
  ('00000000-0000-0000-0000-0000000005ca', 'authenticated', 'authenticated', 'cajero5@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000005d0', 'authenticated', 'authenticated', 'dueno5@prueba.test', '{}'),
  ('00000000-0000-0000-0000-000000000999', 'authenticated', 'authenticated', 'nuevo@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000005ca', 'cajero', 'Cajero Cinco'),
  ('00000000-0000-0000-0000-0000000005d0', 'dueno',  'Dueño Cinco');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.ckid(p_k text) returns uuid language sql as $$ select (v::jsonb ->> 'checkin_id')::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;
create function pg_temp.fijar_regla(p_clave text, p_valor jsonb) returns void language plpgsql as $$
begin
  alter table public.reglas_negocio disable trigger reglas_solo_cerrar;
  update public.reglas_negocio set valor = p_valor where clave = p_clave and vigente_hasta is null;
  alter table public.reglas_negocio enable trigger reglas_solo_cerrar;
end $$;
create temp table r (k text primary key, n bigint, s text);
grant all on r to public;
create function pg_temp.contar(p_k text, p_q text) returns void language plpgsql as $$
declare v bigint;
begin execute p_q into v; insert into r (k, n) values (p_k, v); end $$;
create function pg_temp.intentar(p_k text, p_q text) returns void language plpgsql as $$
begin execute p_q; insert into r (k, s) values (p_k, 'ok');
exception when others then insert into r (k, s) values (p_k, sqlstate); end $$;

-- =============================================================================================
-- 1. Perfil automático al crearse la cuenta
-- =============================================================================================
select is((select nombre from public.perfiles where user_id = '00000000-0000-0000-0000-0000000005e1'), 'María Fernanda López Pérez', 'perfil creado con el nombre de Google');
select is((select foto_url from public.perfiles where user_id = '00000000-0000-0000-0000-0000000005e1'), 'https://fotos.prueba.test/maria.jpg', 'y su foto (https)');
select is((select nombre from public.perfiles where user_id = '00000000-0000-0000-0000-0000000005e2'), 'Juan Perez', 'sin nombre de Google se deriva del correo');
select is((select foto_url from public.perfiles where user_id = '00000000-0000-0000-0000-0000000005e2'), null, 'una foto que no es https se descarta');

-- =============================================================================================
-- 2. Check-in: consentimiento, QR de entrada, un solo check-in activo, vencimiento
-- =============================================================================================
select set_config('app.token', (select token from public.punto_venta where id = 1), true);
select pg_temp.como('00000000-0000-0000-0000-0000000005e1');
select throws_like(format($f$select public.hacer_checkin(%L)$f$, current_setting('app.token')), '%consentimiento_requerido%', 'sin consentimiento de datos no hay check-in');
select throws_ok($$select public.registrar_consentimiento('datos', 'version-vieja', true)$$, 'P0001', null, 'el consentimiento debe ser de la política vigente');
select lives_ok($$select public.registrar_consentimiento('datos', '2026-11-v1', false)$$, 'se puede rechazar');
select throws_like(format($f$select public.hacer_checkin(%L)$f$, current_setting('app.token')), '%consentimiento_requerido%', 'rechazar los datos tampoco permite el check-in');
select lives_ok($$select public.registrar_consentimiento('datos', '2026-11-v1', true)$$, 'acepta el tratamiento de datos');
select lives_ok($$select public.registrar_consentimiento('mensajes', '2026-11-v1', false)$$, 'el consentimiento de mensajes es independiente');
select throws_ok($$select public.hacer_checkin('token-equivocado')$$, 'P0001', null, 'un QR de entrada equivocado no sirve');
select throws_ok($$select public.hacer_checkin(null)$$, 'P0001', null, 'ni uno vacío');

insert into ids select 'ck1', public.hacer_checkin(current_setting('app.token'))::text;
select is((select (v::jsonb ->> 'cliente_nuevo')::boolean from ids where k = 'ck1'), true, 'primera llegada: cliente nuevo');
select is((select (v::jsonb ->> 'ya_estaba')::boolean from ids where k = 'ck1'), false, 'check-in nuevo');
select is((select count(*) from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000005e1' and tipo = 'bienvenida'), 1::bigint,
  'el regalo de bienvenida queda listo al llegar');
insert into ids select 'ck1b', public.hacer_checkin(current_setting('app.token'))::text;
select is((select v::jsonb ->> 'checkin_id' from ids where k = 'ck1b'), (select v::jsonb ->> 'checkin_id' from ids where k = 'ck1'), 'escanear otra vez devuelve el mismo check-in');
select is((select (v::jsonb ->> 'ya_estaba')::boolean from ids where k = 'ck1b'), true, 'marcado como ya registrado');
select is((select count(*) from public.checkins where cliente_id = '00000000-0000-0000-0000-0000000005e1' and estado = 'activo'), 1::bigint, 'un solo check-in activo por cuenta');
select ok((public.mi_checkin() ->> 'checkin_id') is not null, 'el cliente ve su check-in');
select throws_ok(format($f$insert into public.checkins (cliente_id, vence_en) values ('00000000-0000-0000-0000-0000000005e1', now() + interval '1 hour')$f$),
  '23505', null, 'la base impide dos check-ins activos de la misma cuenta');
select ok((select vence_en - llegada_en from public.checkins where id = pg_temp.ckid('ck1')) = interval '30 minutes', 'vence a los 30 minutos');

-- Lista de espera para el POS
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
select is(jsonb_array_length(public.lista_espera()), 1, 'el cajero ve a 1 cliente en espera');
select is(public.lista_espera() -> 0 ->> 'nombre_pila', 'María', 'solo nombre de pila');
select is(public.lista_espera() -> 0 ->> 'inicial', 'P', 'y la inicial del apellido');
select ok(not (public.lista_espera() -> 0) ? 'nombre' and not (public.lista_espera() -> 0) ? 'email' and not (public.lista_espera() -> 0) ? 'celular',
  'la lista no expone nombre completo, correo ni celular');
select is((public.lista_espera() -> 0 ->> 'alerta_pendiente')::boolean, true, 'cliente nuevo: alerta pendiente (sonido y resalte)');
select is((public.lista_espera() -> 0 ->> 'regalo_bienvenida')::boolean, true, 'se ve que tiene regalo de bienvenida');
select is(public.lista_espera() -> 0 ->> 'foto_url', 'https://fotos.prueba.test/maria.jpg', 'foto');
select public.marcar_alerta_vista(pg_temp.ckid('ck1'));
select is((public.lista_espera() -> 0 ->> 'alerta_pendiente')::boolean, false, 'la alerta queda marcada como vista');

-- Vencimiento
update public.checkins set vence_en = now() - interval '1 minute' where id = pg_temp.ckid('ck1');
select is(jsonb_array_length(public.lista_espera()), 0, 'un check-in vencido sale de la lista');
select pg_temp.como('00000000-0000-0000-0000-0000000005e1');
select is(public.mi_checkin(), null::jsonb, 'y el cliente ya no lo tiene activo');
insert into ids select 'ck2', public.hacer_checkin(current_setting('app.token'))::text;
select is((select v::jsonb ->> 'ya_estaba' from ids where k = 'ck2'), 'false', 'al volver a escanear se crea uno nuevo');
select is((select estado from public.checkins where id = pg_temp.ckid('ck1')), 'vencido', 'el anterior queda vencido');
select is((select (v::jsonb ->> 'cliente_nuevo')::boolean from ids where k = 'ck2'), false, 'ya no es cliente nuevo');
select is((select count(*) from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000005e1' and tipo = 'bienvenida'), 1::bigint, 'el regalo no se repite');

-- "Ya se fue"
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
select public.marcar_se_fue(pg_temp.ckid('ck2'));
select is((select estado from public.checkins where id = pg_temp.ckid('ck2')), 'se_fue', 'el vendedor marca "ya se fue"');
select is(jsonb_array_length(public.lista_espera()), 0, 'y sale de la lista');

-- Tope diario de llegadas
select pg_temp.fijar_regla('antifraude.max_checkins_dia', '2'::jsonb);
select pg_temp.como('00000000-0000-0000-0000-0000000005e1');
select throws_like(format($f$select public.hacer_checkin(%L)$f$, current_setting('app.token')), '%varias llegadas%', 'tope diario de llegadas por cliente');
select pg_temp.fijar_regla('antifraude.max_checkins_dia', '10'::jsonb);

-- Al asignar el cliente a una venta, el check-in pasa a atendido
insert into ids select 'ck3', public.hacer_checkin(current_setting('app.token'))::text;
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
insert into ids select 'v1', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000005e1')::text;
select is((select estado from public.checkins where id = (select (v::jsonb ->> 'checkin_id')::uuid from ids where k = 'ck3')), 'atendido', 'crear la venta con el cliente cierra su check-in');

select pg_temp.como('00000000-0000-0000-0000-0000000005e2');
select public.registrar_consentimiento('datos', '2026-11-v1', true);
insert into ids select 'ck4', public.hacer_checkin(current_setting('app.token'))::text;
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
insert into ids select 'v2', public.crear_venta(gen_random_uuid())::text;
select is((select estado from public.checkins where id = (select (v::jsonb ->> 'checkin_id')::uuid from ids where k = 'ck4')), 'activo', 'una venta sin cliente no cierra check-ins');
select public.asignar_cliente(pg_temp.id('v2'), '00000000-0000-0000-0000-0000000005e2');
select is((select estado from public.checkins where id = (select (v::jsonb ->> 'checkin_id')::uuid from ids where k = 'ck4')), 'atendido', 'asignar el cliente lo deja atendido');

-- =============================================================================================
-- 3. Segundo factor: sin aal2 el dueño no tiene permisos de dueño ni de personal
-- =============================================================================================
select pg_temp.como('00000000-0000-0000-0000-0000000005d0', 'aal1');
select is(private.es_dueno(), false, 'dueño con solo contraseña/código (aal1): no es dueño');
select is(private.es_staff(), false, 'ni cuenta como personal');
select throws_ok($$select public.lista_espera()$$, '42501', null, 'dueño aal1: no ve la lista de espera');
select throws_ok($$select public.fijar_pin('1234')$$, '42501', null, 'dueño aal1: no fija PIN');
select throws_ok($$select public.rotar_token_entrada('1234')$$, '42501', null, 'dueño aal1: no rota el QR de entrada');
select pg_temp.como('00000000-0000-0000-0000-0000000005d0', 'aal2');
select is(private.es_dueno(), true, 'con segundo factor (aal2) sí');

-- =============================================================================================
-- 4. PIN del dueño
-- =============================================================================================
select is(public.cambiar_bandera('referidos', true, null, null, '1234') ->> 'error', 'sin_pin', 'sin PIN configurado no se puede actuar');
select throws_ok($$select public.fijar_pin('12')$$, 'P0001', null, 'el PIN tiene mínimo 4 dígitos');
select throws_ok($$select public.fijar_pin('abcd')$$, 'P0001', null, 'y solo dígitos');
select is(public.fijar_pin('4321') ->> 'ok', 'true', 'el dueño fija su PIN');
select is((select pin_hash <> '4321' and pin_hash like '$2%' from private.staff_pin where user_id = '00000000-0000-0000-0000-0000000005d0'), true, 'el PIN se guarda cifrado (bcrypt), no en claro');
select is(public.fijar_pin('8765') ->> 'error', 'pin_incorrecto', 'cambiar el PIN exige el actual');
select is(public.fijar_pin('8765', '4321') ->> 'ok', 'true', 'con el actual se cambia');
select is(public.cambiar_bandera('referidos', true, null, null, '4321') ->> 'error', 'pin_incorrecto', 'el PIN anterior ya no sirve');

-- Límite de intentos
select is(public.cambiar_bandera('referidos', true, null, null, '0000') ->> 'intentos_restantes', '3', 'quedan 3 intentos');
do $$
declare i integer; res jsonb;
begin
  for i in 1..3 loop
    res := public.cambiar_bandera('referidos', true, null, null, '0000');
  end loop;
  insert into ids values ('ultimo_intento', res::text);
end $$;
select is((select v::jsonb ->> 'error' from ids where k = 'ultimo_intento'), 'pin_bloqueado', 'tras 5 fallos el PIN se bloquea');
select is(public.cambiar_bandera('referidos', true, null, null, '8765') ->> 'error', 'pin_bloqueado', 'bloqueado: ni el PIN correcto sirve');
select ok((select count(*) from public.auditoria where accion = 'pin_fallido') >= 5, 'los intentos fallidos quedan en la auditoría');
select is((select activa from public.banderas where clave = 'referidos'), false, 'y la bandera no cambió');
update private.staff_pin set bloqueado_hasta = now() - interval '1 minute' where user_id = '00000000-0000-0000-0000-0000000005d0';
select is(public.cambiar_bandera('referidos', true, null, null, '8765') ->> 'ok', 'true', 'pasado el bloqueo el PIN correcto funciona');
select is((select intentos from private.staff_pin where user_id = '00000000-0000-0000-0000-0000000005d0'), 0::smallint, 'y reinicia el conteo');

-- =============================================================================================
-- 5. Acciones sensibles con PIN
-- =============================================================================================
select is((select activa from public.banderas where clave = 'referidos'), true, 'cambiar_bandera: aplicada');
select is((select count(*) from public.auditoria where accion = 'cambiar_bandera' and entidad_id = 'referidos'), 1::bigint, 'cambiar_bandera: auditada');
select throws_ok($$select public.cambiar_bandera('no-existe', true, null, null, '8765')$$, 'P0001', null, 'bandera inexistente');

select is(public.cambiar_regla('pedidos_web.max_abiertos', '3'::jsonb, '8765') ->> 'ok', 'true', 'cambiar_regla: aplicada');
select is(private.regla_vigente('pedidos_web.max_abiertos'), '3'::jsonb, 'la regla vigente es la nueva');
select is((select version from public.reglas_negocio where clave = 'pedidos_web.max_abiertos' and vigente_hasta is null), 2, 'es la versión 2');
select is((select count(*) from public.reglas_negocio where clave = 'pedidos_web.max_abiertos'), 2::bigint, 'la versión 1 se conserva (cerrada)');
select is((select detalle ->> 'anterior' from public.auditoria where accion = 'cambiar_regla' and entidad_id = 'pedidos_web.max_abiertos'), '2', 'la auditoría guarda el valor anterior');
select throws_ok($$select public.cambiar_regla('pedidos_web.max_abiertos', '"tres"'::jsonb, '8765')$$, 'P0001', null, 'el tipo del valor debe coincidir con el de la regla');
select throws_ok($$select public.cambiar_regla('puntos.cop_por_punto', '0'::jsonb, '8765')$$, 'P0001', null, 'los pesos por punto deben ser mayores que cero');
select throws_ok($$select public.cambiar_regla('no.existe', '1'::jsonb, '8765')$$, 'P0001', null, 'regla inexistente');
select is(public.cambiar_regla('pedidos_web.max_abiertos', '9'::jsonb, '0000') ->> 'error', 'pin_incorrecto', 'con PIN incorrecto la regla no cambia');
select is(private.regla_vigente('pedidos_web.max_abiertos'), '3'::jsonb, 'y sigue vigente la anterior');

-- Reasignar cliente (solo ventas sin pagar)
insert into ids select 'v3', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000005e1')::text;
select throws_ok(format($f$select public.reasignar_cliente(%L, '00000000-0000-0000-0000-0000000005e2', '', '8765')$f$, pg_temp.id('v3')), 'P0001', null, 'reasignar exige motivo');
select is(public.reasignar_cliente(pg_temp.id('v3'), '00000000-0000-0000-0000-0000000005e2', 'se eligió mal en la lista', '0000') ->> 'error', 'pin_incorrecto', 'reasignar exige PIN');
select is(public.reasignar_cliente(pg_temp.id('v3'), '00000000-0000-0000-0000-0000000005e2', 'se eligió mal en la lista', '8765') ->> 'ok', 'true', 'el dueño reasigna con PIN');
select is((select cliente_id from public.ventas where id = pg_temp.id('v3')), '00000000-0000-0000-0000-0000000005e2'::uuid, 'la venta quedó del otro cliente');
select is((select count(*) from public.auditoria where accion = 'reasignar_cliente' and entidad_id = pg_temp.id('v3')::text), 1::bigint, 'queda auditado');
select throws_ok(format($f$select public.reasignar_cliente(%L, '00000000-0000-0000-0000-0000000005e2', 'x', '8765')$f$, pg_temp.id('v3')), 'P0001', null, 'no se reasigna al mismo cliente');
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
select public.agregar_linea(pg_temp.id('v3'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('v3'));
select pg_temp.como('00000000-0000-0000-0000-0000000005d0');
select is(public.reasignar_cliente(pg_temp.id('v3'), '00000000-0000-0000-0000-0000000005e1', 'confirmada, aún se puede', '8765') ->> 'ok', 'true', 'también en una venta confirmada');
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
select public.pagar_venta(pg_temp.id('v3'), 'transferencia');
select pg_temp.como('00000000-0000-0000-0000-0000000005d0');
select throws_ok(format($f$select public.reasignar_cliente(%L, '00000000-0000-0000-0000-0000000005e2', 'x', '8765')$f$, pg_temp.id('v3')), 'P0001', null, 'una venta pagada no se reasigna');
-- con premio aplicado
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
insert into ids select 'v4', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000005e2')::text;
insert into ids select 'l4', public.agregar_linea(pg_temp.id('v4'), 'amazonas', 'pequeno', null, null, array['miel'])::text;
insert into ids select 'w4', id::text from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000005e2' and tipo = 'bienvenida';
select public.aplicar_voucher(pg_temp.id('l4'), pg_temp.id('w4'));
select pg_temp.como('00000000-0000-0000-0000-0000000005d0');
select throws_ok(format($f$select public.reasignar_cliente(%L, '00000000-0000-0000-0000-0000000005e1', 'x', '8765')$f$, pg_temp.id('v4')), 'P0001', null, 'con un premio aplicado hay que quitarlo primero');

-- Rotar el QR de entrada
select set_config('app.token_viejo', (select token from public.punto_venta where id = 1), true);
insert into ids select 'rot', public.rotar_token_entrada('8765')::text;
select isnt((select v::jsonb ->> 'token' from ids where k = 'rot'), current_setting('app.token_viejo'), 'el token cambia');
select is((select token from public.punto_venta where id = 1), (select v::jsonb ->> 'token' from ids where k = 'rot'), 'y queda guardado');
select is(public.rotar_token_entrada('0000') ->> 'error', 'pin_incorrecto', 'rotar exige PIN');
select pg_temp.como('00000000-0000-0000-0000-0000000005e1');
select throws_ok(format($f$select public.hacer_checkin(%L)$f$, current_setting('app.token_viejo')), 'P0001', null, 'el QR anterior deja de servir');
select pg_temp.como('00000000-0000-0000-0000-0000000005d0');
select ok((select count(*) from public.auditoria where accion = 'rotar_token_entrada') = 1 and not exists (select 1 from public.auditoria where detalle::text like '%' || (select v::jsonb ->> 'token' from ids where k = 'rot') || '%'),
  'la rotación se audita sin guardar el token');

-- Anular exige PIN
select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
insert into ids select 'v5', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v5'), 'espresso');
select public.confirmar_venta(pg_temp.id('v5'));
select public.pagar_venta(pg_temp.id('v5'), 'efectivo', 3000);
select pg_temp.como('00000000-0000-0000-0000-0000000005d0');
select is(public.anular_venta(pg_temp.id('v5'), 'prueba', '0000') ->> 'error', 'pin_incorrecto', 'anular con PIN incorrecto no anula');
select is((select estado from public.ventas where id = pg_temp.id('v5')), 'pagada', 'la venta sigue pagada');
select is(public.anular_venta(pg_temp.id('v5'), 'prueba', '8765') ->> 'ok', 'true', 'con el PIN correcto sí');
select is((select count(*) from pg_proc where proname = 'anular_venta' and pronamespace = 'public'::regnamespace), 1::bigint, 'ya no existe la versión de anular sin PIN');

-- Personal
select is(public.registrar_personal('00000000-0000-0000-0000-000000000999', 'cajero', 'Nuevo Cajero', '8765') ->> 'ok', 'true', 'el dueño registra a un cajero');
select throws_ok($$select public.registrar_personal('00000000-0000-0000-0000-000000000999', 'cajero', 'Otra vez', '8765')$$, 'P0001', null, 'no se registra dos veces');
select throws_ok($$select public.registrar_personal('00000000-0000-0000-0000-000000000999', 'jefe', 'X', '8765')$$, 'P0001', null, 'rol no válido');
select throws_ok($$select public.registrar_personal(gen_random_uuid(), 'cajero', 'Fantasma', '8765')$$, 'P0001', null, 'la cuenta de acceso debe existir');
select pg_temp.como('00000000-0000-0000-0000-000000000999', 'aal1');
select is(jsonb_typeof(public.lista_espera()), 'array', 'el cajero nuevo ya opera');
select pg_temp.como('00000000-0000-0000-0000-0000000005d0');
select throws_ok($$select public.desactivar_personal('00000000-0000-0000-0000-0000000005d0', '8765')$$, 'P0001', null, 'no puedes desactivar tu propia cuenta');
select is(public.desactivar_personal('00000000-0000-0000-0000-000000000999', '8765') ->> 'ok', 'true', 'el dueño desactiva a un cajero');
select pg_temp.como('00000000-0000-0000-0000-000000000999', 'aal1');
select throws_ok($$select public.lista_espera()$$, '42501', null, 'y pierde el acceso al instante');

-- =============================================================================================
-- 6. Perfil por etapas
-- =============================================================================================
select pg_temp.como('00000000-0000-0000-0000-0000000005e1');
select lives_ok($$select public.actualizar_mi_perfil('300 123 4567', date '1990-05-17')$$, 'celular y cumpleaños se piden después');
select is((select celular || '|' || cumpleanos from public.perfiles where user_id = '00000000-0000-0000-0000-0000000005e1'), '300 123 4567|1990-05-17', 'quedan guardados');
select throws_ok($$select public.actualizar_mi_perfil(null, current_date + 1)$$, 'P0001', null, 'un cumpleaños futuro no sirve');
select throws_ok($$select public.actualizar_mi_perfil('abc', null)$$, 'P0001', null, 'celular inválido');

-- =============================================================================================
-- 7. Permisos por rol
-- =============================================================================================
select pg_temp.como('00000000-0000-0000-0000-0000000005e1');
set local role authenticated;
select pg_temp.intentar('cli_lista',    $$select public.lista_espera()$$);
select pg_temp.intentar('cli_fijar_pin', $$select public.fijar_pin('1234')$$);
select pg_temp.intentar('cli_regla',    $$select public.cambiar_regla('pedidos_web.max_abiertos', '1'::jsonb, '8765')$$);
select pg_temp.intentar('cli_bandera',  $$select public.cambiar_bandera('referidos', false, null, null, '8765')$$);
select pg_temp.intentar('cli_rotar',    $$select public.rotar_token_entrada('8765')$$);
select pg_temp.intentar('cli_anular',   $$select public.anular_venta(gen_random_uuid(), 'x', '8765')$$);
select pg_temp.intentar('cli_personal', $$select public.registrar_personal(gen_random_uuid(), 'cajero', 'x', '8765')$$);
select pg_temp.intentar('cli_reasignar', $$select public.reasignar_cliente(gen_random_uuid(), gen_random_uuid(), 'x', '8765')$$);
select pg_temp.intentar('cli_pin_tabla', $$select count(*) from private.staff_pin$$);
select pg_temp.intentar('cli_marcar',   $$select public.marcar_se_fue(gen_random_uuid())$$);
select pg_temp.contar('cli_punto_venta', 'select count(*) from public.punto_venta');
select pg_temp.contar('cli_checkins',   'select count(*) from public.checkins');
select pg_temp.contar('cli_consent_propios', $$select count(*) from public.consentimientos where user_id = '00000000-0000-0000-0000-0000000005e1'$$);
select pg_temp.contar('cli_consent_ajenos',  $$select count(*) from public.consentimientos where user_id <> '00000000-0000-0000-0000-0000000005e1'$$);
select pg_temp.intentar('cli_upd_consent', $$update public.consentimientos set acepta = true$$);
select pg_temp.intentar('cli_ins_checkin', $$insert into public.checkins (cliente_id, vence_en) values ('00000000-0000-0000-0000-0000000005e1', now())$$);
reset role;

select pg_temp.como('00000000-0000-0000-0000-0000000005ca', 'aal1');
set local role authenticated;
select pg_temp.intentar('caj_fijar_pin', $$select public.fijar_pin('1234')$$);
select pg_temp.intentar('caj_regla',    $$select public.cambiar_regla('pedidos_web.max_abiertos', '1'::jsonb, '8765')$$);
select pg_temp.intentar('caj_rotar',    $$select public.rotar_token_entrada('8765')$$);
select pg_temp.intentar('caj_anular',   $$select public.anular_venta(gen_random_uuid(), 'x', '8765')$$);
select pg_temp.intentar('caj_checkin',  $$select public.hacer_checkin('x')$$);
select pg_temp.intentar('caj_lista',    $$select public.lista_espera()$$);
select pg_temp.contar('caj_punto_venta', 'select count(*) from public.punto_venta');
reset role;

set local role anon;
select pg_temp.intentar('anon_checkin', $$select public.hacer_checkin('x')$$);
select pg_temp.intentar('anon_lista',   $$select public.lista_espera()$$);
select pg_temp.intentar('anon_pv',      $$select count(*) from public.punto_venta$$);
reset role;

select is((select s from r where k = 'cli_lista'),    '42501', 'cliente: no ve la lista de espera');
select is((select s from r where k = 'cli_fijar_pin'), '42501', 'cliente: no fija PIN');
select is((select s from r where k = 'cli_regla'),    '42501', 'cliente: no cambia reglas');
select is((select s from r where k = 'cli_bandera'),  '42501', 'cliente: no cambia banderas');
select is((select s from r where k = 'cli_rotar'),    '42501', 'cliente: no rota el QR de entrada');
select is((select s from r where k = 'cli_anular'),   '42501', 'cliente: no anula ventas');
select is((select s from r where k = 'cli_personal'), '42501', 'cliente: no registra personal');
select is((select s from r where k = 'cli_reasignar'), '42501', 'cliente: no reasigna clientes');
select is((select s from r where k = 'cli_pin_tabla'), '42501', 'cliente: no lee la tabla de PIN');
select is((select s from r where k = 'cli_marcar'),   '42501', 'cliente: no marca "ya se fue"');
select is((select n from r where k = 'cli_punto_venta'), 0::bigint, 'cliente: no ve el token del punto de venta');
select is((select n from r where k = 'cli_checkins'), 0::bigint, 'cliente: no lee check-ins directo');
select ok((select n from r where k = 'cli_consent_propios') >= 2, 'cliente: ve sus propios consentimientos');
select is((select n from r where k = 'cli_consent_ajenos'), 0::bigint, 'cliente: no ve los de otros');
select is((select s from r where k = 'cli_upd_consent'), '42501', 'cliente: no edita consentimientos');
select is((select s from r where k = 'cli_ins_checkin'), '42501', 'cliente: no inserta check-ins a mano');
select is((select s from r where k = 'caj_fijar_pin'), '42501', 'cajero: no fija PIN');
select is((select s from r where k = 'caj_regla'),    '42501', 'cajero: no cambia reglas');
select is((select s from r where k = 'caj_rotar'),    '42501', 'cajero: no rota el QR de entrada');
select is((select s from r where k = 'caj_anular'),   '42501', 'cajero: no anula ventas pagadas');
select is((select s from r where k = 'caj_checkin'),  '42501', 'cajero: no hace check-in como cliente');
select is((select s from r where k = 'caj_lista'),    'ok',    'cajero: sí ve la lista de espera');
select ok((select n from r where k = 'caj_punto_venta') = 1, 'cajero: ve el token del punto de venta');
select is((select s from r where k = 'anon_checkin'), '42501', 'anónimo: no hace check-in');
select is((select s from r where k = 'anon_lista'),   '42501', 'anónimo: no ve la lista');
select is((select s from r where k = 'anon_pv'),      '42501', 'anónimo: no lee el punto de venta');

select is((select count(*) from pg_tables where schemaname = 'public' and not rowsecurity), 0::bigint, 'todas las tablas de public tienen RLS activado');
select is((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')),
  0::bigint, 'ninguna función pública es ejecutable por anónimos');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0::bigint, 'toda función security definer fija su search_path');
select is((select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace
           and p.proname not in ('es_staff', 'es_dueno', 'es_cajero', 'bloquear_mutacion')
           and has_function_privilege('authenticated', p.oid, 'execute')), 0::bigint, 'las funciones internas no son ejecutables por usuarios de la API');

select * from finish();
rollback;
