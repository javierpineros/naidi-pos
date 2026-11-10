-- H5: cierre de caja por medio de pago, alertas para el dueño, reportes, "repetir lo de la última vez".
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000006c1', 'authenticated', 'authenticated', 'cliente6a@prueba.test'),
  ('00000000-0000-0000-0000-0000000006c2', 'authenticated', 'authenticated', 'cliente6b@prueba.test'),
  ('00000000-0000-0000-0000-0000000006ca', 'authenticated', 'authenticated', 'cajero6@prueba.test'),
  ('00000000-0000-0000-0000-0000000006d0', 'authenticated', 'authenticated', 'dueno6@prueba.test');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000006ca', 'cajero', 'Cajero Seis'),
  ('00000000-0000-0000-0000-0000000006d0', 'dueno',  'Dueño Seis');
insert into private.staff_pin (user_id, pin_hash)
values ('00000000-0000-0000-0000-0000000006d0', extensions.crypt('2468', extensions.gen_salt('bf', 4)));

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;
create temp table r (k text primary key, n bigint, s text);
grant all on r to public;
create function pg_temp.contar(p_k text, p_q text) returns void language plpgsql as $$
declare v bigint;
begin execute p_q into v; insert into r (k, n) values (p_k, v); end $$;
create function pg_temp.intentar(p_k text, p_q text) returns void language plpgsql as $$
begin execute p_q; insert into r (k, s) values (p_k, 'ok');
exception when others then insert into r (k, s) values (p_k, sqlstate); end $$;

-- ----------------------------------------------------------------------------------------------
-- Ventas del día
-- ----------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000006ca', 'aal1');

-- s1 efectivo, s2 transferencia
insert into ids select 's1', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('s1'), 'espresso'); select public.confirmar_venta(pg_temp.id('s1')); select public.pagar_venta(pg_temp.id('s1'), 'efectivo', 5000);
insert into ids select 's2', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('s2'), 'latte'); select public.confirmar_venta(pg_temp.id('s2')); select public.pagar_venta(pg_temp.id('s2'), 'transferencia');

-- s3 datáfono con cliente y regalo de bienvenida (1 topping gratis)
insert into ids select 's3', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000006c1')::text;
insert into ids select 'l3', public.agregar_linea(pg_temp.id('s3'), 'amazonas', 'pequeno', null, null, array['miel'])::text;
insert into ids select 'w3', id::text from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000006c1' and tipo = 'bienvenida';
select public.aplicar_voucher(pg_temp.id('l3'), pg_temp.id('w3'));
select public.confirmar_venta(pg_temp.id('s3')); select public.pagar_venta(pg_temp.id('s3'), 'datafono_bold');

-- s4 Rappi
select public.registrar_venta_rappi(gen_random_uuid(), 'RAPPI-6001', '[{"producto":"espresso","cantidad":2}]'::jsonb);

-- s8 canje: 50% en un Mediano
insert into public.puntos_libro (cliente_id, tipo, puntos, nota) values ('00000000-0000-0000-0000-0000000006c1', 'bono', 130, 'prueba');
select pg_temp.como('00000000-0000-0000-0000-0000000006c1', 'aal1');
insert into ids select 'canje', public.canjear_premio('mediano')::text;
select pg_temp.como('00000000-0000-0000-0000-0000000006ca', 'aal1');
insert into ids select 's8', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000006c1')::text;
insert into ids select 'l8', public.agregar_linea(pg_temp.id('s8'), 'bowl-personalizado', 'mediano', null, 'mango')::text;
select public.aplicar_voucher(pg_temp.id('l8'), (select (v::jsonb ->> 'voucher_id')::uuid from ids where k = 'canje'));
select public.confirmar_venta(pg_temp.id('s8')); select public.pagar_venta(pg_temp.id('s8'), 'efectivo', 10000);

-- s5 confirmada sin pagar; s6 cancelada; s7 pagada y luego anulada
insert into ids select 's5', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('s5'), 'americano'); select public.confirmar_venta(pg_temp.id('s5'));
insert into ids select 's6', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('s6'), 'espresso'); select public.confirmar_venta(pg_temp.id('s6')); select public.cancelar_venta(pg_temp.id('s6'), 'prueba');
insert into ids select 's7', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('s7'), 'latte'); select public.confirmar_venta(pg_temp.id('s7')); select public.pagar_venta(pg_temp.id('s7'), 'efectivo', 4000);
select pg_temp.como('00000000-0000-0000-0000-0000000006d0');
select public.anular_venta(pg_temp.id('s7'), 'error de digitación', '2468');
select pg_temp.como('00000000-0000-0000-0000-0000000006ca', 'aal1');

-- =============================================================================================
-- 1. Cierre de caja
-- =============================================================================================
select is(public.cierre_de_caja() ->> 'total_cop', '36900', 'cierre: total de lo cobrado (2.500 + 4.000 + 16.300 + 5.000 + 9.100)');
select is(public.cierre_de_caja() ->> 'ventas', '5', 'cierre: 5 ventas pagadas');
select is(jsonb_path_query_array(public.cierre_de_caja() -> 'por_medio', '$[*].medio')::text, '["datafono_bold", "efectivo", "rappi", "transferencia"]', 'cierre: separado por medio de pago (incluye Rappi)');
select is((select (m ->> 'total_cop')::integer from jsonb_array_elements(public.cierre_de_caja() -> 'por_medio') m where m ->> 'medio' = 'efectivo'), 11600, 'efectivo: 2.500 + 9.100');
select is((select (m ->> 'total_cop')::integer from jsonb_array_elements(public.cierre_de_caja() -> 'por_medio') m where m ->> 'medio' = 'datafono_bold'), 16300, 'datáfono Bold: 17.800 - topping regalado');
select is((select (m ->> 'total_cop')::integer from jsonb_array_elements(public.cierre_de_caja() -> 'por_medio') m where m ->> 'medio' = 'rappi'), 5000, 'Rappi aparte');
select is(public.cierre_de_caja() #>> '{anuladas,total_cop}', '4000', 'las anuladas no suman al total y se informan');
select is(public.cierre_de_caja() ->> 'canceladas', '1', 'cuenta las canceladas');
select is(jsonb_array_length(public.cierre_de_caja() -> 'sin_pagar'), 1, 'marca la venta confirmada sin pagar');
select is(public.cierre_de_caja() -> 'sin_pagar' -> 0 ->> 'total_cop', '3000', 'con su valor');
select is(public.cierre_de_caja() ->> 'cerrado', 'false', 'aún no está cerrada');
select throws_ok($$select public.cerrar_caja(current_date + 30)$$, 'P0001', null, 'no se cierra la caja de un día futuro');

insert into ids select 'cierre', public.cerrar_caja()::text;
select is((select v::jsonb ->> 'alertas_creadas' from ids where k = 'cierre'), '1', 'al cerrar se marca para el dueño la venta sin pagar');
select is((select v::jsonb ->> 'cerrado' from ids where k = 'cierre'), 'true', 'caja cerrada');
select is(public.cerrar_caja() ->> 'ya_estaba_cerrada', 'true', 'cerrar de nuevo no duplica nada');
select is((select count(*) from public.alertas where tipo = 'venta_sin_pagar' and resuelta_en is null), 1::bigint, 'una sola alerta abierta por venta');
select throws_ok($$update public.cierres_caja set resumen = '{}'::jsonb$$, '23001', null, 'un cierre es inmutable');
-- Una venta posterior no altera el cierre ya guardado
select public.registrar_venta_offline(gen_random_uuid(), now(), '[{"producto":"espresso"}]'::jsonb, 'transferencia');
select is(public.cierre_de_caja() ->> 'total_cop', '36900', 'el cierre guardado no cambia con ventas posteriores');
select is(public.cierre_de_caja() ->> 'cerrado', 'true', 'y se muestra como cerrado');

-- Alertas
select throws_ok($$select public.lista_alertas()$$, '42501', null, 'el cajero no ve las alertas');
select pg_temp.como('00000000-0000-0000-0000-0000000006d0');
select is(jsonb_array_length(public.lista_alertas()), 1, 'el dueño ve la alerta');
select is(public.lista_alertas() -> 0 ->> 'tipo', 'venta_sin_pagar', 'de venta sin pagar');
select throws_ok(format($f$select public.resolver_alerta(%L, '')$f$, (public.lista_alertas() -> 0 ->> 'id')::bigint), 'P0001', null, 'resolver exige explicar qué pasó');
select lives_ok(format($f$select public.resolver_alerta(%L, 'El cliente pagó por transferencia después')$f$, (public.lista_alertas() -> 0 ->> 'id')::bigint), 'el dueño la resuelve');
select is(jsonb_array_length(public.lista_alertas()), 0, 'ya no queda abierta');

-- =============================================================================================
-- 2. Reportes del dueño
-- =============================================================================================
select is(public.reporte_ventas(current_date - 1, current_date + 1) #>> '{totales,ventas}', '6', 'reporte: ventas pagadas del rango (incluye la posterior)');
select is(public.reporte_ventas(current_date - 1, current_date + 1) #>> '{totales,total_cop}', '39400', 'reporte: total');
select is((select (x ->> 'unidades')::integer from jsonb_array_elements(public.reporte_ventas(current_date - 1, current_date + 1) -> 'por_sabor') x where x ->> 'sabor' = 'Açaí mango'), 2,
  'por sabor: el menú y el bowl personalizado se agrupan por sabor (Açaí mango)');
select is((select (x ->> 'ingresos_cop')::integer from jsonb_array_elements(public.reporte_ventas(current_date - 1, current_date + 1) -> 'por_sabor') x where x ->> 'sabor' = 'Açaí mango'), 25400,
  'por sabor: ingresos netos (16.300 + 9.100)');
select is((select (x ->> 'ingresos_cop')::integer from jsonb_array_elements(public.reporte_ventas(current_date - 1, current_date + 1) -> 'por_tamano') x where x ->> 'tamano' = 'Mediano'), 9100, 'por tamaño: Mediano');
select is((select (x ->> 'unidades')::integer from jsonb_array_elements(public.reporte_ventas(current_date - 1, current_date + 1) -> 'por_tamano') x where x ->> 'tamano' = 'Sin tamaño'), 5, 'por tamaño: cafés sin tamaño');
select is(jsonb_array_length(public.reporte_ventas(current_date - 1, current_date + 1) -> 'por_hora'), 1, 'por hora: agrupa por hora de Bogotá');
select is((select count(*) from jsonb_array_elements(public.reporte_ventas(current_date - 1, current_date + 1) -> 'por_canal')), 2::bigint, 'por canal: tienda y Rappi');
select throws_ok($$select public.reporte_ventas(current_date, current_date - 1)$$, 'P0001', null, 'rango invertido');
select throws_ok($$select public.reporte_ventas(current_date - 400, current_date)$$, 'P0001', null, 'rango mayor a un año');

select is(public.reporte_canjes(current_date - 1, current_date + 1) #>> '{canjes,cantidad}', '1', 'canjes: 1');
select is(public.reporte_canjes(current_date - 1, current_date + 1) #>> '{canjes,puntos}', '130', 'canjes: puntos gastados');
select is(public.reporte_canjes(current_date - 1, current_date + 1) ->> 'puntos_acreditados', '25', 'puntos acreditados: 16 + 9');
select is((select (x ->> 'costo_cop')::integer from jsonb_array_elements(public.reporte_canjes(current_date - 1, current_date + 1) -> 'costo_premios') x where x ->> 'tipo' = 'premio'), 9100, 'costo del premio canjeado');
select is((select (x ->> 'costo_cop')::integer from jsonb_array_elements(public.reporte_canjes(current_date - 1, current_date + 1) -> 'costo_premios') x where x ->> 'tipo' = 'bienvenida'), 1500, 'costo del regalo de bienvenida');
select is(public.reporte_canjes(current_date - 1, current_date + 1) ->> 'costo_total_cop', '10600', 'costo total de premios');
select is((public.reporte_canjes(current_date - 1, current_date + 1) ->> 'costo_sobre_ventas_pct')::numeric, round(10600 * 100.0 / 39400, 1), 'costo como porcentaje de las ventas');

-- =============================================================================================
-- 3. Repetir lo de la última vez / ventas del día
-- =============================================================================================
select pg_temp.como('00000000-0000-0000-0000-0000000006ca', 'aal1');
select is(public.ultima_compra_de('00000000-0000-0000-0000-0000000006c1') -> 'lineas' -> 0 ->> 'producto', 'bowl-personalizado', 'última compra: la más reciente pagada');
select is(public.ultima_compra_de('00000000-0000-0000-0000-0000000006c1') -> 'lineas' -> 0 ->> 'base', 'mango', 'con su base');
select is(public.ultima_compra_de('00000000-0000-0000-0000-0000000006c2'), null::jsonb, 'un cliente sin compras devuelve null');
select is(jsonb_array_length(public.ventas_del_dia()), 8, 'ventas del día: confirmadas, pagadas y anuladas');
select ok(not (public.ventas_del_dia() -> 0) ? 'cliente_id', 'sin exponer ids de cliente');

-- =============================================================================================
-- 4. Permisos
-- =============================================================================================
select pg_temp.como('00000000-0000-0000-0000-0000000006c2', 'aal1');
set local role authenticated;
select pg_temp.intentar('cli_cierre',   $$select public.cierre_de_caja()$$);
select pg_temp.intentar('cli_cerrar',   $$select public.cerrar_caja()$$);
select pg_temp.intentar('cli_reporte',  $$select public.reporte_ventas(current_date, current_date)$$);
select pg_temp.intentar('cli_canjes',   $$select public.reporte_canjes(current_date, current_date)$$);
select pg_temp.intentar('cli_ultima',   $$select public.ultima_compra_de(gen_random_uuid())$$);
select pg_temp.intentar('cli_dia',      $$select public.ventas_del_dia()$$);
select pg_temp.contar('cli_cierres',    'select count(*) from public.cierres_caja');
select pg_temp.contar('cli_alertas',    'select count(*) from public.alertas');
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000006ca', 'aal1');
set local role authenticated;
select pg_temp.intentar('caj_reporte',  $$select public.reporte_ventas(current_date, current_date)$$);
select pg_temp.intentar('caj_canjes',   $$select public.reporte_canjes(current_date, current_date)$$);
select pg_temp.intentar('caj_resolver', $$select public.resolver_alerta(1, 'x')$$);
select pg_temp.contar('caj_cierres',    'select count(*) from public.cierres_caja');
select pg_temp.contar('caj_alertas',    'select count(*) from public.alertas');
select pg_temp.intentar('caj_ins_cierre', $$insert into public.cierres_caja (fecha, resumen) values (current_date + 5, '{}')$$);
reset role;
set local role anon;
select pg_temp.intentar('anon_cierre',  $$select public.cierre_de_caja()$$);
reset role;

select is((select s from r where k = 'cli_cierre'),   '42501', 'cliente: no ve el cierre de caja');
select is((select s from r where k = 'cli_cerrar'),   '42501', 'cliente: no cierra la caja');
select is((select s from r where k = 'cli_reporte'),  '42501', 'cliente: no ve reportes');
select is((select s from r where k = 'cli_canjes'),   '42501', 'cliente: no ve canjes');
select is((select s from r where k = 'cli_ultima'),   '42501', 'cliente: no ve compras de otros');
select is((select s from r where k = 'cli_dia'),      '42501', 'cliente: no ve las ventas del día');
select is((select n from r where k = 'cli_cierres'),  0::bigint, 'cliente: no lee cierres directo');
select is((select n from r where k = 'cli_alertas'),  0::bigint, 'cliente: no lee alertas directo');
select is((select s from r where k = 'caj_reporte'),  '42501', 'cajero: no ve reportes de ventas (son del dueño)');
select is((select s from r where k = 'caj_canjes'),   '42501', 'cajero: no ve costo de premios');
select is((select s from r where k = 'caj_resolver'), '42501', 'cajero: no resuelve alertas');
select ok((select n from r where k = 'caj_cierres') >= 1, 'cajero: lee los cierres de caja');
select is((select n from r where k = 'caj_alertas'),  0::bigint, 'cajero: no lee alertas directo');
select is((select s from r where k = 'caj_ins_cierre'), '42501', 'cajero: no inserta cierres a mano');
select is((select s from r where k = 'anon_cierre'),  '42501', 'anónimo: no ve el cierre');

select is((select count(*) from pg_tables where schemaname = 'public' and not rowsecurity), 0::bigint, 'todas las tablas de public tienen RLS activado');
select is((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname not in ('pantalla_estado', 'tienda_estado') and has_function_privilege('anon', p.oid, 'execute')),
  0::bigint, 'ninguna función pública es ejecutable por anónimos (salvo pantalla_estado y tienda_estado, las dos públicas)');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0::bigint, 'toda función security definer fija su search_path');

select * from finish();
rollback;
