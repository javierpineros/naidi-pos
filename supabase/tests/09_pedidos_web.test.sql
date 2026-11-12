-- H8: pedidos web para recoger en tienda. Cada rol intenta lo que no debe poder hacer.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000009c1', 'authenticated', 'authenticated', 'ana9@prueba.test',  '{"full_name":"Ana María Torres Gil"}'),
  ('00000000-0000-0000-0000-0000000009c2', 'authenticated', 'authenticated', 'beto9@prueba.test', '{"full_name":"Beto Ruiz"}'),
  ('00000000-0000-0000-0000-0000000009c3', 'authenticated', 'authenticated', 'carla9@prueba.test', '{"full_name":"Carla Soto"}'),
  ('00000000-0000-0000-0000-0000000009ca', 'authenticated', 'authenticated', 'cajero9@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000009d0', 'authenticated', 'authenticated', 'dueno9@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000009ca', 'cajero', 'Cajero Nueve'),
  ('00000000-0000-0000-0000-0000000009d0', 'dueno',  'Dueño Nueve');

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;
create function pg_temp.anon() returns void language sql as $$ select set_config('request.jwt.claims', '{"role":"anon"}', true) $$;

-- Las reglas son versionadas: cambiar una cierra la vigente e inserta la versión siguiente.
create function pg_temp.regla(p_clave text, p_valor jsonb) returns void language plpgsql as $$
declare r public.reglas_negocio;
begin
  select * into r from public.reglas_negocio where clave = p_clave and vigente_hasta is null;
  update public.reglas_negocio set vigente_hasta = now() where id = r.id;
  insert into public.reglas_negocio (clave, version, valor, descripcion, publica, vigente_desde)
  values (r.clave, r.version + 1, p_valor, r.descripcion, r.publica, now());
end $$;

-- La ventana siempre cae mañana a mediodía-ish (hora de Bogotá), dentro del horario y de las 24 h.
create function pg_temp.manana(p_hora time) returns timestamptz language sql as $$
  select ((now() at time zone 'America/Bogota')::date + 1 + p_hora) at time zone 'America/Bogota' $$;

-- Las pruebas no dependen de la hora del día: se amplía la anticipación máxima para poder pedir "mañana".
select pg_temp.regla('pedido_web.ventana', '{"min_anticipacion_min":20,"max_anticipacion_horas":72,"max_duracion_min":60}'::jsonb);

-- Consentimiento de datos de las tres clientas (lo exige crear_pedido_web)
select pg_temp.como('00000000-0000-0000-0000-0000000009c1');
select public.registrar_consentimiento('datos', (private.regla_vigente('privacidad.version') #>> '{}'), true);
select pg_temp.como('00000000-0000-0000-0000-0000000009c2');
select public.registrar_consentimiento('datos', (private.regla_vigente('privacidad.version') #>> '{}'), true);
select pg_temp.como('00000000-0000-0000-0000-0000000009c3');
select public.registrar_consentimiento('datos', (private.regla_vigente('privacidad.version') #>> '{}'), true);

-- ---------------------------------------------------------------------------------------------
-- 1. Con la bandera apagada no se pide; la configuración pública responde sin sesión
-- ---------------------------------------------------------------------------------------------
select pg_temp.anon();
select is(public.tienda_estado() ->> 'abierta', 'false', 'sin sesión se ve que la tienda está cerrada (bandera apagada)');
select is(public.tienda_estado() -> 'pagos' ->> 'en_linea', 'false', 'el pago en línea no se ofrece con la bandera de Bold apagada');
select throws_ok($$select public.mi_tienda()$$, '42501', null, 'mi_tienda exige sesión');
select throws_ok($$select public.pedidos_web_abiertos()$$, '42501', null, 'anon no ve los pedidos');

select pg_temp.como('00000000-0000-0000-0000-0000000009c1');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'al_recoger')$f$,
                          pg_temp.manana('11:00'), pg_temp.manana('11:30')), '%no estamos recibiendo pedidos%', 'con la bandera apagada no se crean pedidos');

-- El dueño habilita la función (bandera); mientras el interruptor siga apagado, tampoco se pide
reset role;
update public.banderas set activa = true where clave = 'pedidos_web';
select pg_temp.anon();
select is(public.tienda_estado() ->> 'abierta', 'false', 'habilitada pero con el interruptor apagado, la tienda sigue cerrada');
select is(public.tienda_estado() ->> 'habilitada', 'true', 'y se ve que está habilitada');
select pg_temp.como('00000000-0000-0000-0000-0000000009c1');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'al_recoger')$f$,
                          pg_temp.manana('11:00'), pg_temp.manana('11:30')), '%no estamos recibiendo pedidos%', 'con el interruptor apagado no se crean pedidos');
select throws_ok($$select public.fijar_pedidos_web(true)$$, '42501', null, 'un cliente no maneja el interruptor');

-- El personal (sin PIN ni dueño) lo enciende al abrir la tienda
select pg_temp.como('00000000-0000-0000-0000-0000000009ca');
select is(public.fijar_pedidos_web(true) ->> 'abierta', 'true', 'el personal enciende el interruptor');
select is((select count(*) from public.auditoria where accion = 'fijar_pedidos_web'), 1::bigint, 'queda en la auditoría');
select pg_temp.anon();
select is(public.tienda_estado() ->> 'abierta', 'true', 'ahora la tienda recibe pedidos, sin importar la hora');

-- ---------------------------------------------------------------------------------------------
-- 2. Creación: el servidor reprecia, valida ventana, pago y cortesía
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000009c1');
select is(public.mi_tienda() ->> 'cortesia_disponible', 'true', 'la cuenta tiene cortesía disponible');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, now() + interval '5 minutes', now() + interval '25 minutes', 'al_recoger')$f$),
                   '%al menos 20 minutos%', 'no se pide para dentro de menos de 20 minutos');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'al_recoger')$f$,
                          pg_temp.manana('11:00'), pg_temp.manana('13:00')), '%máximo 60 minutos%', 'la ventana tiene tope de duración');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'en_linea')$f$,
                          pg_temp.manana('11:00'), pg_temp.manana('11:30')), '%pago en línea todavía no está disponible%', 'el pago en línea no responde con la bandera de Bold apagada');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[]'::jsonb, %L, %L, 'al_recoger')$f$,
                          pg_temp.manana('11:00'), pg_temp.manana('11:30')), '%no tiene productos%', 'un pedido vacío no se crea');
select throws_ok(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"no-existe"}]'::jsonb, %L, %L, 'al_recoger')$f$,
                        pg_temp.manana('11:00'), pg_temp.manana('11:30')), 'P0001', null, 'un producto inexistente se rechaza');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'al_recoger', array['miel'])$f$,
                          pg_temp.manana('11:00'), pg_temp.manana('11:30')), '%va con un bowl%', 'la cortesía exige un bowl en el pedido');
select is((select count(*) from public.pedidos_web), 0::bigint, 'los intentos fallidos no dejan pedidos a medias');

insert into ids select 'idem1', gen_random_uuid()::text;
insert into ids select 'p1', (public.crear_pedido_web(pg_temp.id('idem1'),
  '[{"producto":"amazonas","tamano":"pequeno","toppings":["miel"],"cantidad":2},{"producto":"latte"}]'::jsonb,
  pg_temp.manana('11:00'), pg_temp.manana('11:30'), 'al_recoger', array['avena'], '  sin canela  ') ->> 'id');
select is((select estado from public.pedidos_web where id = pg_temp.id('p1')), 'recibido', 'el pedido queda Recibido');
select is((select nota from public.pedidos_web where id = pg_temp.id('p1')), 'sin canela', 'con la nota sin espacios sobrantes');
select is((select total_cop from public.pedidos_web where id = pg_temp.id('p1')),
          (select 2 * (t.precio_cop + tp.precio_cop) + p.precio_fijo_cop
             from public.tamanos t, public.toppings tp, public.productos p
            where t.clave = 'pequeno' and tp.clave = 'miel' and p.clave = 'latte')::integer, 'el total lo calcula el servidor con el catálogo');
select matches((select codigo from public.pedidos_web where id = pg_temp.id('p1')), '^[A-HJKMNP-Z2-9]{4}$', 'el código tiene 4 caracteres sin letras confusas');
select is((select cortesia_toppings from public.pedidos_web where id = pg_temp.id('p1')), array['avena'], 'queda registrada la cortesía');
select is(public.crear_pedido_web(pg_temp.id('idem1'), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('12:00'), pg_temp.manana('12:30'), 'al_recoger') ->> 'repetido', 'true',
          'reenviar con la misma clave devuelve el pedido sin duplicarlo');
select is((select count(*) from public.pedidos_web), 1::bigint, 'sigue habiendo un solo pedido');
select is(jsonb_array_length(public.mis_pedidos_web()), 1, 'la clienta ve su pedido');
select is(public.mis_pedidos_web() -> 0 ->> 'codigo', (select codigo from public.pedidos_web where id = pg_temp.id('p1')), 'y ve su código');

-- Máximo de abiertos (2)
insert into ids select 'p2', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('12:00'), pg_temp.manana('12:30'), 'al_recoger') ->> 'id');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'al_recoger')$f$,
                          pg_temp.manana('13:00'), pg_temp.manana('13:30')), '%Ya tienes 2 pedido(s) abierto(s)%', 'el tercer pedido abierto se rechaza');

-- Otra clienta no ve ni toca pedidos ajenos
select pg_temp.como('00000000-0000-0000-0000-0000000009c2');
select is(jsonb_array_length(public.mis_pedidos_web()), 0, 'otra cuenta no ve pedidos ajenos');
select throws_like(format($f$select public.voy_en_camino(%L)$f$, pg_temp.id('p1')), '%No encontramos ese pedido%', 'ni avisa "voy en camino" por otra cuenta');
select throws_like(format($f$select public.cancelar_mi_pedido_web(%L)$f$, pg_temp.id('p1')), '%No encontramos ese pedido%', 'ni cancela pedidos ajenos');
set local role authenticated;
select is((select count(*) from public.pedidos_web), 0::bigint, 'el cliente no ve filas de la tabla de pedidos (RLS), ni los suyos');
select throws_ok($$insert into public.pedidos_web (idempotency_key, cliente_id, metodo_pago, codigo, ventana_inicio, ventana_fin, subtotal_cop, total_cop) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000009c2', 'al_recoger', 'ABCD', now(), now() + interval '1 hour', 0, 0)$$,
                 '42501', null, 'ni escribe directo');
reset role;
select throws_ok($$select public.entregar_pedido_web(gen_random_uuid(), 'ABCD', 'efectivo', 1000)$$, '42501', null, 'el cliente no entrega pedidos');

-- ---------------------------------------------------------------------------------------------
-- 3. Voy en camino y cancelación del cliente
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000009c1');
select isnt(public.voy_en_camino(pg_temp.id('p1')) ->> 'en_camino_en', null, '"Voy en camino" queda registrado');
select lives_ok(format($f$select public.cancelar_mi_pedido_web(%L)$f$, pg_temp.id('p2')), 'el cliente cancela un pedido Recibido');
select is((select estado from public.pedidos_web where id = pg_temp.id('p2')), 'cancelado', 'queda cancelado');
select throws_like(format($f$select public.cancelar_mi_pedido_web(%L)$f$, pg_temp.id('p2')), '%en preparación o cerrado%', 'no se cancela dos veces');

-- ---------------------------------------------------------------------------------------------
-- 4. Personal: bandeja, estados y entrega
-- ---------------------------------------------------------------------------------------------
select pg_temp.como('00000000-0000-0000-0000-0000000009ca');
select is(jsonb_array_length(public.pedidos_web_abiertos()), 2, 'el vendedor ve el abierto y el cancelado de hoy');
select is(public.pedidos_web_abiertos() -> 0 ? 'codigo', false, 'la bandeja no trae el código del cliente');
select is(public.pedidos_web_abiertos() -> 0 ->> 'nombre_pila', 'Ana', 'trae solo el nombre de pila');
select throws_like(format($f$select public.entregar_pedido_web(%L, 'ZZZZ', 'efectivo', 100000)$f$, pg_temp.id('p1')), '%código no coincide%', 'con un código errado no se entrega');
select throws_like(format($f$select public.entregar_pedido_web(%L, %L)$f$, pg_temp.id('p1'), (select codigo from public.pedidos_web where id = pg_temp.id('p1'))), '%Registra cómo pagó%', 'al entregar se registra el pago');
select throws_like(format($f$select public.entregar_pedido_web(%L, %L, 'efectivo', 1000)$f$, pg_temp.id('p1'), (select codigo from public.pedidos_web where id = pg_temp.id('p1'))), '%no alcanza%', 'el efectivo debe alcanzar');
select throws_like(format($f$select public.cambiar_estado_pedido_web(%L, 'entregado')$f$, pg_temp.id('p1')), '%Estado no válido%', 'el estado Entregado solo se logra entregando');
select is(public.cambiar_estado_pedido_web(pg_temp.id('p1'), 'preparando') ->> 'estado', 'preparando', 'pasa a Preparando');
select throws_like(format($f$select public.cambiar_estado_pedido_web(%L, 'preparando')$f$, pg_temp.id('p1')), '%no se puede pasar%', 'no repite estado');
select is(public.cambiar_estado_pedido_web(pg_temp.id('p1'), 'listo') ->> 'estado', 'listo', 'pasa a Listo');
select is((select (e ->> 'pedido_web_listo')::boolean from jsonb_array_elements(public.lista_espera()) e limit 1), null, 'sin check-in no hay marca en la espera');
select throws_like(format($f$select public.marcar_no_llego(%L)$f$, pg_temp.id('p1')), '%termina más tarde%', 'no se marca "No llegó" antes de que termine la ventana');

-- Puntos: solo al entregar y pagar
select is((select count(*) from public.puntos_libro where cliente_id = '00000000-0000-0000-0000-0000000009c1'), 0::bigint, 'antes de entregar no hay puntos');
select is(public.entregar_pedido_web(pg_temp.id('p1'), lower((select codigo from public.pedidos_web where id = pg_temp.id('p1'))), 'efectivo', 100000) ->> 'estado', 'entregado',
          'se entrega con el código (sin importar mayúsculas)');
select is((select estado from public.pedidos_web where id = pg_temp.id('p1')), 'entregado', 'el pedido queda Entregado');
select is((select canal from public.ventas where id = (select venta_id from public.pedidos_web where id = pg_temp.id('p1'))), 'web', 'se creó una venta de canal web');
select is((select estado from public.ventas where id = (select venta_id from public.pedidos_web where id = pg_temp.id('p1'))), 'pagada', 'ya pagada');
select is((select total_cop from public.ventas where id = (select venta_id from public.pedidos_web where id = pg_temp.id('p1'))),
          (select total_cop from public.pedidos_web where id = pg_temp.id('p1')), 'por el mismo total del pedido');
select is((select count(*) from public.venta_lineas where venta_id = (select venta_id from public.pedidos_web where id = pg_temp.id('p1'))), 2::bigint, 'con las mismas líneas');
select cmp_ok((select coalesce(sum(puntos), 0) from public.puntos_libro where cliente_id = '00000000-0000-0000-0000-0000000009c1' and tipo = 'suma'), '>', 0::bigint,
              'los puntos se acreditan al entregar y pagar');
select throws_like(format($f$select public.entregar_pedido_web(%L, %L, 'efectivo', 100000)$f$, pg_temp.id('p1'), (select codigo from public.pedidos_web where id = pg_temp.id('p1'))), '%ya se entregó%', 'se entrega una sola vez');
select is((select count(*) from public.ventas where canal = 'web'), 1::bigint, 'sigue habiendo una sola venta web');
set local role authenticated;
select throws_ok(format($f$update public.pedidos_web set estado = 'recibido' where id = %L$f$, pg_temp.id('p1')), '42501', null, 'el personal no escribe directo en pedidos');
reset role;

-- ---------------------------------------------------------------------------------------------
-- 5. "No llegó" y señalamiento de la cuenta
-- ---------------------------------------------------------------------------------------------
-- Tres pedidos de Beto con la ventana ya vencida (se retroceden las horas como superusuario)
reset role;
select pg_temp.como('00000000-0000-0000-0000-0000000009c2');
insert into ids select 'b1', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('11:00'), pg_temp.manana('11:30'), 'al_recoger') ->> 'id');
insert into ids select 'b2', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('12:00'), pg_temp.manana('12:30'), 'al_recoger') ->> 'id');
reset role;
alter table public.pedidos_web disable trigger pedidos_web_transicion;
update public.pedidos_web set ventana_inicio = now() - interval '2 hours', ventana_fin = now() - interval '1 hour' where id in (pg_temp.id('b1'), pg_temp.id('b2'));
alter table public.pedidos_web enable trigger pedidos_web_transicion;

select pg_temp.como('00000000-0000-0000-0000-0000000009ca');
select is(public.marcar_no_llego(pg_temp.id('b1')) ->> 'cuenta_senalada', 'false', 'el primer "No llegó" no señala la cuenta');
select is((select estado from public.pedidos_web where id = pg_temp.id('b1')), 'no_llego', 'queda No llegó');
select throws_like(format($f$select public.marcar_no_llego(%L)$f$, pg_temp.id('b1')), '%no se puede marcar%', 'no se marca dos veces');

-- Beto sigue pudiendo pedir (aún no llega al umbral), y llega a 3 con otros dos
select pg_temp.como('00000000-0000-0000-0000-0000000009c2');
insert into ids select 'b3', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('14:00'), pg_temp.manana('14:30'), 'al_recoger') ->> 'id');
reset role;
alter table public.pedidos_web disable trigger pedidos_web_transicion;
update public.pedidos_web set ventana_inicio = now() - interval '2 hours', ventana_fin = now() - interval '1 hour' where id = pg_temp.id('b3');
alter table public.pedidos_web enable trigger pedidos_web_transicion;
select pg_temp.como('00000000-0000-0000-0000-0000000009ca');
select public.marcar_no_llego(pg_temp.id('b2'));
select is(public.marcar_no_llego(pg_temp.id('b3')) ->> 'cuenta_senalada', 'true', 'al tercer "No llegó" la cuenta queda señalada');
select is((select count(*) from public.alertas where tipo = 'no_llego' and cliente_id = '00000000-0000-0000-0000-0000000009c2' and resuelta_en is null), 1::bigint, 'con una alerta abierta para el dueño');

-- El dueño decide: bloqueo
select throws_ok(format($f$select public.restringir_pedidos_web(%L, 'bloqueo', 'prueba', '1234')$f$, '00000000-0000-0000-0000-0000000009c2'), '42501', null, 'el cajero no restringe cuentas');
select pg_temp.como('00000000-0000-0000-0000-0000000009d0');
select public.fijar_pin('4321');
select is(public.restringir_pedidos_web('00000000-0000-0000-0000-0000000009c2', 'bloqueo', 'tres no llegó', '9999') ->> 'error', 'pin_incorrecto', 'con un PIN errado no se restringe');
select is(public.restringir_pedidos_web('00000000-0000-0000-0000-0000000009c2', 'bloqueo', 'tres no llegó', '4321') ->> 'ok', 'true', 'con el PIN correcto sí');
select is((select count(*) from public.alertas where tipo = 'no_llego' and resuelta_en is null), 0::bigint, 'y la alerta queda resuelta');
select pg_temp.como('00000000-0000-0000-0000-0000000009c2');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'al_recoger')$f$, pg_temp.manana('15:00'), pg_temp.manana('15:30')),
                   '%no podemos recibir pedidos web de esta cuenta%', 'una cuenta bloqueada no pide');
select pg_temp.como('00000000-0000-0000-0000-0000000009d0');
select public.restringir_pedidos_web('00000000-0000-0000-0000-0000000009c2', 'prepago', 'prueba', '4321');
select pg_temp.como('00000000-0000-0000-0000-0000000009c2');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, %L, %L, 'al_recoger')$f$, pg_temp.manana('15:00'), pg_temp.manana('15:30')),
                   '%se pagan en línea%', 'con prepago no se acepta pagar al recoger');

-- ---------------------------------------------------------------------------------------------
-- 6. Cortesía "solo la primera vez" y pago en línea (bandera encendida)
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.regla('pedido_web.topping_cortesia', '{"activo":true,"cantidad":1,"solo_primera_vez":true}'::jsonb);
select pg_temp.como('00000000-0000-0000-0000-0000000009c3');
select is(public.mi_tienda() ->> 'cortesia_disponible', 'true', 'primera vez: la cortesía está disponible');
insert into ids select 'c1', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"amazonas","tamano":"pequeno"}]'::jsonb, pg_temp.manana('11:00'), pg_temp.manana('11:30'), 'al_recoger', array['miel']) ->> 'id');
select is(public.mi_tienda() ->> 'cortesia_disponible', 'false', 'con una cortesía en curso ya no hay otra (solo la primera vez)');
select throws_like(format($f$select public.crear_pedido_web(gen_random_uuid(), '[{"producto":"amazonas","tamano":"pequeno"}]'::jsonb, %L, %L, 'al_recoger', array['miel'])$f$,
                          pg_temp.manana('12:00'), pg_temp.manana('12:30')), '%cortesía no está disponible%', 'y el servidor la rechaza');
select lives_ok(format($f$select public.cancelar_mi_pedido_web(%L)$f$, pg_temp.id('c1')), 'si cancela, la cortesía no se gastó');
select is(public.mi_tienda() ->> 'cortesia_disponible', 'true', 'y vuelve a estar disponible');

reset role;
update public.banderas set activa = true where clave = 'pago_en_linea_bold';
select pg_temp.anon();
select is(public.tienda_estado() -> 'pagos' ->> 'en_linea', 'true', 'con la bandera de Bold encendida se ofrece el pago en línea');
select pg_temp.como('00000000-0000-0000-0000-0000000009c3');
insert into ids select 'c2', (public.crear_pedido_web(gen_random_uuid(), '[{"producto":"latte"}]'::jsonb, pg_temp.manana('13:00'), pg_temp.manana('13:30'), 'en_linea') ->> 'id');
select is((select pago_en_linea_estado from public.pedidos_web where id = pg_temp.id('c2')), 'pendiente', 'el pedido en línea queda con el pago pendiente');
select pg_temp.como('00000000-0000-0000-0000-0000000009ca');
select throws_like(format($f$select public.entregar_pedido_web(%L, %L, 'efectivo', 100000)$f$, pg_temp.id('c2'), (select codigo from public.pedidos_web where id = pg_temp.id('c2'))),
                   '%todavía no aparece pagado%', 'un pedido en línea sin pago confirmado no se entrega');
select pg_temp.como('00000000-0000-0000-0000-0000000009c3');
select lives_ok(format($f$select public.cancelar_mi_pedido_web(%L)$f$, pg_temp.id('c2')), 'el cliente cancela su pedido en línea aún sin pagar');

select * from finish();
rollback;
