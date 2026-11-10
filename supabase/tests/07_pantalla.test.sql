-- H6: llave de dispositivo de la pantalla del iPad. Emitir y revocar (dueño con PIN), lectura sin sesión,
-- lo que la pantalla ve y lo que no, y que ningún otro rol toque las llaves.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000007c1', 'authenticated', 'authenticated', 'cliente7@prueba.test', '{"full_name":"Lucía Gómez Rojas"}'),
  ('00000000-0000-0000-0000-0000000007ca', 'authenticated', 'authenticated', 'cajero7@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000007d0', 'authenticated', 'authenticated', 'dueno7@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000007ca', 'cajero', 'Cajero Siete'),
  ('00000000-0000-0000-0000-0000000007d0', 'dueno',  'Dueño Siete');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;
create temp table r (k text primary key, n bigint, s text);
grant all on r to public;
create function pg_temp.intentar(p_k text, p_q text) returns void language plpgsql as $$
begin execute p_q; insert into r (k, s) values (p_k, 'ok');
exception when others then insert into r (k, s) values (p_k, sqlstate); end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Permisos: quién puede emitir, listar y revocar
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000007d0');
select is(public.fijar_pin('4321') ->> 'ok', 'true', 'el dueño fija su PIN');

select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
select throws_ok($$select public.emitir_llave_dispositivo('iPad', '4321')$$, '42501', null, 'el cajero no emite llaves');
select throws_ok($$select public.listar_dispositivos()$$, '42501', null, 'el cajero no lista pantallas');
select pg_temp.como('00000000-0000-0000-0000-0000000007c1');
select throws_ok($$select public.emitir_llave_dispositivo('iPad', '4321')$$, '42501', null, 'el cliente no emite llaves');
select pg_temp.como('00000000-0000-0000-0000-0000000007d0', 'aal1');
select throws_ok($$select public.emitir_llave_dispositivo('iPad', '4321')$$, '42501', null, 'el dueño sin segundo factor no emite llaves');

select pg_temp.como('00000000-0000-0000-0000-0000000007d0');
select is(public.emitir_llave_dispositivo('iPad', '0000') ->> 'error', 'pin_incorrecto', 'PIN incorrecto: no emite (devuelve ok:false)');
select is((select count(*) from public.dispositivos), 0::bigint, 'y no quedó ninguna fila');
insert into ids select 'e1', public.emitir_llave_dispositivo('iPad del mostrador', '4321')::text;
select is((select v::jsonb ->> 'ok' from ids where k = 'e1'), 'true', 'el dueño con PIN emite la llave');
select matches((select v::jsonb ->> 'llave' from ids where k = 'e1'), '^nd_[0-9a-f]{64}$', 'la llave es larga y aleatoria (256 bits)');
select isnt((select llave_hash from public.dispositivos limit 1), (select v::jsonb ->> 'llave' from ids where k = 'e1'), 'en la base solo queda el hash, no la llave');
select is((select count(*) from public.auditoria where accion = 'emitir_llave_dispositivo'), 1::bigint, 'la emisión queda en la auditoría');
select is((select count(*) from public.auditoria where detalle::text like '%nd\_%'), 0::bigint, 'la auditoría no guarda la llave');
select is(jsonb_array_length(public.listar_dispositivos()), 1, 'el dueño ve su lista de pantallas');
select is((public.listar_dispositivos() -> 0) ? 'llave_hash', false, 'la lista no trae el hash');

select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
set local role authenticated;
select is((select count(*) from public.dispositivos), 0::bigint, 'el cajero no ve la tabla de dispositivos (RLS)');
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007d0');
set local role authenticated;
select pg_temp.intentar('hash_dueno', 'select llave_hash from public.dispositivos');
select is((select s from r where k = 'hash_dueno'), '42501', 'ni el dueño puede leer la columna del hash');
select is((select count(*) from public.dispositivos), 1::bigint, 'pero el dueño sí ve sus pantallas');
reset role;

-- Tope de pantallas activas (regla pantalla.max_dispositivos = 3)
insert into ids select 'e2', public.emitir_llave_dispositivo('iPad 2', '4321')::text;
insert into ids select 'e3', public.emitir_llave_dispositivo('iPad 3', '4321')::text;
select throws_like($$select public.emitir_llave_dispositivo('iPad 4', '4321')$$, '%máximo de pantallas%', 'hay un tope de pantallas activas');

-- ---------------------------------------------------------------------------------------------
-- 2. Lectura sin sesión (rol anon) con la llave
-- ---------------------------------------------------------------------------------------------
reset role;
select set_config('app.token_actual', (select token from public.punto_venta where id = 1), true);
select set_config('request.jwt.claims', '', true);
set local role anon;
select set_config('app.llave', (select v::jsonb ->> 'llave' from ids where k = 'e1'), true);

select is(public.pantalla_estado(current_setting('app.llave')) ->> 'ok', 'true', 'anon con la llave lee el estado de la pantalla');
select is(public.pantalla_estado(current_setting('app.llave')) ->> 'entrada_token',
          current_setting('app.token_actual'), 'recibe el token vigente del QR de entrada');
select is(public.pantalla_estado(current_setting('app.llave')) -> 'venta', 'null'::jsonb, 'sin venta en curso, la venta es null');
select is(public.pantalla_estado('nd_inventada') ->> 'error', 'llave_invalida', 'una llave inventada no entra (ok:false, sin error)');
select is(public.pantalla_estado(null) ->> 'error', 'llave_invalida', 'llave nula tampoco');
select is(public.pantalla_estado(repeat('x', 500)) ->> 'error', 'llave_invalida', 'ni una llave gigante');
select is(public.pantalla_estado('') ->> 'ok', 'false', 'ni una vacía');
select pg_temp.intentar('anon_ventas', 'select count(*) from public.ventas');
select is((select s from r where k = 'anon_ventas'), '42501', 'anon no lee ventas directamente');
select pg_temp.intentar('anon_dispositivos', 'select count(*) from public.dispositivos');
select is((select s from r where k = 'anon_dispositivos'), '42501', 'anon no lee dispositivos');
select pg_temp.intentar('anon_token', 'select token from public.punto_venta');
select is((select s from r where k = 'anon_token'), '42501', 'anon no lee el token de entrada directamente');
select pg_temp.intentar('anon_emitir', $$select public.emitir_llave_dispositivo('x', '4321')$$);
select is((select s from r where k = 'anon_emitir'), '42501', 'anon no emite llaves');
select pg_temp.intentar('anon_revocar', $$select public.revocar_dispositivo(gen_random_uuid(), '4321')$$);
select is((select s from r where k = 'anon_revocar'), '42501', 'anon no revoca');

-- ---------------------------------------------------------------------------------------------
-- 3. La venta en curso: líneas, total, formas de pago; nada del cliente
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
insert into ids select 'v1', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000007c1')::text;
select public.agregar_linea(pg_temp.id('v1'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.agregar_linea(pg_temp.id('v1'), 'espresso');
select is(public.pantalla_estado(current_setting('app.llave')) -> 'venta', 'null'::jsonb, 'una venta que sigue alistándose no se muestra');
select public.confirmar_venta(pg_temp.id('v1'));

reset role;
select set_config('app.total_v1', (select total_cop::text from public.ventas where id = pg_temp.id('v1')), true);
set local role anon;
select is(public.pantalla_estado(current_setting('app.llave')) -> 'venta' ->> 'estado', 'confirmada', 'al confirmar, la pantalla ve la venta');
select is(jsonb_array_length(public.pantalla_estado(current_setting('app.llave')) -> 'venta' -> 'lineas'), 2, 'con sus dos líneas');
select is((public.pantalla_estado(current_setting('app.llave')) -> 'venta' ->> 'total_cop')::integer,
          current_setting('app.total_v1')::integer, 'el total sale de la base, no de la pantalla');
select is((public.pantalla_estado(current_setting('app.llave')) -> 'venta' -> 'lineas' -> 0 ->> 'nombre') is not null, true, 'cada línea trae su nombre');
select is(public.pantalla_estado(current_setting('app.llave')) -> 'formas_pago',
          '["efectivo","datafono_bold","transferencia"]'::jsonb, 'muestra las formas de pago');
select is(public.pantalla_estado(current_setting('app.llave')) -> 'transferencia' ? 'valor', true, 'y el destino de transferencias (parametrizable)');
select is(position('Lucía' in public.pantalla_estado(current_setting('app.llave'))::text), 0, 'no revela el nombre del cliente');
select is(position('00000000-0000-0000-0000-0000000007c1' in public.pantalla_estado(current_setting('app.llave'))::text), 0, 'ni su identificador');
select is(position('puntos' in public.pantalla_estado(current_setting('app.llave'))::text), 0, 'ni puntos');

-- Al pagar, "Pagado, gracias" unos segundos; luego vuelve al QR.
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
select public.pagar_venta(pg_temp.id('v1'), 'efectivo', 50000);
reset role; set local role anon;
select is(public.pantalla_estado(current_setting('app.llave')) -> 'venta' ->> 'estado', 'pagada', 'recién pagada: la pantalla agradece');
reset role;
update public.ventas set pagada_en = now() - interval '5 minutes' where id = pg_temp.id('v1');
set local role anon;
select is(public.pantalla_estado(current_setting('app.llave')) -> 'venta', 'null'::jsonb, 'pasados los segundos, vuelve al QR de entrada');

-- Una venta confirmada vieja (olvidada) no se queda para siempre en la pantalla.
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
insert into ids select 'v2', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v2'), 'latte');
select public.confirmar_venta(pg_temp.id('v2'));
reset role;
update public.ventas set confirmada_en = now() - interval '3 hours' where id = pg_temp.id('v2');
set local role anon;
select is(public.pantalla_estado(current_setting('app.llave')) -> 'venta', 'null'::jsonb, 'una venta confirmada hace horas no se muestra');

-- Dos ventas a la vez: manda la actividad más reciente, y "Pagado" no lo tapa una confirmada más vieja sin pagar.
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
insert into ids select 'v3', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v3'), 'latte');
select public.confirmar_venta(pg_temp.id('v3'));
insert into ids select 'v4', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v4'), 'americano');
select public.confirmar_venta(pg_temp.id('v4'));
reset role;
update public.ventas set confirmada_en = now() - interval '10 minutes' where id = pg_temp.id('v3');
select set_config('app.num_v3', (select numero::text from public.ventas where id = pg_temp.id('v3')), true);
select set_config('app.num_v4', (select numero::text from public.ventas where id = pg_temp.id('v4')), true);
select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
select public.pagar_venta(pg_temp.id('v4'), 'efectivo', 20000);
reset role; set local role anon;
select is((public.pantalla_estado(current_setting('app.llave')) -> 'venta' ->> 'numero'), current_setting('app.num_v4'), 'con dos ventas, la pantalla agradece la que se acaba de pagar');
select is((public.pantalla_estado(current_setting('app.llave')) -> 'venta' ->> 'estado'), 'pagada', 'y la muestra como pagada');
reset role;
update public.ventas set pagada_en = now() - interval '5 minutes' where id = pg_temp.id('v4');
set local role anon;
select is((public.pantalla_estado(current_setting('app.llave')) -> 'venta' ->> 'numero'), current_setting('app.num_v3'), 'pasados los segundos, vuelve a la confirmada que sigue sin pagar');

-- ---------------------------------------------------------------------------------------------
-- 4. El QR rotado llega solo; la llave revocada deja de servir al instante
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007d0');
select set_config('app.token_viejo', (select token from public.punto_venta where id = 1), true);
select public.rotar_token_entrada('4321');
reset role; set local role anon;
select isnt(public.pantalla_estado(current_setting('app.llave')) ->> 'entrada_token', current_setting('app.token_viejo'), 'al rotar el QR, la pantalla recibe el nuevo');

reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007ca');
select throws_ok(format($f$select public.revocar_dispositivo(%L, '4321')$f$, (select v::jsonb ->> 'id' from ids where k = 'e1')), '42501', null, 'el cajero no revoca');
select pg_temp.como('00000000-0000-0000-0000-0000000007d0');
select is(public.revocar_dispositivo((select (v::jsonb ->> 'id')::uuid from ids where k = 'e1'), '0000') ->> 'error', 'pin_incorrecto', 'revocar exige el PIN');
select is(public.revocar_dispositivo((select (v::jsonb ->> 'id')::uuid from ids where k = 'e1'), '4321') ->> 'ok', 'true', 'el dueño revoca con PIN');
reset role; set local role anon;
select is(public.pantalla_estado(current_setting('app.llave')) ->> 'error', 'llave_invalida', 'la llave revocada deja de servir al instante');
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000007d0');
select throws_like(format($f$select public.revocar_dispositivo(%L, '4321')$f$, (select v::jsonb ->> 'id' from ids where k = 'e1')), '%ya estaba revocada%', 'no se revoca dos veces');
select is((select count(*) from public.auditoria where accion = 'revocar_dispositivo'), 1::bigint, 'la revocación queda en la auditoría');
select is(public.emitir_llave_dispositivo('iPad nuevo', '4321') ->> 'ok', 'true', 'al revocar una se libera cupo para otra');

-- Esta prueba avisa si una migración futura le quita a anon el permiso de la pantalla.
reset role;
select ok(has_function_privilege('anon', 'public.pantalla_estado(text)', 'execute'), 'anon puede ejecutar pantalla_estado');
select ok(not has_function_privilege('anon', 'public.emitir_llave_dispositivo(text,text)', 'execute'), 'anon no puede emitir llaves');
select ok(not has_function_privilege('anon', 'public.listar_dispositivos()', 'execute'), 'anon no puede listar pantallas');

select * from finish();
rollback;
