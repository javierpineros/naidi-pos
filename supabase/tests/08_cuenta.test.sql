-- H7: cuenta del cliente. Reporte "esto no es lo que pedí", historial de compras, perfil y reglas de fidelización.
-- Cada rol intenta lo que no debe poder hacer.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000008c1', 'authenticated', 'authenticated', 'ana8@prueba.test',  '{"full_name":"Ana María Torres Gil"}'),
  ('00000000-0000-0000-0000-0000000008c2', 'authenticated', 'authenticated', 'beto8@prueba.test', '{"full_name":"Beto Ruiz"}'),
  ('00000000-0000-0000-0000-0000000008ca', 'authenticated', 'authenticated', 'cajero8@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000008d0', 'authenticated', 'authenticated', 'dueno8@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000008ca', 'cajero', 'Cajero Ocho'),
  ('00000000-0000-0000-0000-0000000008d0', 'dueno',  'Dueño Ocho');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;

-- ---------------------------------------------------------------------------------------------
-- Ventas de prueba: v1 confirmada de Ana, v2 pagada de Ana, v3 confirmada de Beto, v4 alistando de Ana
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000008ca');
insert into ids select 'v1', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000008c1')::text;
select public.agregar_linea(pg_temp.id('v1'), 'amazonas', 'pequeno', null, null, array['miel']);
select public.confirmar_venta(pg_temp.id('v1'));
insert into ids select 'v2', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000008c1')::text;
select public.agregar_linea(pg_temp.id('v2'), 'latte');
select public.confirmar_venta(pg_temp.id('v2'));
select public.pagar_venta(pg_temp.id('v2'), 'efectivo', 20000);
insert into ids select 'v3', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000008c2')::text;
select public.agregar_linea(pg_temp.id('v3'), 'espresso');
select public.confirmar_venta(pg_temp.id('v3'));
insert into ids select 'v4', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000008c1')::text;
select public.agregar_linea(pg_temp.id('v4'), 'americano');

-- ---------------------------------------------------------------------------------------------
-- 1. "Esto no es lo que pedí"
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000008c2');
select throws_like(format($f$select public.reportar_pedido(%L)$f$, pg_temp.id('v1')), '%No encontramos ese pedido%', 'un cliente no reporta el pedido de otro');
select pg_temp.como('00000000-0000-0000-0000-0000000008c1');
select throws_like(format($f$select public.reportar_pedido(%L)$f$, pg_temp.id('v2')), '%ya no se puede reportar%', 'una venta pagada no se reporta desde la cuenta');
select throws_like(format($f$select public.reportar_pedido(%L)$f$, pg_temp.id('v4')), '%ya no se puede reportar%', 'ni una que todavía se está alistando');
select throws_like(format($f$select public.reportar_pedido(%L, %L)$f$, pg_temp.id('v1'), repeat('x', 201)), '%muy larga%', 'la nota tiene tope de 200 letras');
select throws_ok($$select public.reportar_pedido(gen_random_uuid())$$, 'P0001', null, 'un pedido inexistente no se reporta');
select is(public.reportar_pedido(pg_temp.id('v1'), '  Pedí sin miel  ') ->> 'ya_reportado', 'false', 'el cliente reporta su pedido confirmado');
select is(public.reportar_pedido(pg_temp.id('v1')) ->> 'ya_reportado', 'true', 'reportar de nuevo no duplica el aviso');
select is((select count(*) from public.alertas where tipo = 'cliente_reporta' and venta_id = pg_temp.id('v1')), 1::bigint, 'queda una sola alerta abierta por venta');
select is((select detalle ->> 'nota' from public.alertas where tipo = 'cliente_reporta' and venta_id = pg_temp.id('v1')), 'Pedí sin miel', 'con la nota sin espacios sobrantes');
select is((select count(*) from public.auditoria where accion = 'reportar_pedido'), 1::bigint, 'el reporte queda en la auditoría (una vez)');

select throws_ok($$select public.reportes_abiertos()$$, '42501', null, 'el cliente no ve los reportes del POS');
select throws_ok($$select public.resolver_reporte(1)$$, '42501', null, 'ni los resuelve');

select pg_temp.como('00000000-0000-0000-0000-0000000008ca');
select is(jsonb_array_length(public.reportes_abiertos()), 1, 'el vendedor ve el reporte abierto');
select is(public.reportes_abiertos() -> 0 ->> 'numero', (select numero::text from public.ventas where id = pg_temp.id('v1')), 'con el número de la venta');
select is(public.reportes_abiertos() -> 0 ->> 'cliente', 'Ana', 'solo con el nombre de pila');
select is(public.reportes_abiertos() -> 0 ->> 'nota', 'Pedí sin miel', 'y la nota del cliente');
select lives_ok(format($f$select public.resolver_reporte(%s, 'Se corrigió el pedido')$f$, (select id from public.alertas where tipo = 'cliente_reporta' limit 1)), 'el vendedor lo resuelve');
select is(jsonb_array_length(public.reportes_abiertos()), 0, 'y deja de aparecer');
select throws_like(format($f$select public.resolver_reporte(%s)$f$, (select id from public.alertas where tipo = 'cliente_reporta' limit 1)), '%ya se resolvió%', 'no se resuelve dos veces');
select is((select nota from public.alertas where tipo = 'cliente_reporta' limit 1), 'Se corrigió el pedido', 'queda la nota de quien lo resolvió');

-- Tope de avisos por venta (3), aunque cada uno se resuelva
select pg_temp.como('00000000-0000-0000-0000-0000000008c1');
select public.reportar_pedido(pg_temp.id('v1'));
select pg_temp.como('00000000-0000-0000-0000-0000000008ca');
select public.resolver_reporte((select max(id) from public.alertas where tipo = 'cliente_reporta'));
select pg_temp.como('00000000-0000-0000-0000-0000000008c1');
select public.reportar_pedido(pg_temp.id('v1'));
select throws_like(format($f$select public.reportar_pedido(%L)$f$, pg_temp.id('v1')), '%varias veces%', 'hay un tope de avisos por pedido');

-- Si la venta se paga o se cancela, el reporte ya no estorba en el POS
select pg_temp.como('00000000-0000-0000-0000-0000000008ca');
select public.pagar_venta(pg_temp.id('v1'), 'efectivo', 30000);
select is(jsonb_array_length(public.reportes_abiertos()), 0, 'una venta ya pagada no deja reportes abiertos en el POS');

select pg_temp.como('00000000-0000-0000-0000-0000000008d0');
select is(jsonb_array_length(public.lista_alertas()), 1, 'el dueño sí conserva el registro del aviso abierto');

-- ---------------------------------------------------------------------------------------------
-- 2. Historial de compras
-- ---------------------------------------------------------------------------------------------
reset role;
update public.ventas set pagada_en = now() - interval '1 hour' where id = pg_temp.id('v2');   -- dentro de la transacción todo ocurre "ahora"
select pg_temp.como('00000000-0000-0000-0000-0000000008c1');
select is(jsonb_array_length(public.mis_compras()), 2, 'Ana ve sus dos compras pagadas (no la que se alista)');
select is(public.mis_compras() -> 0 ->> 'numero', (select numero::text from public.ventas where id = pg_temp.id('v1')), 'la más reciente primero');
select is(jsonb_array_length(public.mis_compras() -> 0 -> 'lineas'), 1, 'con sus líneas');
select ok((public.mis_compras() -> 0 ->> 'puntos')::integer >= 0, 'y los puntos que sumó');
select pg_temp.como('00000000-0000-0000-0000-0000000008c2');
select is(jsonb_array_length(public.mis_compras()), 0, 'Beto no ve las compras de Ana (y la suya sigue sin pagar)');
select pg_temp.como('00000000-0000-0000-0000-0000000008ca');
select throws_ok($$select public.mis_compras()$$, '42501', null, 'el personal no usa las funciones de cuenta de cliente');
select throws_ok($$select public.mi_perfil()$$, '42501', null, 'ni el perfil');
select throws_ok($$select public.reglas_fidelizacion()$$, '42501', null, 'ni las reglas del cliente');

-- ---------------------------------------------------------------------------------------------
-- 3. Perfil y reglas
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000008c1');
select is(public.mi_perfil() ->> 'nombre_pila', 'Ana', 'mi_perfil: nombre de pila');
select is(public.mi_perfil() ->> 'acepta_datos', 'false', 'sin consentimiento al empezar');
select is(public.mi_perfil() ->> 'acepta_mensajes', 'false', 'ni de mensajes');
select is((public.mi_perfil() ->> 'compras_pagadas')::integer, 2, 'cuenta sus compras pagadas');
select is(public.mi_perfil() ->> 'celular', null, 'celular vacío hasta que lo diga');
select lives_ok($$select public.registrar_consentimiento('datos', '2026-11-v1', true)$$, 'acepta el tratamiento de datos');
select lives_ok($$select public.registrar_consentimiento('mensajes', '2026-11-v1', true)$$, 'y los mensajes');
select lives_ok($$select public.actualizar_mi_perfil('300 123 4567', date '1990-05-17')$$, 'completa celular y cumpleaños');
select is(public.mi_perfil() ->> 'acepta_datos', 'true', 'mi_perfil refleja el consentimiento de datos');
select is(public.mi_perfil() ->> 'acepta_mensajes', 'true', 'y el de mensajes');
select is(public.mi_perfil() ->> 'celular', '300 123 4567', 'y el celular');
select is(public.mi_perfil() ->> 'cumpleanos', '1990-05-17', 'y el cumpleaños');
select lives_ok($$select public.registrar_consentimiento('mensajes', '2026-11-v1', false)$$, 'puede retirar los mensajes');
select is(public.mi_perfil() ->> 'acepta_mensajes', 'false', 'el retiro se refleja');
select is(public.reglas_fidelizacion() -> 'umbrales', '{"pequeno":120,"mediano":130,"grande":140}'::jsonb, 'el cliente ve los umbrales del premio');
select is((public.reglas_fidelizacion() ->> 'descuento_pct')::integer, 50, 'el descuento del premio');
select is((public.reglas_fidelizacion() ->> 'voucher_dias')::integer, 45, 'y la vigencia del voucher');

-- ---------------------------------------------------------------------------------------------
-- 4. Permisos de ejecución: nada para anónimos
-- ---------------------------------------------------------------------------------------------
reset role;
select ok(not has_function_privilege('anon', 'public.reportar_pedido(uuid,text)', 'execute'), 'anon no reporta pedidos');
select ok(not has_function_privilege('anon', 'public.reportes_abiertos()', 'execute'), 'anon no ve reportes');
select ok(not has_function_privilege('anon', 'public.resolver_reporte(bigint,text)', 'execute'), 'anon no resuelve reportes');
select ok(not has_function_privilege('anon', 'public.mis_compras(integer)', 'execute'), 'anon no ve compras');
select ok(not has_function_privilege('anon', 'public.mi_perfil()', 'execute'), 'anon no ve perfiles');
select ok(not has_function_privilege('anon', 'public.reglas_fidelizacion()', 'execute'), 'anon no ve reglas de fidelización');
select ok(has_function_privilege('authenticated', 'public.mi_perfil()', 'execute'), 'authenticated sí puede (la función valida el rol)');
select ok(has_function_privilege('anon', 'public.pantalla_estado(text)', 'execute'), 'y pantalla_estado (H6) sigue abierta para el iPad');

select * from finish();
rollback;
