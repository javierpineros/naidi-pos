-- H8c: pagar con Bold una venta del POS escaneando el QR del iPad.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000014ca', 'authenticated', 'authenticated', 'cajero14@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000014d0', 'authenticated', 'authenticated', 'dueno14@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000014ca', 'cajero', 'Cajero Catorce'),
  ('00000000-0000-0000-0000-0000000014d0', 'dueno',  'Dueño Catorce');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;
create function pg_temp.ipad() returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role anon;
  select public.pantalla_estado(current_setting('app.llave')) into r;
  reset role;
  return r;
end $$;
-- Llamadas que hace la Edge Function (service_role), con el código de pago de la venta.
create function pg_temp.iniciar(p_codigo text) returns jsonb language plpgsql as $$
declare r jsonb;
begin set local role service_role; select public.iniciar_pago_venta_qr(p_codigo) into r; reset role; return r; end $$;
create function pg_temp.pendientes(p_codigo text) returns jsonb language plpgsql as $$
declare r jsonb;
begin set local role service_role; select public.pagos_bold_pendientes_venta(p_codigo) into r; reset role; return r; end $$;
create function pg_temp.estado(p_codigo text) returns jsonb language plpgsql as $$
declare r jsonb;
begin set local role service_role; select public.estado_pago_venta_qr(p_codigo) into r; reset role; return r; end $$;
create function pg_temp.evento(p_id text, p_tipo text, p_order text, p_monto integer, p_pago text default 'bp-14') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role service_role;
  select public.aplicar_evento_bold(p_id, p_tipo, p_order, p_pago, p_monto, 'COP', 'CARD', '{}'::jsonb) into r;
  reset role;
  return r;
end $$;
create function pg_temp.codigo(p_k text) returns text language sql as $$ select codigo_pago from public.ventas where id = pg_temp.id(p_k) $$;
create function pg_temp.total(p_k text) returns integer language sql as $$ select total_cop from public.ventas where id = pg_temp.id(p_k) $$;

update public.ventas set estado = 'cancelada', cancelada_en = now(), motivo_cancelacion = 'limpieza de prueba'
 where estado in ('confirmada', 'alistando') and canal = 'tienda';
update public.banderas set activa = false where clave = 'pago_en_linea_bold';

select pg_temp.como('00000000-0000-0000-0000-0000000014d0');
select public.fijar_pin('4321');
insert into ids select 'e1', public.emitir_llave_dispositivo('iPad prueba catorce', '4321')::text;
select set_config('app.llave', (select v::jsonb ->> 'llave' from ids where k = 'e1'), true);

-- Una venta confirmada sin cliente
select pg_temp.como('00000000-0000-0000-0000-0000000014ca');
insert into ids select 'v1', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('v1'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('v1'));

-- ---------------------------------------------------------------------------------------------
-- 1. Permisos y bandera apagada
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.iniciar_pago_venta_qr(text)', 'execute'), 'anon no inicia pagos');
select ok(not has_function_privilege('authenticated', 'public.iniciar_pago_venta_qr(text)', 'execute'), 'ni una sesión de usuario');
select ok(has_function_privilege('service_role', 'public.iniciar_pago_venta_qr(text)', 'execute'), 'solo la Edge Function (service_role)');
select ok(not has_function_privilege('anon', 'public.pagos_bold_pendientes_venta(text)', 'execute'), 'anon no lee pendientes');
select ok(not has_function_privilege('anon', 'public.estado_pago_venta_qr(text)', 'execute'), 'ni el estado');
select is(length(pg_temp.codigo('v1')), 32, 'cada venta tiene un código de pago de 32 caracteres');
select is(pg_temp.ipad() -> 'venta' -> 'codigo_pago', null, 'con la bandera apagada el iPad no recibe el código');
select is(pg_temp.ipad() -> 'formas_pago', '["efectivo","datafono_bold","transferencia"]'::jsonb, 'ni la forma de pago en línea');
select throws_like(format($$select pg_temp.iniciar(%L)$$, pg_temp.codigo('v1')), '%todavía no está disponible%', 'sin la bandera no se inicia ningún pago');

update public.banderas set activa = true where clave = 'pago_en_linea_bold';

-- ---------------------------------------------------------------------------------------------
-- 2. Iniciar el pago: el monto sale de la venta
-- ---------------------------------------------------------------------------------------------
select is(pg_temp.ipad() -> 'venta' ->> 'codigo_pago', pg_temp.codigo('v1'), 'con la bandera encendida el iPad recibe el código para el QR');
select ok(pg_temp.ipad() -> 'formas_pago' ? 'bold_online', 'y la forma de pago en línea');
select throws_like($$select pg_temp.iniciar('no-es-un-codigo')$$, '%no es válido%', 'un código con mala forma se rechaza');
select throws_like($$select pg_temp.iniciar('00000000000000000000000000000000')$$, '%no es válido%', 'un código que no existe también');
insert into ids select 'p1', pg_temp.iniciar(pg_temp.codigo('v1'))::text;
select is((select v::jsonb ->> 'monto_cop' from ids where k = 'p1')::integer, pg_temp.total('v1'), 'el monto es el total guardado de la venta');
select is((select v::jsonb ->> 'order_id' from ids where k = 'p1') like 'V%', true, 'la referencia empieza por V (ventas)');
insert into ids select 'p1b', pg_temp.iniciar(pg_temp.codigo('v1'))::text;
select is((select v::jsonb ->> 'order_id' from ids where k = 'p1b'), (select v::jsonb ->> 'order_id' from ids where k = 'p1'), 'escanear de nuevo reutiliza el intento pendiente');
select is(jsonb_array_length(pg_temp.pendientes(pg_temp.codigo('v1'))), 1, 'hay un pendiente para verificar');
select is(pg_temp.estado(pg_temp.codigo('v1')) ->> 'estado', 'abierta', 'la página ve la compra abierta');
select is(pg_temp.estado('xx') ->> 'estado', 'invalido', 'y un código inválido como inválido');

-- ---------------------------------------------------------------------------------------------
-- 3. Eventos de Bold
-- ---------------------------------------------------------------------------------------------
select is(pg_temp.evento('ev14-1', 'SALE_APPROVED', (select v::jsonb ->> 'order_id' from ids where k = 'p1'), pg_temp.total('v1') + 500) ->> 'resultado', 'monto_distinto', 'un monto distinto no se acredita');
select is((select estado from public.ventas where id = pg_temp.id('v1')), 'confirmada', 'y la venta sigue sin pagar');
select is((select count(*) from public.alertas where tipo = 'pago_bold' and detalle ->> 'order_id' = (select v::jsonb ->> 'order_id' from ids where k = 'p1')), 1::bigint, 'queda una alerta para el dueño');

select is(pg_temp.evento('ev14-2', 'SALE_APPROVED', (select v::jsonb ->> 'order_id' from ids where k = 'p1'), pg_temp.total('v1')) ->> 'resultado', 'aprobado', 'con el monto correcto, aprobado');
select is((select estado from public.ventas where id = pg_temp.id('v1')), 'pagada', 'la venta queda pagada');
select is((select medio_pago from public.ventas where id = pg_temp.id('v1')), 'bold_online', 'con medio bold_online');
select is((select estado from public.pagos_bold where order_id = (select v::jsonb ->> 'order_id' from ids where k = 'p1')), 'aprobado', 'y el pago aprobado');
select is(pg_temp.ipad() -> 'venta' ->> 'estado', 'pagada', 'el iPad muestra "pagada"');
select is(pg_temp.estado(pg_temp.codigo('v1')) ->> 'estado', 'pagada', 'la página del cliente también');
select is(pg_temp.evento('ev14-2', 'SALE_APPROVED', (select v::jsonb ->> 'order_id' from ids where k = 'p1'), pg_temp.total('v1')) ->> 'resultado', 'duplicado', 'un evento repetido se ignora');
select throws_like(format($$select pg_temp.iniciar(%L)$$, pg_temp.codigo('v1')), '%ya está pagada%', 'una venta pagada no admite otro intento');

-- ---------------------------------------------------------------------------------------------
-- 4. Venta modificada después de generar el intento
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000014ca');
insert into ids select 'v2', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('v2'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('v2'));
insert into ids select 'total2', pg_temp.total('v2')::text;
insert into ids select 'p2', pg_temp.iniciar(pg_temp.codigo('v2'))::text;
select public.reabrir_venta(pg_temp.id('v2'));
select is((select estado from public.pagos_bold where order_id = (select v::jsonb ->> 'order_id' from ids where k = 'p2')), 'anulado', 'al reabrir la venta el intento pendiente se invalida');
select throws_like(format($$select pg_temp.iniciar(%L)$$, pg_temp.codigo('v2')), '%actualizando%', 'mientras se edita no se puede iniciar el pago');
select is(pg_temp.ipad() -> 'venta' -> 'codigo_pago', null, 'ni el iPad muestra el QR');
select public.agregar_linea(pg_temp.id('v2'), 'espresso');
select public.confirmar_venta(pg_temp.id('v2'));
select ok(pg_temp.total('v2') > (select v::integer from ids where k = 'total2'), 'el total subió');
insert into ids select 'p2b', pg_temp.iniciar(pg_temp.codigo('v2'))::text;
select isnt((select v::jsonb ->> 'order_id' from ids where k = 'p2b'), (select v::jsonb ->> 'order_id' from ids where k = 'p2'), 'el intento nuevo es otro');
select is((select v::jsonb ->> 'monto_cop' from ids where k = 'p2b')::integer, pg_temp.total('v2'), 'con el total nuevo');
-- Si Bold aprueba igual el intento viejo (el cliente ya había pagado), no se acredita: hay que devolver.
select is(pg_temp.evento('ev14-3', 'SALE_APPROVED', (select v::jsonb ->> 'order_id' from ids where k = 'p2'), (select v::integer from ids where k = 'total2'), 'bp-14b') ->> 'resultado', 'aprobado_requiere_revision', 'un pago del total viejo no cierra la venta');
select is((select estado from public.ventas where id = pg_temp.id('v2')), 'confirmada', 'la venta sigue abierta');
select is(pg_temp.evento('ev14-4', 'SALE_APPROVED', (select v::jsonb ->> 'order_id' from ids where k = 'p2b'), pg_temp.total('v2'), 'bp-14c') ->> 'resultado', 'aprobado', 'y el intento nuevo sí la cierra');

-- ---------------------------------------------------------------------------------------------
-- 5. Pago a una venta cancelada, rechazos y anulaciones
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000014ca');
insert into ids select 'v3', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('v3'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('v3'));
insert into ids select 'p3', pg_temp.iniciar(pg_temp.codigo('v3'))::text;
select is(pg_temp.evento('ev14-5', 'SALE_REJECTED', (select v::jsonb ->> 'order_id' from ids where k = 'p3'), 0) ->> 'resultado', 'rechazado', 'un rechazo marca el intento rechazado');
select is((select estado from public.ventas where id = pg_temp.id('v3')), 'confirmada', 'y la venta sigue sin pagar');
insert into ids select 'p3b', pg_temp.iniciar(pg_temp.codigo('v3'))::text;
select public.cancelar_venta(pg_temp.id('v3'), 'el cliente se fue');
select is(pg_temp.evento('ev14-6', 'SALE_APPROVED', (select v::jsonb ->> 'order_id' from ids where k = 'p3b'), pg_temp.total('v3'), 'bp-14d') ->> 'resultado', 'aprobado_requiere_revision', 'un pago a una venta ya cancelada pide revisión');
select is((select estado from public.ventas where id = pg_temp.id('v3')), 'cancelada', 'y no la revive');
select throws_like(format($$select pg_temp.iniciar(%L)$$, pg_temp.codigo('v3')), '%ya no está abierta%', 'una venta cancelada no admite pago');

select is(pg_temp.evento('ev14-7', 'VOID_APPROVED', (select v::jsonb ->> 'order_id' from ids where k = 'p1'), 0) ->> 'resultado', 'anulado_requiere_revision', 'una anulación de un pago aprobado pide revisión del dueño');
select is((select estado from public.ventas where id = pg_temp.id('v1')), 'pagada', 'la venta no se desanula sola');

-- Los pagos de pedidos web siguen funcionando igual (tienen pedido y no venta)
select is((select count(*) from public.pagos_bold where pedido_id is null and venta_id is null), 0::bigint, 'ningún pago queda sin destino');

-- ---------------------------------------------------------------------------------------------
-- Reenviar al iPad una venta confirmada que ya salió de la ventana de visibilidad
-- ---------------------------------------------------------------------------------------------
insert into ids select 'v9', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('v9'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('v9'));
update public.ventas set confirmada_en = now() - interval '3 hours' where id = pg_temp.id('v9');
update public.ventas set pagada_en = now() - interval '5 hours' where estado = 'pagada' and canal = 'tienda';
update public.ventas set confirmada_en = now() - interval '5 hours' where estado = 'confirmada' and canal = 'tienda' and id <> pg_temp.id('v9');   -- (now() es fijo dentro de la transacción)
select isnt(pg_temp.ipad() -> 'venta' ->> 'numero', (select numero::text from public.ventas where id = pg_temp.id('v9')), 'una confirmada de hace 3 horas ya no sale en el iPad');
select ok(not has_function_privilege('anon', 'public.mostrar_en_ipad(uuid)', 'execute'), 'anon no reenvía ventas al iPad');
select pg_temp.como('00000000-0000-0000-0000-0000000014ca');
select lives_ok(format($$select public.mostrar_en_ipad(%L)$$, pg_temp.id('v9')), 'el cajero la vuelve a mostrar');
select is(pg_temp.ipad() -> 'venta' ->> 'numero', (select numero::text from public.ventas where id = pg_temp.id('v9')), 'y el iPad la muestra otra vez');
select is((select estado from public.ventas where id = pg_temp.id('v9')), 'confirmada', 'sigue confirmada, sin cambios');
select throws_like($$select public.mostrar_en_ipad(gen_random_uuid())$$, '%no existe%', 'una venta que no existe se rechaza');

-- ---------------------------------------------------------------------------------------------
-- Reclamar los puntos de una venta pagada sin cliente, con el código de la venta (iPad, POS y /pagar)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000014c1', 'authenticated', 'authenticated', 'cliente14a@prueba.test'),
  ('00000000-0000-0000-0000-0000000014c2', 'authenticated', 'authenticated', 'cliente14b@prueba.test');
insert into public.perfiles (user_id, nombre) values
  ('00000000-0000-0000-0000-0000000014c1', 'Cliente Catorce A'), ('00000000-0000-0000-0000-0000000014c2', 'Cliente Catorce B')
on conflict (user_id) do update set nombre = excluded.nombre;
update public.ventas set pagada_en = now() - interval '5 hours' where estado = 'pagada' and canal = 'tienda' and cliente_id is null;
update public.ventas set mostrada_en = null where mostrada_en is not null;   -- (now() es fijo: evita empates con la venta reenviada antes)
select pg_temp.como('00000000-0000-0000-0000-0000000014ca');
insert into ids select 'r1', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('r1'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('r1'));
select ok(not (pg_temp.estado(pg_temp.codigo('r1')) ->> 'puntos_reclamables')::boolean, 'una venta sin pagar no se puede reclamar');
select public.pagar_venta(pg_temp.id('r1'), 'efectivo', 100000);
select is((pg_temp.ipad() -> 'venta' ->> 'codigo_puntos'), pg_temp.codigo('r1'), 'el iPad recibe el código para el QR de puntos');
select ok((pg_temp.estado(pg_temp.codigo('r1')) ->> 'puntos_reclamables')::boolean, 'y la página del cliente sabe que se puede reclamar');
select is((pg_temp.estado(pg_temp.codigo('r1')) ->> 'numero')::bigint, (select numero from public.ventas where id = pg_temp.id('r1')), 'y recibe el número del pedido');
select ok(not has_function_privilege('anon', 'public.reclamar_puntos_venta(text)', 'execute'), 'anon no reclama puntos');
update public.ventas set pagada_en = now() - interval '80 seconds' where id = pg_temp.id('r1');
select is(pg_temp.ipad() -> 'venta' ->> 'estado', 'pagada', 'a los 80 s el iPad todavía muestra la venta pagada (QR de puntos)');
update public.ventas set pagada_en = now() - interval '200 seconds' where id = pg_temp.id('r1');
select isnt(pg_temp.ipad() -> 'venta' ->> 'codigo_puntos', pg_temp.codigo('r1'), 'pasados 90 s el iPad ya no la muestra');
select pg_temp.como('00000000-0000-0000-0000-0000000014c1');
select throws_ok($$select public.reclamar_puntos_venta('no-valido')$$, 'P0001', null, 'un código mal formado no sirve');
select throws_ok($$select public.reclamar_puntos_venta('00000000000000000000000000000000')$$, 'P0001', null, 'un código que no existe tampoco');
insert into ids select 'pts', (public.reclamar_puntos_venta(pg_temp.codigo('r1')) ->> 'puntos_acreditados');
select ok((select v::integer from ids where k = 'pts') > 0, 'el cliente reclama y recibe puntos');
select is((select puntos from public.puntos_libro where venta_id = pg_temp.id('r1') and tipo = 'suma'), (select v::integer from ids where k = 'pts'), 'y el libro de puntos lo registra');
select is((select cliente_id::text from public.ventas where id = pg_temp.id('r1')), '00000000-0000-0000-0000-0000000014c1', 'la venta queda a su nombre');
select pg_temp.como('00000000-0000-0000-0000-0000000014c2');
select throws_ok(format($$select public.reclamar_puntos_venta(%L)$$, pg_temp.codigo('r1')), 'P0001', null, 'otro cliente no puede reclamar la misma venta');
select ok(not (pg_temp.estado(pg_temp.codigo('r1')) ->> 'puntos_reclamables')::boolean, 'ya no es reclamable');
-- Vencida: pasó la vigencia del QR de posventa
select pg_temp.como('00000000-0000-0000-0000-0000000014ca');
insert into ids select 'r2', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('r2'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('r2'));
select public.pagar_venta(pg_temp.id('r2'), 'transferencia');
update public.ventas set pagada_en = now() - interval '2 hours' where id = pg_temp.id('r2');
select pg_temp.como('00000000-0000-0000-0000-0000000014c2');
select throws_ok(format($$select public.reclamar_puntos_venta(%L)$$, pg_temp.codigo('r2')), 'P0001', null, 'pasado el plazo ya no se puede reclamar');

select * from finish();
rollback;
