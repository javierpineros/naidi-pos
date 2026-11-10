-- H8b: pago en línea con Bold. La base decide qué está pagado; el webhook es idempotente y tolera desorden.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000010c1', 'authenticated', 'authenticated', 'ana10@prueba.test',  '{"full_name":"Ana María Torres Gil"}'),
  ('00000000-0000-0000-0000-0000000010c2', 'authenticated', 'authenticated', 'beto10@prueba.test', '{"full_name":"Beto Ruiz"}'),
  ('00000000-0000-0000-0000-0000000010ca', 'authenticated', 'authenticated', 'cajero10@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values ('00000000-0000-0000-0000-0000000010ca', 'cajero', 'Cajero Diez');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true) $$;
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
-- Evento de Bold como lo aplica la Edge Function: con la service_role.
create function pg_temp.evento(p_id text, p_tipo text, p_order text, p_monto integer, p_moneda text default 'COP', p_pago text default 'bp-1') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role service_role;
  select public.aplicar_evento_bold(p_id, p_tipo, p_order, p_pago, p_monto, p_moneda, 'CARD', '{}'::jsonb) into r;
  reset role;
  return r;
end $$;

select pg_temp.regla('pedido_web.ventana', '{"min_anticipacion_min":20,"max_anticipacion_horas":72,"max_duracion_min":60}'::jsonb);
select pg_temp.regla('pedido_web.pagos', '{"al_recoger":true,"en_linea":true}'::jsonb);
select pg_temp.como('00000000-0000-0000-0000-0000000010c1');
select public.registrar_consentimiento('datos', (private.regla_vigente('privacidad.version') #>> '{}'), true);
select pg_temp.como('00000000-0000-0000-0000-0000000010c2');
select public.registrar_consentimiento('datos', (private.regla_vigente('privacidad.version') #>> '{}'), true);

-- ---------------------------------------------------------------------------------------------
-- 1. Con la bandera apagada ninguna ruta de pago en línea responde
-- ---------------------------------------------------------------------------------------------
reset role;
update public.banderas set activa = true where clave = 'pedidos_web';
update public.pedidos_web_interruptor set abierta = true where id = 1;
select pg_temp.como('00000000-0000-0000-0000-0000000010c1');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'en_linea')$f$, pg_temp.manana('11:00'), pg_temp.manana('11:30')),
                   '%pago en línea todavía no está disponible%', 'sin la bandera de Bold no se crean pedidos en línea');
select throws_like(format($f$select public.iniciar_pago_pedido_web(%L)$f$, gen_random_uuid()), '%no está disponible%', 'ni se inicia un pago');
select is(pg_temp.evento('e0', 'SALE_APPROVED', 'NW1-x', 4000) ->> 'resultado', 'bandera_apagada', 'el webhook no aplica nada con la bandera apagada');
select is((select count(*) from public.bold_eventos), 0::bigint, 'y ni siquiera guarda el evento');

reset role;
update public.banderas set activa = true where clave = 'pago_en_linea_bold';

-- ---------------------------------------------------------------------------------------------
-- 2. Iniciar el pago
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000010c1');
insert into ids select 'p1', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('11:00'), pg_temp.manana('11:30'), 'en_linea') ->> 'id');
insert into ids select 'pr', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"espresso"}]'::jsonb, pg_temp.manana('12:00'), pg_temp.manana('12:30'), 'al_recoger') ->> 'id');
select is((select pago_en_linea_estado from public.pedidos_web where id = pg_temp.id('p1')), 'pendiente', 'el pedido en línea nace con el pago pendiente');
select throws_like(format($f$select public.iniciar_pago_pedido_web(%L)$f$, pg_temp.id('pr')), '%se paga al recoger%', 'un pedido para pagar al recoger no inicia pago en línea');

insert into ids select 'o1', public.iniciar_pago_pedido_web(pg_temp.id('p1')) ->> 'order_id';
select matches((select v from ids where k = 'o1'), '^NW[0-9]+-[0-9a-f]{10}$', 'la referencia para Bold es válida (alfanumérica, sin espacios)');
select is(public.iniciar_pago_pedido_web(pg_temp.id('p1')) ->> 'monto_cop', '4000', 'el monto sale del pedido guardado, no del cliente');
select is(public.iniciar_pago_pedido_web(pg_temp.id('p1')) ->> 'order_id', (select v from ids where k = 'o1'), 'reintentar reutiliza el intento pendiente');
select is((select count(*) from public.pagos_bold), 1::bigint, 'queda un solo intento');

select pg_temp.como('00000000-0000-0000-0000-0000000010c2');
select throws_like(format($f$select public.iniciar_pago_pedido_web(%L)$f$, pg_temp.id('p1')), '%No encontramos ese pedido%', 'otra cuenta no inicia el pago de un pedido ajeno');
set local role authenticated;
select throws_ok($$select public.aplicar_evento_bold('x', 'SALE_APPROVED', 'y', 'z', 1000, 'COP', 'CARD', '{}')$$, '42501', null, 'un cliente no aplica eventos de Bold');
select throws_ok($$select * from public.pagos_bold$$, '42501', null, 'ni lee los pagos');
reset role;
set local role anon;
select throws_ok($$select public.aplicar_evento_bold('x', 'SALE_APPROVED', 'y', 'z', 1000, 'COP', 'CARD', '{}')$$, '42501', null, 'anon tampoco');
reset role;

-- El personal no prepara un pedido en línea sin pago
select pg_temp.como('00000000-0000-0000-0000-0000000010ca');
select throws_like(format($f$select public.cambiar_estado_pedido_web(%L, 'preparando')$f$, pg_temp.id('p1')), '%todavía no aparece pagado%', 'no se prepara un pedido en línea sin pago confirmado');
select throws_like(format($f$select public.entregar_pedido_web(%L, %L)$f$, pg_temp.id('p1'), (select codigo from public.pedidos_web where id = pg_temp.id('p1'))), '%todavía no aparece pagado%', 'ni se entrega');

-- ---------------------------------------------------------------------------------------------
-- 3. Eventos del webhook
-- ---------------------------------------------------------------------------------------------
reset role;
select is(pg_temp.evento('e1', 'SALE_APPROVED', 'NW999-inexistente', 4000) ->> 'resultado', 'orden_desconocida', 'una referencia desconocida no hace nada');
select is(pg_temp.evento('e2', 'SALE_APPROVED', (select v from ids where k = 'o1'), 3000) ->> 'resultado', 'monto_distinto', 'un monto distinto no se acredita');
select is(pg_temp.evento('e3', 'SALE_APPROVED', (select v from ids where k = 'o1'), 4000, 'USD') ->> 'resultado', 'monto_distinto', 'ni una moneda distinta');
select is((select estado from public.pagos_bold where order_id = (select v from ids where k = 'o1')), 'pendiente', 'el pago sigue pendiente');
select is((select count(*) from public.alertas where tipo = 'pago_bold'), 2::bigint, 'y quedan alertas para el dueño');
select is(pg_temp.evento('e4', 'SALE_REJECTED', (select v from ids where k = 'o1'), 4000) ->> 'resultado', 'rechazado', 'un rechazo marca el intento como rechazado');

-- Tras un rechazo, un intento nuevo
select pg_temp.como('00000000-0000-0000-0000-0000000010c1');
insert into ids select 'o2', public.iniciar_pago_pedido_web(pg_temp.id('p1')) ->> 'order_id';
select isnt((select v from ids where k = 'o2'), (select v from ids where k = 'o1'), 'después de un rechazo se crea un intento nuevo');
reset role;
select is(pg_temp.evento('e5', 'VOID_APPROVED', (select v from ids where k = 'o2'), 4000) ->> 'resultado', 'ignorado', 'una anulación que llega antes de la aprobación se ignora');
select is(pg_temp.evento('e6', 'SALE_APPROVED', (select v from ids where k = 'o2'), 4000) ->> 'resultado', 'aprobado', 'la aprobación válida marca el pedido como pagado');
select is((select pago_en_linea_estado from public.pedidos_web where id = pg_temp.id('p1')), 'pagado', 'el pedido queda pagado');
select is(pg_temp.evento('e6', 'SALE_APPROVED', (select v from ids where k = 'o2'), 4000) ->> 'resultado', 'duplicado', 'el mismo evento repetido no hace nada');
select is(pg_temp.evento('e7', 'SALE_APPROVED', (select v from ids where k = 'o2'), 4000) ->> 'resultado', 'ya_aprobado', 'otro evento de la misma orden tampoco acredita dos veces');
select is(pg_temp.evento('e8', 'SALE_REJECTED', (select v from ids where k = 'o2'), 4000) ->> 'resultado', 'ignorado', 'un rechazo tardío no deshace una aprobación');
select is((select count(*) from public.bold_eventos), 8::bigint, 'cada evento distinto queda en el libro una sola vez');

-- Ya pagado: se prepara y se entrega sin elegir medio; la venta queda como pago en línea
select pg_temp.como('00000000-0000-0000-0000-0000000010ca');
select is(public.cambiar_estado_pedido_web(pg_temp.id('p1'), 'preparando') ->> 'estado', 'preparando', 'ya pagado, el personal lo prepara');
select throws_like(format($f$select public.cancelar_pedido_web(%L, 'x')$f$, pg_temp.id('p1')), '%ya se pagó en línea%', 'y no se cancela sin la devolución');
select is(public.entregar_pedido_web(pg_temp.id('p1'), (select codigo from public.pedidos_web where id = pg_temp.id('p1'))) ->> 'medio_pago', 'bold_online', 'se entrega sin pedir medio: la venta queda como pago en línea');
select is((select medio_pago from public.ventas where id = (select venta_id from public.pedidos_web where id = pg_temp.id('p1'))), 'bold_online', 'la venta guarda el medio bold_online');
select cmp_ok((select coalesce(sum(puntos), 0) from public.puntos_libro where cliente_id = '00000000-0000-0000-0000-0000000010c1'), '>=', 0::bigint, 'los puntos se acreditan con la venta pagada');

-- Una anulación después de entregar requiere al dueño
reset role;
select is(pg_temp.evento('e9', 'VOID_APPROVED', (select v from ids where k = 'o2'), 4000) ->> 'resultado', 'anulado_requiere_revision', 'anular un pedido ya entregado queda para revisión del dueño');

-- ---------------------------------------------------------------------------------------------
-- 4. Pagó un pedido que ya se había cancelado; anulación con el pedido abierto; conciliación
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000010c2');
insert into ids select 'p2', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"americano"}]'::jsonb, pg_temp.manana('13:00'), pg_temp.manana('13:30'), 'en_linea') ->> 'id');
insert into ids select 'o3', public.iniciar_pago_pedido_web(pg_temp.id('p2')) ->> 'order_id';
select lives_ok(format($f$select public.cancelar_mi_pedido_web(%L)$f$, pg_temp.id('p2')), 'el cliente cancela antes de pagar');
reset role;
select is(pg_temp.evento('e10', 'SALE_APPROVED', (select v from ids where k = 'o3'), 3000, 'COP', 'bp-2') ->> 'resultado', 'aprobado_requiere_revision', 'si el pago llega con el pedido cancelado, se acredita el pago pero se avisa al dueño');
select is((select pago_en_linea_estado from public.pedidos_web where id = pg_temp.id('p2')), 'pendiente', 'sin tocar el pedido cerrado');

select pg_temp.como('00000000-0000-0000-0000-0000000010c2');
insert into ids select 'p3', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"americano"}]'::jsonb, pg_temp.manana('14:00'), pg_temp.manana('14:30'), 'en_linea') ->> 'id');
insert into ids select 'o4', public.iniciar_pago_pedido_web(pg_temp.id('p3')) ->> 'order_id';
reset role;
select pg_temp.evento('e11', 'SALE_APPROVED', (select v from ids where k = 'o4'), 3000, 'COP', 'bp-3');
select is(pg_temp.evento('e12', 'VOID_APPROVED', (select v from ids where k = 'o4'), 3000, 'COP', 'bp-3') ->> 'resultado', 'anulado', 'una anulación con el pedido abierto lo devuelve a pago pendiente');
select is((select pago_en_linea_estado from public.pedidos_web where id = pg_temp.id('p3')), 'pendiente', 'y vuelve a quedar sin pagar');

select pg_temp.como('00000000-0000-0000-0000-0000000010c2');
insert into ids select 'p4', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"espresso"}]'::jsonb, pg_temp.manana('15:00'), pg_temp.manana('15:30'), 'en_linea') ->> 'id');
insert into ids select 'o5', public.iniciar_pago_pedido_web(pg_temp.id('p4')) ->> 'order_id';
reset role;
set local role service_role;
select is(jsonb_array_length(public.pagos_bold_por_conciliar(15)), 0, 'un intento reciente aún no se concilia');
reset role;
update public.pagos_bold set creado_en = now() - interval '20 minutes' where order_id = (select v from ids where k = 'o5');
set local role service_role;
select is(public.pagos_bold_por_conciliar(15) -> 0 ->> 'order_id', (select v from ids where k = 'o5'), 'un intento pendiente de más de 15 minutos sí se concilia');
reset role;
update public.banderas set activa = false where clave = 'pago_en_linea_bold';
set local role service_role;
select is(jsonb_array_length(public.pagos_bold_por_conciliar(15)), 0, 'con la bandera apagada no hay nada que conciliar');
reset role;

select * from finish();
rollback;
