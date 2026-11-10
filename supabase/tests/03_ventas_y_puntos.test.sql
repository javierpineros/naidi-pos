-- H3: máquina de estados de la venta, libro de puntos, canje, QR posterior, venta sin cliente / sin internet
-- y permisos por rol. Los puntos y los precios los calcula siempre el servidor.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ----------------------------------------------------------------------------------------------
-- Datos de prueba (sin datos reales)
-- ----------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'cliente1@prueba.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated', 'cliente2@prueba.test'),
  ('00000000-0000-0000-0000-0000000000ca', 'authenticated', 'authenticated', 'cajero@prueba.test'),
  ('00000000-0000-0000-0000-0000000000d0', 'authenticated', 'authenticated', 'dueno@prueba.test');
insert into public.perfiles (user_id, nombre) values
  ('00000000-0000-0000-0000-0000000000c1', 'Cliente Uno'),
  ('00000000-0000-0000-0000-0000000000c2', 'Cliente Dos')
on conflict (user_id) do update set nombre = excluded.nombre;
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000000ca', 'cajero', 'Cajero Prueba'),
  ('00000000-0000-0000-0000-0000000000d0', 'dueno',  'Dueño Prueba');
insert into private.staff_pin (user_id, pin_hash)
values ('00000000-0000-0000-0000-0000000000d0', extensions.crypt('2468', extensions.gen_salt('bf', 4)));

create temp table ids (k text primary key, v text);
grant all on ids to public;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
create function pg_temp.como(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true) $$;

create temp table r (k text primary key, n bigint, s text);
grant all on r to public;
create function pg_temp.contar(p_k text, p_q text) returns void language plpgsql as $$
declare v bigint;
begin execute p_q into v; insert into r (k, n) values (p_k, v); end $$;
create function pg_temp.intentar(p_k text, p_q text) returns void language plpgsql as $$
begin execute p_q; insert into r (k, s) values (p_k, 'ok');
exception when others then insert into r (k, s) values (p_k, sqlstate); end $$;

-- Esta prueba cubre el regalo como descuento en un bowl (los otros formatos van en 04_regalo_y_rappi).
-- Se fija la regla directamente (solo posible aquí, como postgres, saltando el trigger de versionado).
alter table public.reglas_negocio disable trigger reglas_solo_cerrar;
update public.reglas_negocio set valor = '{"tipo":"descuento_linea","descuento_pct":20,"tamanos":["mini","pequeno","mediano","grande"]}'::jsonb
 where clave = 'bienvenida.regalo' and vigente_hasta is null;
alter table public.reglas_negocio enable trigger reglas_solo_cerrar;

-- =============================================================================================
-- 1. Venta con cliente: armado, regalo de bienvenida, confirmación y cancelación
-- =============================================================================================
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');
insert into ids select 'v1', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1')::text;
select is((select estado from public.ventas where id = pg_temp.id('v1')), 'alistando', 'la venta nace en alistando');
select is((select count(*) from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000000c1' and tipo = 'bienvenida'),
  1::bigint, 'el cliente nuevo recibe su regalo de bienvenida');
insert into ids select 'w_bien', id::text from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000000c1' and tipo = 'bienvenida';

insert into ids select 'l_pers', public.agregar_linea(pg_temp.id('v1'), 'bowl-personalizado', 'mediano', null, 'mango',
  array['banano','fresa','mango','kiwi','avena','chia'])::text;
insert into ids select 'l_menu', public.agregar_linea(pg_temp.id('v1'), 'amazonas', 'pequeno', 'smoothie', null, array['miel'])::text;
insert into ids select 'l_cafe', public.agregar_linea(pg_temp.id('v1'), 'espresso')::text;

select is((select precio_unitario_cop from public.venta_lineas where id = pg_temp.id('l_pers')), 19700,
  'personalizado Mediano: 18.200 + 1 topping extra (el 6.º, chía 1.500) = 19.700');
select is((select precio_unitario_cop from public.venta_lineas where id = pg_temp.id('l_menu')), 17800,
  'menú Pequeño: 16.300 + miel 1.500 (en el menú todo topping cuesta) = 17.800');
select is((select precio_unitario_cop from public.venta_lineas where id = pg_temp.id('l_cafe')), 2500, 'café espresso: precio fijo 2.500');
select is((select subtotal_cop from public.ventas where id = pg_temp.id('v1')), 40000, 'subtotal calculado por el servidor');
select is((select presentacion from public.venta_lineas where id = pg_temp.id('l_menu')), 'smoothie', 'la presentación queda guardada');

select throws_ok(format($f$select public.agregar_linea(%L, 'espresso', 'grande')$f$, pg_temp.id('v1')), 'P0001', null, 'un café no lleva tamaño');
select throws_ok(format($f$select public.agregar_linea(%L, 'amazonas')$f$, pg_temp.id('v1')), 'P0001', null, 'un bowl exige tamaño');
select throws_ok(format($f$select public.agregar_linea(%L, 'amazonas', 'pequeno', null, null, array['no-existe'])$f$, pg_temp.id('v1')), 'P0001', null, 'topping inexistente');
select throws_ok(format($f$select public.confirmar_venta(%L)$f$, public.crear_venta(gen_random_uuid())), 'P0001', null, 'no se confirma una venta vacía');

select lives_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l_menu'), pg_temp.id('w_bien')), 'se aplica el regalo a un bowl');
select is((select descuento_cop from public.ventas where id = pg_temp.id('v1')), 3560, 'regalo de bienvenida: 20% de 17.800 = 3.560');
select is((select total_cop from public.ventas where id = pg_temp.id('v1')), 36440, 'total con regalo');
select is((select estado from public.vouchers where id = pg_temp.id('w_bien')), 'reservado', 'el regalo queda reservado mientras se alista');

select is((public.confirmar_venta(pg_temp.id('v1')) ->> 'total_cop')::integer, 36440, 'confirmar devuelve el total');
select is((select estado from public.ventas where id = pg_temp.id('v1')), 'confirmada', 'venta confirmada');
select is((select estado from public.vouchers where id = pg_temp.id('w_bien')), 'usado', 'el regalo se consume al confirmar');

select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select is(public.mi_saldo(), 0, 'confirmada no suma puntos: solo al pasar a Pagada');
select is((public.mi_compra_en_curso() ->> 'estado'), 'confirmada', 'el cliente ve su compra "por pagar"');
select is((public.mi_compra_en_curso() ->> 'total_cop')::integer, 36440, 'el cliente ve el total');
select is(jsonb_array_length(public.mi_compra_en_curso() -> 'lineas'), 3, 'el cliente ve el detalle');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');

select throws_ok(format($f$select public.cancelar_venta(%L, '  ')$f$, pg_temp.id('v1')), 'P0001', null, 'cancelar exige un motivo');
select lives_ok(format($f$select public.cancelar_venta(%L, 'El cliente se arrepintió')$f$, pg_temp.id('v1')), 'se cancela una venta confirmada con motivo');
select is((select estado from public.ventas where id = pg_temp.id('v1')), 'cancelada', 'venta cancelada');
select is((select estado from public.vouchers where id = pg_temp.id('w_bien')), 'activo', 'cancelar devuelve el regalo al cliente');
select throws_ok(format($f$select public.agregar_linea(%L, 'espresso')$f$, pg_temp.id('v1')), 'P0001', null, 'una venta cancelada no admite productos');

-- =============================================================================================
-- 2. Pago: puntos solo al pasar a Pagada, efectivo con cambio, un solo cobro
-- =============================================================================================
insert into ids select 'v2', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1')::text;
select is((select count(*) from public.vouchers where cliente_id = '00000000-0000-0000-0000-0000000000c1' and tipo = 'bienvenida'),
  1::bigint, 'el regalo de bienvenida es uno por cuenta');
insert into ids select 'l2_pers', public.agregar_linea(pg_temp.id('v2'), 'bowl-personalizado', 'mediano', null, 'mango', array['banano','fresa','mango','kiwi','avena','chia'])::text;
insert into ids select 'l2_menu', public.agregar_linea(pg_temp.id('v2'), 'amazonas', 'pequeno', 'bowl', null, array['miel'])::text;
insert into ids select 'l2_cafe', public.agregar_linea(pg_temp.id('v2'), 'espresso')::text;
select public.aplicar_voucher(pg_temp.id('l2_menu'), pg_temp.id('w_bien'));
select public.confirmar_venta(pg_temp.id('v2'));

select throws_ok(format($f$select public.pagar_venta(%L, 'efectivo', 30000)$f$, pg_temp.id('v2')), 'P0001', null, 'el efectivo debe alcanzar para el total');
select throws_ok(format($f$select public.pagar_venta(%L, 'cheque')$f$, pg_temp.id('v2')), 'P0001', null, 'medio de pago no válido');
select throws_ok(format($f$select public.pagar_venta(%L, 'transferencia', 100)$f$, pg_temp.id('v2')), 'P0001', null, 'el efectivo recibido solo va con pago en efectivo');
select throws_ok(format($f$select public.pagar_venta(%L, 'bold_online')$f$, pg_temp.id('v2')), '42501', null, 'el POS no registra pagos en línea (los registra el servidor)');
select is((select count(*) from public.puntos_libro where venta_id = pg_temp.id('v2')), 0::bigint, 'sin pago no hay puntos');

insert into ids select 'pago2', public.pagar_venta(pg_temp.id('v2'), 'efectivo', 50000)::text;
select is((select (v::jsonb ->> 'cambio_cop')::integer from ids where k = 'pago2'), 13560, 'cambio = 50.000 - 36.440');
select is((select (v::jsonb ->> 'puntos_acreditados')::integer from ids where k = 'pago2'), 36, 'puntos = floor(36.440 / 1.000), sobre lo realmente pagado');
select is((select v::jsonb -> 'qr_token' from ids where k = 'pago2'), 'null'::jsonb, 'con cliente no se emite QR posterior');
select is((select estado from public.ventas where id = pg_temp.id('v2')), 'pagada', 'venta pagada');
select is((select medio_pago from public.ventas where id = pg_temp.id('v2')), 'efectivo', 'medio de pago registrado');
select is((select puntos from public.puntos_libro where venta_id = pg_temp.id('v2') and tipo = 'suma'), 36, 'movimiento de suma en el libro');
select ok((select regla_versiones ? 'puntos.cop_por_punto' from public.puntos_libro where venta_id = pg_temp.id('v2') and tipo = 'suma'),
  'el movimiento guarda la versión de la regla usada');
select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select is(public.mi_saldo(), 36, 'el cliente ve su saldo');
select is((public.mi_compra_en_curso() ->> 'estado'), 'pagada', 'el cliente ve "Pagado"');
select is((public.mi_compra_en_curso() ->> 'puntos_ganados')::integer, 36, 'y sus puntos nuevos');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');

select throws_ok(format($f$select public.pagar_venta(%L, 'efectivo', 50000)$f$, pg_temp.id('v2')), 'P0001', null, 'una venta no se cobra dos veces');
select throws_ok(format($f$select public.cancelar_venta(%L, 'x')$f$, pg_temp.id('v2')), 'P0001', null, 'una venta pagada no se cancela: se anula');
select throws_ok(format($f$insert into public.puntos_libro (cliente_id, tipo, puntos, venta_id) values ('00000000-0000-0000-0000-0000000000c1','suma',5,%L)$f$, pg_temp.id('v2')),
  '23505', null, 'el libro admite una sola suma por venta (restricción única)');

-- Transiciones y datos congelados
select throws_ok(format($f$update public.ventas set estado = 'confirmada' where id = %L$f$, pg_temp.id('v2')), '23001', null, 'no hay vuelta atrás de Pagada a Confirmada');
select throws_ok(format($f$update public.ventas set subtotal_cop = 1, total_cop = 1, descuento_cop = 0 where id = %L$f$, pg_temp.id('v2')), '23001', null, 'los montos de una venta pagada no se tocan');
select throws_ok(format($f$update public.venta_lineas set cantidad = 3 where id = %L$f$, pg_temp.id('l2_cafe')), '23001', null, 'las líneas de una venta confirmada o pagada no se tocan');
select throws_ok(format($f$delete from public.venta_lineas where id = %L$f$, pg_temp.id('l2_cafe')), '23001', null, 'ni se borran');
select throws_ok($$update public.puntos_libro set puntos = 999$$, '23001', null, 'el libro de puntos es inmutable (update)');
select throws_ok($$delete from public.puntos_libro$$, '23001', null, 'el libro de puntos es inmutable (delete)');
select throws_ok($$update public.venta_eventos set motivo = 'x'$$, '23001', null, 'los eventos de venta son inmutables');
select is((select string_agg(a_estado, '>' order by id) from public.venta_eventos where venta_id = pg_temp.id('v2')), 'alistando>confirmada>pagada', 'historial de estados de la venta');

-- =============================================================================================
-- 3. Anulación: solo el dueño; revierte los puntos con un movimiento contrario
-- =============================================================================================
select throws_ok(format($f$select public.anular_venta(%L, 'error de digitación', '2468')$f$, pg_temp.id('v2')), '42501', null, 'el cajero no anula una venta pagada');
select pg_temp.como('00000000-0000-0000-0000-0000000000d0');
select throws_ok(format($f$select public.anular_venta(%L, '', '2468')$f$, pg_temp.id('v2')), 'P0001', null, 'anular exige motivo');
select is((public.anular_venta(pg_temp.id('v2'), 'error de digitación', '2468') ->> 'puntos_revertidos')::integer, 36, 'el dueño anula y se revierten 36 puntos');
select is((select estado from public.ventas where id = pg_temp.id('v2')), 'anulada', 'venta anulada');
select is((select puntos from public.puntos_libro where venta_id = pg_temp.id('v2') and tipo = 'anulacion'), -36, 'movimiento contrario en el libro');
select is((select count(*) from public.puntos_libro where venta_id = pg_temp.id('v2')), 2::bigint, 'el libro conserva la suma original y la anulación');
select throws_ok(format($f$select public.anular_venta(%L, 'otra vez', '2468')$f$, pg_temp.id('v2')), 'P0001', null, 'no se anula dos veces');
select is((select estado from public.vouchers where id = pg_temp.id('w_bien')), 'activo', 'anular devuelve el regalo');
select is((select count(*) from public.auditoria where accion = 'anular_venta' and entidad_id = pg_temp.id('v2')::text), 1::bigint, 'la anulación queda en la auditoría');
select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select is(public.mi_saldo(), 0, 'el saldo vuelve a 0 tras la anulación');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');

-- =============================================================================================
-- 4. Canje de premio
-- =============================================================================================
insert into public.puntos_libro (cliente_id, tipo, puntos, nota) values ('00000000-0000-0000-0000-0000000000c1', 'bono', 130, 'prueba');
select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select throws_ok($$select public.canjear_premio('mini')$$, 'P0001', null, 'el Mini no entra en el premio');
select throws_ok($$select public.canjear_premio('grande')$$, 'P0001', null, 'con 130 puntos no alcanza para el Grande (140)');
insert into ids select 'canje', public.canjear_premio('mediano')::text;
select is((select (v::jsonb ->> 'puntos_descontados')::integer from ids where k = 'canje'), 130, 'canje del Mediano: 130 puntos');
select is(public.mi_saldo(), 0, 'se descuentan los puntos');
select throws_ok($$select public.canjear_premio('mediano')$$, 'P0001', null, 'sin saldo no hay segundo canje');
select is(jsonb_array_length(public.mis_vouchers()), 2, 'el cliente tiene el regalo y el premio');
select is((select count(*) from public.puntos_libro where tipo = 'canje' and voucher_id = (select v::jsonb ->> 'voucher_id' from ids where k = 'canje')::uuid),
  1::bigint, 'un canje por voucher en el libro');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');
insert into ids select 'w_premio', (v::jsonb ->> 'voucher_id') from ids where k = 'canje';

insert into ids select 'v3', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1')::text;
insert into ids select 'l3_med', public.agregar_linea(pg_temp.id('v3'), 'bowl-personalizado', 'mediano', null, 'banano', array[]::text[])::text;
insert into ids select 'l3_peq', public.agregar_linea(pg_temp.id('v3'), 'carioca', 'pequeno')::text;
select is(jsonb_array_length(public.vouchers_activos_de('00000000-0000-0000-0000-0000000000c1')), 2, 'el POS ve los premios listos del cliente');
select throws_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l3_peq'), pg_temp.id('w_premio')), 'P0001', null, 'el premio del Mediano no aplica a un Pequeño');
update public.vouchers set vence_en = now() - interval '1 day' where id = pg_temp.id('w_bien');
select throws_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l3_med'), pg_temp.id('w_bien')), 'P0001', null, 'un premio vencido no se aplica');
update public.vouchers set vence_en = now() + interval '10 days' where id = pg_temp.id('w_bien');
select lives_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l3_med'), pg_temp.id('w_premio')), 'el premio se aplica al Mediano');
select is((select descuento_cop from public.venta_lineas where id = pg_temp.id('l3_med')), 9100, 'premio: 50% de 18.200');
select throws_ok(format($f$select public.aplicar_voucher(%L, %L)$f$, pg_temp.id('l3_med'), pg_temp.id('w_bien')), 'P0001', null, 'una línea admite un solo premio');
select public.quitar_voucher(pg_temp.id('l3_med'));
select is((select estado from public.vouchers where id = pg_temp.id('w_premio')), 'activo', 'quitar el premio lo libera');
select public.aplicar_voucher(pg_temp.id('l3_med'), pg_temp.id('w_premio'));
select public.quitar_linea(pg_temp.id('l3_peq'));
select public.confirmar_venta(pg_temp.id('v3'));
select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select is((public.mi_compra_en_curso() ->> 'total_cop')::integer, 9100, 'el cliente ve el total con el premio');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');
select is((public.pagar_venta(pg_temp.id('v3'), 'datafono_bold') ->> 'puntos_acreditados')::integer, 9, 'puntos sobre lo pagado con el premio: 9.100 -> 9');
select is((select estado from public.vouchers where id = pg_temp.id('w_premio')), 'usado', 'el premio queda consumido');

-- =============================================================================================
-- 5. Venta sin cliente y QR posterior
-- =============================================================================================
insert into ids select 'v4', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v4'), 'espresso');
select public.confirmar_venta(pg_temp.id('v4'));
insert into ids select 'pago4', public.pagar_venta(pg_temp.id('v4'), 'transferencia')::text;
insert into ids select 'tok4', (v::jsonb ->> 'qr_token') from ids where k = 'pago4';
select is(length((select v from ids where k = 'tok4')), 64, 'el token tiene 256 bits (64 caracteres hex)');
select is((select count(*) from public.qr_posventa where token_hash = extensions.digest((select v from ids where k = 'tok4'), 'sha256')), 1::bigint,
  'en la base solo vive el hash del token');
select is((select count(*) from public.qr_posventa where encode(token_hash, 'hex') = (select v from ids where k = 'tok4')), 0::bigint, 'el token en claro no se guarda');
select ok((select vence_en from public.qr_posventa where venta_id = pg_temp.id('v4')) <= now() + interval '30 minutes 1 second', 'el QR vence en 30 minutos');
select is((select puntos from public.puntos_libro where venta_id = pg_temp.id('v4')), null, 'sin cliente no hay puntos todavía');

select pg_temp.como('00000000-0000-0000-0000-0000000000c2');
select throws_ok($$select public.reclamar_qr_posventa('abc')$$, 'P0001', null, 'un token mal formado no sirve');
select throws_ok(format($f$select public.reclamar_qr_posventa(%L)$f$, repeat('0', 64)), 'P0001', null, 'un token inexistente no sirve');
select is((public.reclamar_qr_posventa((select v from ids where k = 'tok4')) ->> 'puntos_acreditados')::integer, 2, 'el cliente reclama: 2.500 -> 2 puntos');
select is((select cliente_id from public.ventas where id = pg_temp.id('v4')), '00000000-0000-0000-0000-0000000000c2'::uuid, 'la venta queda a nombre de quien reclamó');
select is(public.mi_saldo(), 2, 'saldo del cliente que reclamó');
select throws_ok(format($f$select public.reclamar_qr_posventa(%L)$f$, (select v from ids where k = 'tok4')), 'P0001', null, 'el QR es de un solo uso (mismo cliente)');
select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select throws_ok(format($f$select public.reclamar_qr_posventa(%L)$f$, (select v from ids where k = 'tok4')), 'P0001', null, 'el QR es de un solo uso (otro cliente)');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');

-- QR vencido
insert into ids select 'v5', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v5'), 'americano');
select public.confirmar_venta(pg_temp.id('v5'));
insert into ids select 'tok5', (public.pagar_venta(pg_temp.id('v5'), 'efectivo', 5000) ->> 'qr_token');
update public.qr_posventa set vence_en = now() - interval '1 minute' where venta_id = pg_temp.id('v5');
select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select throws_ok(format($f$select public.reclamar_qr_posventa(%L)$f$, (select v from ids where k = 'tok5')), 'P0001', null, 'un QR vencido no se reclama');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');

-- QR de una venta anulada
insert into ids select 'v6', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v6'), 'latte');
select public.confirmar_venta(pg_temp.id('v6'));
insert into ids select 'tok6', (public.pagar_venta(pg_temp.id('v6'), 'efectivo', 4000) ->> 'qr_token');
select pg_temp.como('00000000-0000-0000-0000-0000000000d0');
select public.anular_venta(pg_temp.id('v6'), 'se devolvió el pedido', '2468');
select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
select throws_ok(format($f$select public.reclamar_qr_posventa(%L)$f$, (select v from ids where k = 'tok6')), 'P0001', null, 'anular la venta invalida su QR');

-- Anular una venta cuyos puntos ya se reclamaron por QR: se revierten al cliente que los reclamó
select pg_temp.como('00000000-0000-0000-0000-0000000000d0');
select is((public.anular_venta(pg_temp.id('v4'), 'error de cobro', '2468') ->> 'puntos_revertidos')::integer, 2, 'anular revierte los puntos reclamados por QR');
select pg_temp.como('00000000-0000-0000-0000-0000000000c2');
select is(public.mi_saldo(), 0, 'el cliente que reclamó queda en 0');

-- Tope diario de reclamos por cliente
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');
update public.reglas_negocio set vigente_hasta = now() where clave = 'antifraude.max_reclamos_qr_dia' and version = 1;
insert into public.reglas_negocio (clave, version, valor, vigente_desde) values ('antifraude.max_reclamos_qr_dia', 2, '1', now());
insert into ids select 'v7', public.crear_venta(gen_random_uuid())::text;
select public.agregar_linea(pg_temp.id('v7'), 'espresso');
select public.confirmar_venta(pg_temp.id('v7'));
insert into ids select 'tok7', (public.pagar_venta(pg_temp.id('v7'), 'efectivo', 2500) ->> 'qr_token');
select pg_temp.como('00000000-0000-0000-0000-0000000000c2');
select throws_like(format($f$select public.reclamar_qr_posventa(%L)$f$, (select v from ids where k = 'tok7')), '%tope de reclamos%', 'tope diario de reclamos por cliente');
select pg_temp.como('00000000-0000-0000-0000-0000000000ca');

-- =============================================================================================
-- 6. Venta sin internet: sincronización idempotente, sin cliente
-- =============================================================================================
insert into ids values ('k_off', gen_random_uuid()::text);
insert into ids select 'off1', public.registrar_venta_offline(pg_temp.id('k_off'), now() - interval '2 hours',
  '[{"producto":"espresso","cantidad":2},{"producto":"amazonas","tamano":"pequeno","toppings":["miel"]}]'::jsonb, 'efectivo', 30000)::text;
select is((select (v::jsonb ->> 'total_cop')::integer from ids where k = 'off1'), 22800, 'venta offline: total recalculado por el servidor (5.000 + 17.800)');
select is((select (v::jsonb ->> 'cambio_cop')::integer from ids where k = 'off1'), 7200, 'venta offline: cambio');
select is((select estado from public.ventas where id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'off1')), 'pagada', 'la venta offline queda pagada');
select ok((select pagada_en from public.ventas where id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'off1')) < now() - interval '1 hour 50 minutes',
  'conserva la hora en que se vendió, no la de la sincronización');
select is((select creada_offline from public.ventas where id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'off1')), true, 'marcada como creada sin internet');
select is((select cliente_id from public.ventas where id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'off1')), null, 'sin cliente');
insert into ids select 'off2', public.registrar_venta_offline(pg_temp.id('k_off'), now() - interval '2 hours', '[{"producto":"latte"}]'::jsonb, 'efectivo', 99999)::text;
select is((select (v::jsonb ->> 'duplicada')::boolean from ids where k = 'off2'), true, 'reenviar la misma venta no la duplica');
select is((select count(*) from public.ventas where idempotency_key = pg_temp.id('k_off')), 1::bigint, 'una sola venta por clave de idempotencia');
select is((select count(*) from public.venta_lineas where venta_id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'off1')), 2::bigint, 'y sin líneas duplicadas');
select is((select count(*) from public.qr_posventa where venta_id = (select (v::jsonb ->> 'venta_id')::uuid from ids where k = 'off1')), 0::bigint, 'la venta offline no emite QR (no hay conexión para mostrarlo)');
select throws_ok(format($f$select public.registrar_venta_offline(gen_random_uuid(), now() - interval '9 days', '[{"producto":"latte"}]'::jsonb, 'transferencia')$f$),
  'P0001', null, 'una venta de hace más de 7 días no se registra sola');
select throws_ok($$select public.registrar_venta_offline(gen_random_uuid(), now(), '[]'::jsonb, 'transferencia')$$, 'P0001', null, 'sin productos no hay venta');

-- =============================================================================================
-- 7. Permisos por rol
-- =============================================================================================
insert into ids select 'v8', public.crear_venta(gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1')::text;
set local role anon;
select pg_temp.intentar('anon_crear',   $$select public.crear_venta(gen_random_uuid())$$);
select pg_temp.intentar('anon_saldo',   $$select public.mi_saldo()$$);
select pg_temp.intentar('anon_reclamar', $$select public.reclamar_qr_posventa('abc')$$);
select pg_temp.intentar('anon_ventas',  $$select count(*) from public.ventas$$);
reset role;

select pg_temp.como('00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select pg_temp.intentar('cli_crear',    $$select public.crear_venta(gen_random_uuid())$$);
select pg_temp.intentar('cli_pagar',    format($f$select public.pagar_venta(%L, 'efectivo', 99999)$f$, pg_temp.id('v1')));
select pg_temp.intentar('cli_anular',   format($f$select public.anular_venta(%L, 'x', '2468')$f$, pg_temp.id('v3')));
select pg_temp.intentar('cli_offline',  $$select public.registrar_venta_offline(gen_random_uuid(), now(), '[{"producto":"latte"}]'::jsonb, 'transferencia')$$);
select pg_temp.intentar('cli_vouchers_de', $$select public.vouchers_activos_de('00000000-0000-0000-0000-0000000000c1')$$);
select pg_temp.contar('cli_ventas',     'select count(*) from public.ventas');
select pg_temp.contar('cli_lineas',     'select count(*) from public.venta_lineas');
select pg_temp.contar('cli_libro',      'select count(*) from public.puntos_libro');
select pg_temp.contar('cli_vouchers',   'select count(*) from public.vouchers');
select pg_temp.intentar('cli_qr',       'select count(*) from public.qr_posventa');
select pg_temp.intentar('cli_ins_libro', $$insert into public.puntos_libro (cliente_id, tipo, puntos) values ('00000000-0000-0000-0000-0000000000c1','bono',1000)$$);
select pg_temp.intentar('cli_ins_ventas', $$insert into public.ventas (idempotency_key) values (gen_random_uuid())$$);
select pg_temp.intentar('cli_upd_perfil', $$update public.perfiles set nombre = 'x' where user_id <> '00000000-0000-0000-0000-0000000000c1'$$);
select pg_temp.intentar('cli_interna',  $$select private.acreditar_puntos(gen_random_uuid(), gen_random_uuid())$$);
reset role;

select pg_temp.como('00000000-0000-0000-0000-0000000000ca');
set local role authenticated;
select pg_temp.contar('caj_ventas',     'select count(*) from public.ventas');
select pg_temp.contar('caj_libro',      'select count(*) from public.puntos_libro');
select pg_temp.contar('caj_vouchers',   'select count(*) from public.vouchers');
select pg_temp.intentar('caj_qr',       'select count(*) from public.qr_posventa');
select pg_temp.intentar('caj_reclamar', $$select public.reclamar_qr_posventa(repeat('0', 64))$$);
select pg_temp.intentar('caj_canjear',  $$select public.canjear_premio('pequeno')$$);
select pg_temp.intentar('caj_upd_ventas', $$update public.ventas set estado = 'pagada'$$);
select pg_temp.intentar('caj_reasignar', format($f$select public.asignar_cliente(%L, '00000000-0000-0000-0000-0000000000c2')$f$, pg_temp.id('v8')));
reset role;

select pg_temp.como('00000000-0000-0000-0000-0000000000d0');
set local role authenticated;
select pg_temp.contar('due_libro',      'select count(*) from public.puntos_libro');
select pg_temp.contar('due_vouchers',   'select count(*) from public.vouchers');
select pg_temp.intentar('due_qr',       'select count(*) from public.qr_posventa');
reset role;

select is((select s from r where k = 'anon_crear'),    '42501', 'anónimo: no ejecuta crear_venta');
select is((select s from r where k = 'anon_saldo'),    '42501', 'anónimo: no ejecuta mi_saldo');
select is((select s from r where k = 'anon_reclamar'), '42501', 'anónimo: no reclama QR');
select is((select s from r where k = 'anon_ventas'),   '42501', 'anónimo: no lee ventas');
select is((select s from r where k = 'cli_crear'),     '42501', 'cliente: no crea ventas');
select is((select s from r where k = 'cli_pagar'),     '42501', 'cliente: no cobra ventas');
select is((select s from r where k = 'cli_anular'),    '42501', 'cliente: no anula ventas');
select is((select s from r where k = 'cli_offline'),  '42501', 'cliente: no registra ventas offline');
select is((select s from r where k = 'cli_vouchers_de'), '42501', 'cliente: no consulta premios de otros por la función del POS');
select is((select n from r where k = 'cli_ventas'),    0::bigint, 'cliente: no lee ventas directo');
select is((select n from r where k = 'cli_lineas'),    0::bigint, 'cliente: no lee líneas de venta directo');
select is((select n from r where k = 'cli_libro'),     0::bigint, 'cliente: no lee el libro de puntos directo');
select is((select n from r where k = 'cli_vouchers'),  0::bigint, 'cliente: no lee vouchers directo');
select is((select s from r where k = 'cli_qr'),        '42501', 'cliente: no toca los QR posteriores');
select is((select s from r where k = 'cli_ins_libro'), '42501', 'cliente: no se da puntos a mano');
select is((select s from r where k = 'cli_ins_ventas'), '42501', 'cliente: no inserta ventas directo');
select is((select s from r where k = 'cli_upd_perfil'), '42501', 'cliente: no edita perfiles');
select is((select s from r where k = 'cli_interna'),   '42501', 'cliente: no ejecuta funciones internas de puntos');
select ok((select n from r where k = 'caj_ventas') > 0, 'cajero: lee las ventas');
select is((select n from r where k = 'caj_libro'),     0::bigint, 'cajero: no lee el libro de puntos');
select is((select n from r where k = 'caj_vouchers'),  0::bigint, 'cajero: no lee vouchers directo (usa la función del POS)');
select is((select s from r where k = 'caj_qr'),        '42501', 'cajero: no toca los QR posteriores');
select is((select s from r where k = 'caj_reclamar'),  '42501', 'cajero: no reclama QR (no es cliente)');
select is((select s from r where k = 'caj_canjear'),   '42501', 'cajero: no canjea premios');
select is((select s from r where k = 'caj_upd_ventas'), '42501', 'cajero: no cambia estados directo');
select is((select s from r where k = 'caj_reasignar'), '42501', 'cajero: no reasigna el cliente de una venta (requiere dueño con PIN)');
select ok((select n from r where k = 'due_libro') > 0, 'dueño: lee el libro de puntos');
select ok((select n from r where k = 'due_vouchers') > 0, 'dueño: lee vouchers');
select is((select s from r where k = 'due_qr'),        '42501', 'dueño: tampoco lee los QR (solo hashes, nadie los ve)');

-- Higiene general
select is((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
           and has_function_privilege('anon', p.oid, 'execute')), 0::bigint, 'ninguna función pública es ejecutable por anónimos');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0::bigint, 'toda función security definer fija su search_path');
select is((select count(*) from pg_tables where schemaname = 'public' and not rowsecurity), 0::bigint, 'todas las tablas de public tienen RLS activado');

select * from finish();
rollback;
