-- H2: catálogo. Lectura pública, sin escritura desde el navegador, datos importados coherentes.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'cliente@prueba.test'),
  ('00000000-0000-0000-0000-0000000000ca', 'authenticated', 'authenticated', 'cajero@prueba.test');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000000ca', 'cajero', 'Cajero Prueba');

create temp table r (k text primary key, n bigint, s text);
grant all on r to public;
create function pg_temp.contar(p_k text, p_q text) returns void language plpgsql as $$
declare v bigint;
begin execute p_q into v; insert into r (k, n) values (p_k, v); end $$;
create function pg_temp.intentar(p_k text, p_q text) returns void language plpgsql as $$
begin execute p_q; insert into r (k, s) values (p_k, 'ok');
exception when others then insert into r (k, s) values (p_k, sqlstate); end $$;

-- Un producto desactivado: solo el personal debe verlo.
insert into public.productos (clave, categoria, tipo, nombre, usa_tamanos, precio_fijo_cop, activo)
values ('prueba-inactivo', 'cafes', 'cafe', 'Café retirado', false, 1000, false);

-- Anónimo (iPad y tienda sin sesión)
set local role anon;
select pg_temp.contar('anon_productos', 'select count(*) from public.productos');
select pg_temp.contar('anon_inactivos', 'select count(*) from public.productos where not activo');
select pg_temp.contar('anon_toppings',  'select count(*) from public.toppings');
select pg_temp.contar('anon_tamanos',   'select count(*) from public.tamanos');
select pg_temp.intentar('anon_ins_productos', $$insert into public.productos (clave, categoria, tipo, nombre, usa_tamanos, precio_fijo_cop) values ('x','cafes','cafe','x',false,1)$$);
select pg_temp.intentar('anon_upd_tamanos',   $$update public.tamanos set precio_cop = 1$$);
reset role;

-- Cliente autenticado
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.contar('cli_inactivos', 'select count(*) from public.productos where not activo');
select pg_temp.intentar('cli_upd_toppings', $$update public.toppings set precio_cop = 1$$);
select pg_temp.intentar('cli_del_productos', $$delete from public.productos$$);
reset role;

-- Cajero: ve lo inactivo, pero tampoco escribe directo
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ca","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.contar('caj_inactivos', 'select count(*) from public.productos where not activo');
select pg_temp.intentar('caj_upd_productos', $$update public.productos set nombre = 'x'$$);
reset role;

-- ================================ Afirmaciones =================================================
select is((select count(*) from pg_tables where schemaname = 'public' and not rowsecurity), 0::bigint, 'todas las tablas siguen con RLS activado');

select is((select n from r where k = 'anon_productos'), 13::bigint, 'anónimo: ve los 13 productos activos');
select is((select n from r where k = 'anon_inactivos'), 0::bigint, 'anónimo: no ve productos desactivados');
select is((select n from r where k = 'anon_toppings'), 24::bigint, 'anónimo: ve los 24 toppings');
select is((select n from r where k = 'anon_tamanos'), 4::bigint, 'anónimo: ve los 4 tamaños');
select is((select s from r where k = 'anon_ins_productos'), '42501', 'anónimo: no inserta productos');
select is((select s from r where k = 'anon_upd_tamanos'), '42501', 'anónimo: no cambia precios');
select is((select n from r where k = 'cli_inactivos'), 0::bigint, 'cliente: no ve productos desactivados');
select is((select s from r where k = 'cli_upd_toppings'), '42501', 'cliente: no cambia precios de toppings');
select is((select s from r where k = 'cli_del_productos'), '42501', 'cliente: no borra productos');
select is((select n from r where k = 'caj_inactivos'), 1::bigint, 'cajero: ve los productos desactivados');
select is((select s from r where k = 'caj_upd_productos'), '42501', 'cajero: no edita productos directo');

-- Datos importados
select is((select string_agg(clave || '=' || precio_cop, ',' order by orden) from public.tamanos),
  'mini=7000,pequeno=16300,mediano=18200,grande=19900', 'precios de los tamaños');
select is((select count(*) from public.productos where tipo = 'menu'), 8::bigint, '8 bowls de menú');
select is((select count(*) from public.productos where tipo = 'cafe' and activo), 3::bigint, '3 cafés');
select is((select precio_fijo_cop from public.productos where clave = 'litro-acai'), 53000, 'precio del litro');
select is((select count(*) from public.productos where categoria not in (select clave from public.categorias)), 0::bigint, 'toda categoría de producto existe');

-- Las categorías que suman puntos (regla vigente) existen en el catálogo
select is((select count(*) from jsonb_array_elements_text(private.regla_vigente('puntos.categorias_que_suman')) c
           where c not in (select clave from public.categorias)), 0::bigint, 'la regla de puntos solo nombra categorías existentes');

-- Coherencia de precios: con tamaños no hay precio fijo
select throws_ok($$insert into public.productos (clave, categoria, tipo, nombre, usa_tamanos, precio_fijo_cop) values ('malo','bowls','menu','Malo',true,5000)$$,
  '23514', null, 'producto con tamaños no admite precio fijo');
select throws_ok($$insert into public.productos (clave, categoria, tipo, nombre, usa_tamanos) values ('malo2','cafes','cafe','Malo',false)$$,
  '23514', null, 'producto sin tamaños exige precio fijo');
select throws_ok($$insert into public.toppings (clave, nombre, precio_cop) values ('gratis','Gratis',0)$$,
  '23514', null, 'un topping no puede costar 0');

select * from finish();
rollback;
