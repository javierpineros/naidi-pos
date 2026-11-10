-- H3b: regalo de bienvenida flexible (toppings gratis, porcentaje de la compra, descuento en un bowl)
-- y ventas de Rappi registradas en el POS.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email)
select ('00000000-0000-0000-0000-00000000' || lpad(n::text, 4, '0'))::uuid, 'authenticated', 'authenticated', 'u' || n || '@prueba.test'
from unnest(array[3, 4, 5, 6, 7, 8, 9, 10, 202, 208]) n;
-- 0003..0010 clientes de prueba; 00ca (202) cajero y 00d0 (208) dueño
insert into public.perfiles (user_id, nombre)
select ('00000000-0000-0000-0000-00000000' || lpad(n::text, 4, '0'))::uuid, 'Cliente ' || n from unnest(array[3, 4, 5, 6, 7, 8, 9, 10]) n;
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-000000000202', 'cajero', 'Cajero Prueba'),
  ('00000000-0000-0000-0000-000000000208', 'dueno',  'Dueño Prueba');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.cl(n integer) returns text language sql as $$ select '00000000-0000-0000-0000-00000000' || lpad(n::text, 4, '0') $$;
create function pg_temp.como(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true) $$;
-- Fija un valor de regla saltando el trigger de versionado (solo para pruebas, como postgres).
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

select pg_temp.como('00000000-0000-0000-0000-000000000202');

-- El valor por omisión de la regla (versión 2) es un porcentaje de la primera compra.
select is(private.regla_vigente('bienvenida.regalo') ->> 'tipo', 'descuento_compra', 'regla inicial: porcentaje de la primera compra (provisional)');
select is((select version from public.reglas_negocio where clave = 'bienvenida.regalo' and vigente_hasta is null), 2, 'la versión 1 quedó cerrada y rige la 2');

-- =============================================================================================
-- 1. Regalo: 2 toppings gratis, cualquiera
-- =============================================================================================
select pg_temp.fijar_regla('bienvenida.regalo', '{"tipo":"toppings_gratis","cantidad":2,"toppings":null}'::jsonb);
insert into ids select 'v3', public.crear_venta(gen_random_uuid(), pg_temp.cl(3)::uuid)::text;
select is((select modalidad || ':' || cantidad_toppings from public.vouchers where cliente_id = pg_temp.cl(3)::uuid and tipo = 'bienvenida'), 'toppings_gratis:2',
  'el cliente nuevo recibe 2 toppings gratis');
insert into ids select 'w3', id::text from public.vouchers where cliente_id = pg_temp.cl(3)::uuid and tipo = 'bienvenida';
select pg_temp.como(pg_temp.cl(3));
select is(public.mis_vouchers() -> 0 ->> 'modalidad', 'toppings_gratis', 'el cliente ve la modalidad de su regalo');
select pg_temp.como('00000000-0000-0000-0000-000000000202');

insert into ids select 'l3', public.agregar_linea(pg_temp.id('v3'), 'bowl-personalizado', 'mediano', null, 'mango',
  array['banano','fresa','mango','kiwi','avena','chia','miel'])::text;
select is((select precio_unitario_cop from public.venta_lineas where id = pg_temp.id('l3')), 21200, 'Mediano 18.200 + chía 1.500 + miel 1.500 (los 5 primeros van incluidos)');
select throws_ok(format($f$select public.aplicar_voucher_compra(%L, %L)$f$, pg_temp.id('v3'), pg_temp.id('w3')), 'P0001', null, 'un regalo de toppings no es un descuento de compra');
select lives_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l3'), pg_temp.id('w3')), 'se aplica el regalo de toppings');
select is((select descuento_cop from public.venta_lineas where id = pg_temp.id('l3')), 3000, 'regala los 2 toppings con costo (3.000)');
select is((select total_cop from public.ventas where id = pg_temp.id('v3')), 18200, 'total sin esos toppings');
select public.confirmar_venta(pg_temp.id('v3'));
select is((public.pagar_venta(pg_temp.id('v3'), 'efectivo', 20000) ->> 'puntos_acreditados')::integer, 18, 'puntos sobre lo pagado: 18.200 -> 18');
select is((select count(*) from public.vouchers where cliente_id = pg_temp.cl(3)::uuid and tipo = 'bienvenida'), 1::bigint, 'el regalo es uno por cuenta');
insert into ids select 'v3b', public.crear_venta(gen_random_uuid(), pg_temp.cl(3)::uuid)::text;
select is((select count(*) from public.vouchers where cliente_id = pg_temp.cl(3)::uuid and tipo = 'bienvenida'), 1::bigint, 'en la segunda venta no se otorga otro regalo');

-- 1 topping, solo de una lista
select pg_temp.fijar_regla('bienvenida.regalo', '{"tipo":"toppings_gratis","cantidad":1,"toppings":["miel"]}'::jsonb);
insert into ids select 'v4', public.crear_venta(gen_random_uuid(), pg_temp.cl(4)::uuid)::text;
insert into ids select 'w4', id::text from public.vouchers where cliente_id = pg_temp.cl(4)::uuid and tipo = 'bienvenida';
insert into ids select 'l4', public.agregar_linea(pg_temp.id('v4'), 'amazonas', 'pequeno', null, null, array['arandanos','miel'])::text;
insert into ids select 'l4c', public.agregar_linea(pg_temp.id('v4'), 'espresso')::text;
select throws_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l4c'), pg_temp.id('w4')), 'P0001', null, 'una línea sin toppings con costo no recibe el regalo');
select public.aplicar_voucher(pg_temp.id('l4'), pg_temp.id('w4'));
select is((select descuento_cop from public.venta_lineas where id = pg_temp.id('l4')), 1500, 'solo se regala la miel (arándanos no está en la lista)');
select public.quitar_voucher(pg_temp.id('l4'));
select is((select descuento_cop from public.venta_lineas where id = pg_temp.id('l4')), 0, 'quitar el regalo devuelve el precio');
select is((select estado from public.vouchers where id = pg_temp.id('w4')), 'activo', 'y libera el voucher');

-- 1 topping, cualquiera: el de mayor valor
select pg_temp.fijar_regla('bienvenida.regalo', '{"tipo":"toppings_gratis","cantidad":1,"toppings":null}'::jsonb);
insert into ids select 'v5', public.crear_venta(gen_random_uuid(), pg_temp.cl(5)::uuid)::text;
insert into ids select 'w5', id::text from public.vouchers where cliente_id = pg_temp.cl(5)::uuid and tipo = 'bienvenida';
insert into ids select 'l5', public.agregar_linea(pg_temp.id('v5'), 'amazonas', 'pequeno', null, null, array['miel','arandanos'])::text;
select public.aplicar_voucher(pg_temp.id('l5'), pg_temp.id('w5'));
select is((select descuento_cop from public.venta_lineas where id = pg_temp.id('l5')), 2000, 'con 1 topping se regala el de más valor (arándanos 2.000)');

-- =============================================================================================
-- 2. Regalo: porcentaje de toda la primera compra
-- =============================================================================================
select pg_temp.fijar_regla('bienvenida.regalo', '{"tipo":"descuento_compra","descuento_pct":20}'::jsonb);
insert into ids select 'v6', public.crear_venta(gen_random_uuid(), pg_temp.cl(6)::uuid)::text;
insert into ids select 'w6', id::text from public.vouchers where cliente_id = pg_temp.cl(6)::uuid and tipo = 'bienvenida';
insert into ids select 'l6a', public.agregar_linea(pg_temp.id('v6'), 'bowl-personalizado', 'mediano', null, 'mango', array['banano'])::text;
insert into ids select 'l6b', public.agregar_linea(pg_temp.id('v6'), 'espresso')::text;
select throws_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l6a'), pg_temp.id('w6')), 'P0001', null, 'un descuento de compra no se aplica a una línea');
select throws_ok(format($f$select public.aplicar_voucher_compra(%L, %L)$f$, pg_temp.id('v5'), pg_temp.id('w6')), 'P0001', null, 'el regalo de otro cliente no se aplica');
select lives_ok(format($f$select public.aplicar_voucher_compra(%L, %L)$f$, pg_temp.id('v6'), pg_temp.id('w6')), 'se aplica el porcentaje a la compra');
select is((select subtotal_cop || '/' || descuento_cop || '/' || total_cop from public.ventas where id = pg_temp.id('v6')), '20700/4140/16560', '20% de 20.700 = 4.140');
select public.agregar_linea(pg_temp.id('v6'), 'latte');
select is((select total_cop from public.ventas where id = pg_temp.id('v6')), 20700 + 4000 - 4140 - 800, 'el descuento se recalcula al agregar productos');
select public.quitar_linea((select id from public.venta_lineas where venta_id = pg_temp.id('v6') and producto_clave = 'latte'));
select public.quitar_voucher_compra(pg_temp.id('v6'));
select is((select total_cop from public.ventas where id = pg_temp.id('v6')), 20700, 'quitar el descuento devuelve el total');
select is((select estado from public.vouchers where id = pg_temp.id('w6')), 'activo', 'y libera el voucher');
select public.aplicar_voucher_compra(pg_temp.id('v6'), pg_temp.id('w6'));
select public.confirmar_venta(pg_temp.id('v6'));
select is((select estado from public.vouchers where id = pg_temp.id('w6')), 'usado', 'confirmar consume el regalo');
select is((public.pagar_venta(pg_temp.id('v6'), 'datafono_bold') ->> 'puntos_acreditados')::integer, 16, 'puntos sobre lo pagado con descuento: 16.560 -> 16');
select pg_temp.como(pg_temp.cl(6));
select is((public.mi_compra_en_curso() ->> 'descuento_cop')::integer, 4140, 'el cliente ve su descuento');
select pg_temp.como('00000000-0000-0000-0000-000000000202');

-- Anular devuelve el regalo y revierte los puntos
select pg_temp.como('00000000-0000-0000-0000-000000000208');
select is((public.anular_venta(pg_temp.id('v6'), 'prueba') ->> 'puntos_revertidos')::integer, 16, 'anular revierte los 16 puntos');
select is((select estado from public.vouchers where id = pg_temp.id('w6')), 'activo', 'y devuelve el regalo');
select pg_temp.como('00000000-0000-0000-0000-000000000202');

-- El descuento de compra se reparte entre lo que suma y lo que no
select pg_temp.fijar_regla('puntos.categorias_que_suman', '["bowls"]'::jsonb);
insert into ids select 'v7', public.crear_venta(gen_random_uuid(), pg_temp.cl(7)::uuid)::text;
insert into ids select 'w7', id::text from public.vouchers where cliente_id = pg_temp.cl(7)::uuid and tipo = 'bienvenida';
select public.agregar_linea(pg_temp.id('v7'), 'bowl-personalizado', 'mediano', null, 'mango', array['banano']);
select public.agregar_linea(pg_temp.id('v7'), 'espresso');
select public.aplicar_voucher_compra(pg_temp.id('v7'), pg_temp.id('w7'));
select public.confirmar_venta(pg_temp.id('v7'));
select is((public.pagar_venta(pg_temp.id('v7'), 'transferencia') ->> 'puntos_acreditados')::integer, 14,
  'solo suma el bowl: 18.200 - su parte del descuento (3.640) = 14.560 -> 14 puntos');
select pg_temp.fijar_regla('puntos.categorias_que_suman', '["bowls","cafes","litro"]'::jsonb);

-- =============================================================================================
-- 3. Reglas de regalo antiguas o mal configuradas
-- =============================================================================================
select pg_temp.fijar_regla('bienvenida.regalo', '{"descuento_pct":10,"tamanos":["mini"]}'::jsonb);
select public.crear_venta(gen_random_uuid(), pg_temp.cl(8)::uuid);
select is((select modalidad || ':' || descuento_pct from public.vouchers where cliente_id = pg_temp.cl(8)::uuid), 'descuento_linea:10', 'el formato anterior (sin "tipo") sigue valiendo');

select pg_temp.fijar_regla('bienvenida.regalo', '{"tipo":"toppings_gratis","cantidad":0}'::jsonb);
select lives_ok(format($f$select public.crear_venta(gen_random_uuid(), %L)$f$, pg_temp.cl(9)), 'una regla de regalo inválida no bloquea la venta');
select is((select count(*) from public.vouchers where cliente_id = pg_temp.cl(9)::uuid), 0::bigint, 'simplemente no se otorga el regalo');
select pg_temp.fijar_regla('bienvenida.regalo', '{"tipo":"raro"}'::jsonb);
select lives_ok(format($f$select public.crear_venta(gen_random_uuid(), %L)$f$, pg_temp.cl(10)), 'un tipo desconocido tampoco bloquea');
select is((select count(*) from public.vouchers where cliente_id = pg_temp.cl(10)::uuid), 0::bigint, 'ni otorga nada');

-- =============================================================================================
-- 4. Ventas de Rappi
-- =============================================================================================
select count(*) as puntos_antes into temp table antes from public.puntos_libro;
insert into ids values ('k_r1', gen_random_uuid()::text);
insert into ids select 'rappi1', public.registrar_venta_rappi(pg_temp.id('k_r1'), 'RAPPI-1001',
  '[{"producto":"amazonas","tamano":"pequeno"},{"producto":"espresso","cantidad":2}]'::jsonb)::text;
select is((select (v::jsonb ->> 'total_cop')::integer from ids where k = 'rappi1'), 21300, 'Rappi: mismos precios del catálogo (16.300 + 2 × 2.500)');
select is((select canal || '/' || estado || '/' || medio_pago || '/' || referencia_externa from public.ventas where id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'rappi1')),
  'rappi/pagada/rappi/RAPPI-1001', 'queda pagada, en el canal Rappi y con su número de pedido');
select is((select cliente_id from public.ventas where id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'rappi1')), null, 'sin cliente');
select is((select count(*) from public.qr_posventa where venta_id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'rappi1')), 0::bigint, 'sin QR posterior');
select is((select count(*) from public.puntos_libro), (select puntos_antes from antes), 'sin puntos');

insert into ids select 'rappi1b', public.registrar_venta_rappi(gen_random_uuid(), 'RAPPI-1001', '[{"producto":"latte"}]'::jsonb)::text;
select is((select (v::jsonb ->> 'duplicada')::boolean from ids where k = 'rappi1b'), true, 'el mismo número de pedido no se registra dos veces');
insert into ids select 'rappi1c', public.registrar_venta_rappi(pg_temp.id('k_r1'), 'RAPPI-OTRO', '[{"producto":"latte"}]'::jsonb)::text;
select is((select (v::jsonb ->> 'duplicada')::boolean from ids where k = 'rappi1c'), true, 'ni la misma clave de idempotencia');
select is((select count(*) from public.ventas where canal = 'rappi'), 1::bigint, 'una sola venta de Rappi');

select throws_ok($$select public.registrar_venta_rappi(gen_random_uuid(), '  ', '[{"producto":"latte"}]'::jsonb)$$, 'P0001', null, 'exige número de pedido');
select throws_ok(format($f$select public.registrar_venta_rappi(gen_random_uuid(), %L, '[{"producto":"latte"}]'::jsonb)$f$, repeat('x', 41)), 'P0001', null, 'el número de pedido tiene tope de 40 caracteres');
select throws_ok($$select public.registrar_venta_rappi(gen_random_uuid(), 'RAPPI-2', '[]'::jsonb)$$, 'P0001', null, 'sin productos no hay venta');
select throws_ok($$select public.registrar_venta_rappi(gen_random_uuid(), 'RAPPI-3', '[{"producto":"latte"}]'::jsonb, now() - interval '9 days')$$, 'P0001', null, 'un pedido de hace más de 7 días no se registra solo');
select lives_ok($$select public.registrar_venta_rappi(gen_random_uuid(), 'RAPPI-4', '[{"producto":"latte"}]'::jsonb, now() - interval '3 hours')$$, 'se puede registrar un pedido de hace unas horas');
select ok((select pagada_en from public.ventas where referencia_externa = 'RAPPI-4') < now() - interval '2 hours 50 minutes', 'conserva la hora del pedido');

insert into ids select 'v_tienda', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v_tienda'), 'espresso');
select public.confirmar_venta(pg_temp.id('v_tienda'));
select throws_ok(format($f$select public.pagar_venta(%L, 'rappi')$f$, pg_temp.id('v_tienda')), 'P0001', null, 'una venta de tienda no se cobra como Rappi');
select throws_ok($$select public.registrar_venta_offline(gen_random_uuid(), now(), '[{"producto":"latte"}]'::jsonb, 'rappi')$$, 'P0001', null, 'ni por la vía sin internet');
select throws_ok($$insert into public.ventas (idempotency_key, canal) values (gen_random_uuid(), 'rappi')$$, '23514', null, 'la base exige el número de pedido en el canal Rappi');
select throws_ok(format($f$insert into public.ventas (idempotency_key, canal, referencia_externa, cliente_id) values (gen_random_uuid(), 'rappi', 'X', %L)$f$, pg_temp.cl(3)), '23514', null, 'una venta de Rappi no puede tener cliente');

-- Cierre de caja: Rappi queda separado de efectivo, datáfono y transferencia
select is((select sum(total_cop) from public.ventas where estado = 'pagada' and medio_pago = 'rappi' and referencia_externa = 'RAPPI-1001'), 21300::bigint, 'el cierre puede separar Rappi por medio de pago');

-- Anular una venta de Rappi no toca puntos
select pg_temp.como('00000000-0000-0000-0000-000000000208');
select is((public.anular_venta((select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'rappi1'), 'pedido duplicado en Rappi') ->> 'puntos_revertidos')::integer, 0, 'anular una venta de Rappi no revierte puntos');
select pg_temp.como('00000000-0000-0000-0000-000000000202');

-- Permisos
set local role anon;
select pg_temp.intentar('anon_rappi', $$select public.registrar_venta_rappi(gen_random_uuid(), 'A', '[{"producto":"latte"}]'::jsonb)$$);
reset role;
select pg_temp.como(pg_temp.cl(3));
set local role authenticated;
select pg_temp.intentar('cli_rappi', $$select public.registrar_venta_rappi(gen_random_uuid(), 'B', '[{"producto":"latte"}]'::jsonb)$$);
select pg_temp.intentar('cli_vcompra', format($f$select public.aplicar_voucher_compra(%L, %L)$f$, pg_temp.id('v6'), pg_temp.id('w6')));
select pg_temp.contar('cli_ver_rappi', $$select count(*) from public.ventas where canal = 'rappi'$$);
reset role;
select is((select s from r where k = 'anon_rappi'), '42501', 'anónimo: no registra ventas de Rappi');
select is((select s from r where k = 'cli_rappi'), '42501', 'cliente: no registra ventas de Rappi');
select is((select s from r where k = 'cli_vcompra'), '42501', 'cliente: no aplica descuentos a una venta');
select is((select n from r where k = 'cli_ver_rappi'), 0::bigint, 'cliente: no ve las ventas de Rappi');
select is((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')),
  0::bigint, 'ninguna función pública es ejecutable por anónimos (incluidas las nuevas)');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0::bigint, 'toda función security definer fija su search_path');
select is((select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace
           and p.proname not in ('es_staff', 'es_dueno', 'es_cajero', 'bloquear_mutacion')
           and has_function_privilege('authenticated', p.oid, 'execute')), 0::bigint, 'las funciones internas no son ejecutables por usuarios de la API');

select * from finish();
rollback;
