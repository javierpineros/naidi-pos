-- Venta visible en el iPad: una venta confirmada de tienda se puede reabrir para agregarle productos, el iPad la sigue
-- mostrando ("actualizando") mientras tanto, y al confirmar de nuevo vuelve a mostrar las formas de pago.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000012c1', 'authenticated', 'authenticated', 'cliente12@prueba.test', '{"full_name":"Lucía Gómez Rojas"}'),
  ('00000000-0000-0000-0000-0000000012ca', 'authenticated', 'authenticated', 'cajero12@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000012d0', 'authenticated', 'authenticated', 'dueno12@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000012ca', 'cajero', 'Cajero Doce'),
  ('00000000-0000-0000-0000-0000000012d0', 'dueno',  'Dueño Doce');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;
-- Lo que ve el iPad (como anon, con la llave guardada en app.llave).
create function pg_temp.ipad() returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role anon;
  select public.pantalla_estado(current_setting('app.llave')) into r;
  reset role;
  return r;
end $$;
-- Las pruebas no suponen una base vacía: dejan solo sus propias ventas "en pantalla".
update public.ventas set estado = 'cancelada', cancelada_en = now(), motivo_cancelacion = 'limpieza de prueba'
 where estado in ('confirmada', 'alistando') and canal = 'tienda';

-- Una pantalla activa
select pg_temp.como('00000000-0000-0000-0000-0000000012d0');
select public.fijar_pin('4321');
insert into ids select 'e1', public.emitir_llave_dispositivo('iPad prueba doce', '4321')::text;
select set_config('app.llave', (select v::jsonb ->> 'llave' from ids where k = 'e1'), true);

-- ---------------------------------------------------------------------------------------------
-- 1. Venta sin cliente: confirmada -> el iPad la ve; reabierta -> "actualizando"; confirmada otra vez -> se puede pagar
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.reabrir_venta(uuid)', 'execute'), 'anon no reabre ventas');
select pg_temp.como('00000000-0000-0000-0000-0000000012ca');
insert into ids select 'v1', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('v1'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.agregar_linea(pg_temp.id('v1'), 'espresso');
select is(pg_temp.ipad() -> 'venta', 'null'::jsonb, 'mientras se alista no se ve en el iPad');
select public.confirmar_venta(pg_temp.id('v1'));
select is(pg_temp.ipad() -> 'venta' ->> 'estado', 'confirmada', 'confirmada sin cliente: el iPad la muestra para que el cliente la revise');
select is(jsonb_array_length(pg_temp.ipad() -> 'venta' -> 'lineas'), 2, 'con sus dos líneas');
insert into ids select 'total1', (select total_cop::text from public.ventas where id = pg_temp.id('v1'));

select pg_temp.como('00000000-0000-0000-0000-0000000012c1');
select throws_ok(format($$select public.reabrir_venta(%L)$$, pg_temp.id('v1')), '42501', null, 'un cliente no reabre ventas');

select pg_temp.como('00000000-0000-0000-0000-0000000012ca');
select lives_ok(format($$select public.reabrir_venta(%L)$$, pg_temp.id('v1')), 'el cajero reabre la venta confirmada');
select is((select estado from public.ventas where id = pg_temp.id('v1')), 'alistando', 'queda en alistando');
select isnt((select reabierta_en from public.ventas where id = pg_temp.id('v1')), null, 'y marcada como reabierta');
select is(pg_temp.ipad() -> 'venta' ->> 'estado', 'actualizando', 'el iPad la sigue mostrando, como "actualizando"');
select is(jsonb_array_length(pg_temp.ipad() -> 'venta' -> 'lineas'), 2, 'con lo que tenía');
select throws_like(format($$select public.reabrir_venta(%L)$$, pg_temp.id('v1')), '%confirmada y sin pagar%', 'no se reabre dos veces');

select lives_ok(format($$select public.agregar_linea(%L, 'espresso')$$, pg_temp.id('v1')), 'se le agrega un producto');
select is(jsonb_array_length(pg_temp.ipad() -> 'venta' -> 'lineas'), 3, 'el iPad ya ve la línea nueva');
select ok((pg_temp.ipad() -> 'venta' ->> 'total_cop')::integer > (select v::integer from ids where k = 'total1'), 'y el total sube');

select public.confirmar_venta(pg_temp.id('v1'));
select is(pg_temp.ipad() -> 'venta' ->> 'estado', 'confirmada', 'al confirmar de nuevo el iPad vuelve a mostrar el cobro');
select is((select reabierta_en from public.ventas where id = pg_temp.id('v1')), null, 'y la venta ya no está en edición');
select is((select count(*) from public.venta_eventos where venta_id = pg_temp.id('v1') and motivo = 'reabierta'), 1::bigint, 'la reapertura queda en los eventos');
select is((select count(*) from public.auditoria where accion = 'reabrir_venta' and entidad_id = pg_temp.id('v1')::text), 1::bigint, 'y en la auditoría');

select is(public.pagar_venta(pg_temp.id('v1'), 'efectivo', 100000) ->> 'cambio_cop', (100000 - (select total_cop from public.ventas where id = pg_temp.id('v1')))::text, 'se cobra con el total nuevo');
select throws_like(format($$select public.reabrir_venta(%L)$$, pg_temp.id('v1')), '%confirmada y sin pagar%', 'una venta pagada no se reabre');
select is(pg_temp.ipad() -> 'venta' ->> 'estado', 'pagada', 'el iPad muestra "pagada"');

-- ---------------------------------------------------------------------------------------------
-- 2. Descartar una venta reabierta: el iPad vuelve al reposo
-- ---------------------------------------------------------------------------------------------
update public.ventas set pagada_en = pagada_en - interval '1 hour' where id = pg_temp.id('v1');
insert into ids select 'v2', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('v2'), 'espresso');
select public.confirmar_venta(pg_temp.id('v2'));
select public.reabrir_venta(pg_temp.id('v2'));
select is(pg_temp.ipad() -> 'venta' ->> 'estado', 'actualizando', 'reabierta: se ve');
select public.descartar_venta(pg_temp.id('v2'));
select is(pg_temp.ipad() -> 'venta', 'null'::jsonb, 'descartada: el iPad vuelve al QR de entrada');

-- Una reabierta abandonada deja de mostrarse pasado el tiempo máximo.
insert into ids select 'v3', public.crear_venta(gen_random_uuid(), null)::text;
select public.agregar_linea(pg_temp.id('v3'), 'espresso');
select public.confirmar_venta(pg_temp.id('v3'));
select public.reabrir_venta(pg_temp.id('v3'));
update public.ventas set reabierta_en = now() - interval '2 hours' where id = pg_temp.id('v3');
select is(pg_temp.ipad() -> 'venta', 'null'::jsonb, 'una reabierta abandonada no se queda en el iPad');
select public.descartar_venta(pg_temp.id('v3'));

-- ---------------------------------------------------------------------------------------------
-- 3. Premios: al reabrir quedan reservados; al confirmar de nuevo, usados. Y solo ventas de tienda.
-- ---------------------------------------------------------------------------------------------
insert into ids select 'v4', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000012c1')::text;
insert into ids select 'l4', public.agregar_linea(pg_temp.id('v4'), 'amazonas', 'pequeno', null, null, array['miel'])::text;
insert into ids select 'w4', id::text from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000012c1' and tipo = 'bienvenida';
select lives_ok(format($$select public.aplicar_voucher(%L, %L)$$, pg_temp.id('l4'), pg_temp.id('w4')), 'se aplica el regalo de bienvenida');
select public.confirmar_venta(pg_temp.id('v4'));
select is((select estado from public.vouchers where id = pg_temp.id('w4')), 'usado', 'confirmada: el premio está usado');
select public.reabrir_venta(pg_temp.id('v4'));
select is((select estado from public.vouchers where id = pg_temp.id('w4')), 'reservado', 'reabierta: el premio vuelve a quedar reservado');
select is((select descuento_cop > 0 from public.venta_lineas where id = pg_temp.id('l4')), true, 'y su descuento sigue en la línea');
select public.agregar_linea(pg_temp.id('v4'), 'espresso');
select public.confirmar_venta(pg_temp.id('v4'));
select is((select estado from public.vouchers where id = pg_temp.id('w4')), 'usado', 'al confirmar de nuevo, el premio queda usado otra vez');
select public.cancelar_venta(pg_temp.id('v4'), 'prueba');
select is((select estado from public.vouchers where id = pg_temp.id('w4')), 'activo', 'si se cancela, el premio se libera');

reset role;
insert into public.ventas (idempotency_key, canal, estado, confirmada_en) values (gen_random_uuid(), 'web', 'confirmada', now());
insert into ids select 'vw', id::text from public.ventas where canal = 'web' and estado = 'confirmada' order by creada_en desc limit 1;
select pg_temp.como('00000000-0000-0000-0000-0000000012ca');
select throws_like(format($$select public.reabrir_venta(%L)$$, pg_temp.id('vw')), '%ventas de tienda%', 'una venta del canal web no se reabre');

select * from finish();
rollback;
