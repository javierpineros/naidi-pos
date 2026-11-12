-- Borra de la base LOCAL de desarrollo los datos que dejan las pruebas de integracion (tests/integracion/*):
-- las cuentas @integracion.test y todo lo que cuelga de ellas (ventas, puntos, vouchers, pedidos web, pagos y eventos de
-- Bold, alertas, auditoria). No toca cuentas ni datos de otro dominio.
--
-- NUNCA contra una base con datos reales. Por defecto es una PRUEBA: hace todo dentro de una transaccion y la deshace
-- (rollback), y muestra los conteos. Para aplicarlo de verdad, pasa -v aplicar=1.
--
-- Prueba (no cambia nada):
--   Get-Content scripts/limpiar-datos-integracion.sql -Raw | docker exec -i supabase_db_naidi-pos psql -U postgres
-- Aplicar:
--   Get-Content scripts/limpiar-datos-integracion.sql -Raw | docker exec -i supabase_db_naidi-pos psql -U postgres -v aplicar=1
--
-- Antes de aplicar, haz un respaldo:
--   docker exec supabase_db_naidi-pos pg_dump -U postgres --data-only --column-inserts postgres > respaldo.sql
--
-- Las tablas de libros (puntos, eventos, auditoria) y la maquina de estados de las ventas bloquean DELETE con triggers.
-- Aqui se suspenden SOLO dentro de la transaccion y se reactivan antes de terminar; el script muestra al final cuantos
-- quedaron activos (no_activos debe ser 0).
--
-- Despues de correr las pruebas de integracion, ademas hay que volver a encender, si se usan a mano, las banderas
-- pedidos_web y pago_en_linea_bold y el interruptor de pedidos web: las pruebas los dejan apagados.

\set ON_ERROR_STOP on
begin;

-- Alcance: solo cuentas @integracion.test (las crean las pruebas de integracion) y lo que cuelga de ellas.
create temp table t_users on commit drop as select id from auth.users where email like '%@integracion.test';
create temp table t_ventas on commit drop as
  select id from public.ventas
   where cliente_id in (select id from t_users) or creada_por in (select id from t_users) or anulada_por in (select id from t_users);
create temp table t_pedidos on commit drop as select id from public.pedidos_web where cliente_id in (select id from t_users);
create temp table t_orders on commit drop as select order_id from public.pagos_bold where pedido_id in (select id from t_pedidos);

\echo == A borrar: usuarios, ventas, pedidos web, ordenes de Bold
select (select count(*) from t_users) usuarios, (select count(*) from t_ventas) ventas,
       (select count(*) from t_pedidos) pedidos, (select count(*) from t_orders) ordenes_bold;

-- Salvaguardas: si algo de una cuenta real se mezcla con lo de prueba, se aborta sin borrar nada.
do $$
declare n integer;
begin
  select count(*) into n from public.ventas
   where id in (select id from t_ventas) and cliente_id is not null and cliente_id not in (select id from t_users);
  if n > 0 then raise exception 'Hay % venta(s) de prueba con un cliente real; se aborta.', n; end if;
  select count(*) into n from public.pedidos_web where venta_id in (select id from t_ventas) and id not in (select id from t_pedidos);
  if n > 0 then raise exception 'Hay % pedido(s) real(es) ligado(s) a ventas de prueba; se aborta.', n; end if;
end $$;

-- Se suspenden los triggers de usuario de las tablas public solo dentro de esta transaccion (el DDL es transaccional).
create temp table t_trg on commit drop as
  select t.tgrelid::regclass::text as tabla, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and t.tgenabled = 'O';
\echo == Triggers de usuario (inmutabilidad, maquina de estados) que se suspenden SOLO dentro de esta transaccion
select count(*) as triggers_suspendidos from t_trg;
do $$ declare r record; begin
  for r in select * from t_trg loop execute format('alter table %s disable trigger %I', r.tabla, r.tgname); end loop;
end $$;

\echo == Borrado (hijos primero)
delete from public.pagos_bold         where pedido_id in (select id from t_pedidos);
delete from public.bold_eventos       where order_id in (select order_id from t_orders);
delete from public.pedido_web_eventos where pedido_id in (select id from t_pedidos);
delete from public.pedido_web_lineas  where pedido_id in (select id from t_pedidos);
delete from public.pedidos_web        where id in (select id from t_pedidos);
delete from public.cuentas_pedidos_web where cliente_id in (select id from t_users) or fijada_por in (select id from t_users);
delete from public.alertas            where cliente_id in (select id from t_users) or resuelta_por in (select id from t_users) or venta_id in (select id from t_ventas);
delete from public.puntos_libro       where cliente_id in (select id from t_users) or venta_id in (select id from t_ventas);
delete from public.qr_posventa        where venta_id in (select id from t_ventas) or usado_por in (select id from t_users);
delete from public.venta_lineas       where venta_id in (select id from t_ventas);
delete from public.venta_eventos      where venta_id in (select id from t_ventas);
update public.ventas set voucher_compra_id = null where id in (select id from t_ventas) and voucher_compra_id is not null;
delete from public.vouchers           where cliente_id in (select id from t_users) or venta_id in (select id from t_ventas);
delete from public.ventas             where id in (select id from t_ventas);
delete from public.checkins           where cliente_id in (select id from t_users) or cerrado_por in (select id from t_users);
delete from public.cierres_caja       where cerrado_por in (select id from t_users);
delete from public.dispositivos       where creado_por in (select id from t_users) or revocado_por in (select id from t_users);
delete from public.auditoria          where actor in (select id from t_users);
-- Filas unicas (interruptor, token de entrada) que apuntan a una cuenta de prueba: se conservan y se les quita la referencia.
update public.pedidos_web_interruptor set cambiado_por = null where cambiado_por in (select id from t_users);
update public.punto_venta set rotado_por = null where rotado_por in (select id from t_users);
-- perfiles, consentimientos, staff y el PIN del personal se borran en cascada con la cuenta.
delete from auth.users                where id in (select id from t_users);

do $$ declare r record; begin
  for r in select * from t_trg loop execute format('alter table %s enable trigger %I', r.tabla, r.tgname); end loop;
end $$;
\echo == Triggers reactivados: activos / no activos (no activos debe ser 0)
select count(*) filter (where t.tgenabled = 'O') as activos, count(*) filter (where t.tgenabled <> 'O') as no_activos
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal and c.relnamespace = 'public'::regnamespace;

\echo == Quedan (cuentas reales)
select email from auth.users order by email;
select (select count(*) from public.pedidos_web) pedidos_web, (select count(*) from public.ventas) ventas,
       (select count(*) from public.puntos_libro) puntos_libro, (select count(*) from public.pagos_bold) pagos_bold,
       (select count(*) from public.bold_eventos) bold_eventos, (select count(*) from public.alertas) alertas,
       (select count(*) from public.auditoria) auditoria, (select count(*) from public.perfiles) perfiles;

\if :{?aplicar}
  \echo == APLICADO (commit)
  commit;
\else
  \echo == SOLO PRUEBA: se deshizo todo. Para aplicar, agrega -v aplicar=1
  rollback;
\endif
