-- H1: RLS con denegación por defecto y permisos por rol (anónimo, cliente, cajero, dueño).
-- Cada rol intenta lo que NO debe poder hacer. Los resultados se capturan bajo el rol y se
-- afirman después, ya como postgres, para que pgTAP no dependa de los permisos del rol probado.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ----------------------------------------------------------------------------------------------
-- Datos de prueba (sin datos reales): cuatro cuentas.
-- ----------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'cliente@prueba.test'),
  ('00000000-0000-0000-0000-0000000000ca', 'authenticated', 'authenticated', 'cajero@prueba.test'),
  ('00000000-0000-0000-0000-0000000000d0', 'authenticated', 'authenticated', 'dueno@prueba.test'),
  ('00000000-0000-0000-0000-0000000000ee', 'authenticated', 'authenticated', 'inactivo@prueba.test');
insert into public.staff (user_id, rol, nombre, activo) values
  ('00000000-0000-0000-0000-0000000000ca', 'cajero', 'Cajero Prueba', true),
  ('00000000-0000-0000-0000-0000000000d0', 'dueno',  'Dueño Prueba',  true),
  ('00000000-0000-0000-0000-0000000000ee', 'cajero', 'Inactivo Prueba', false);

create temp table r (k text primary key, n bigint, s text);
grant all on r to public;

create function pg_temp.contar(p_k text, p_q text) returns void language plpgsql as $$
declare v bigint;
begin
  execute p_q into v;
  insert into r (k, n) values (p_k, v);
end $$;

create function pg_temp.intentar(p_k text, p_q text) returns void language plpgsql as $$
begin
  execute p_q;
  insert into r (k, s) values (p_k, 'ok');
exception when others then
  insert into r (k, s) values (p_k, sqlstate);
end $$;

-- Una entrada de auditoría creada por el servidor (como lo hará una anulación de venta).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d0","role":"authenticated"}', true);
select private.auditar('prueba', 'venta', 'v-1', '{"motivo":"prueba"}');

-- ----------------------------------------------------------------------------------------------
-- Anónimo: sin acceso a nada.
-- ----------------------------------------------------------------------------------------------
set local role anon;
select pg_temp.intentar('anon_staff',      'select count(*) from public.staff');
select pg_temp.intentar('anon_auditoria',  'select count(*) from public.auditoria');
select pg_temp.intentar('anon_reglas',     'select count(*) from public.reglas_negocio');
select pg_temp.intentar('anon_banderas',   'select count(*) from public.banderas');
select pg_temp.intentar('anon_ins_staff',  $$insert into public.staff (user_id, rol, nombre) values ('00000000-0000-0000-0000-0000000000c1','dueno','x')$$);
reset role;

-- ----------------------------------------------------------------------------------------------
-- Cliente (autenticado, sin fila en staff). Intenta además hacerse pasar por dueño con metadatos.
-- ----------------------------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","user_metadata":{"rol":"dueno"},"app_metadata":{"rol":"dueno"}}', true);
set local role authenticated;
select pg_temp.contar('cli_staff',      'select count(*) from public.staff');
select pg_temp.contar('cli_auditoria',  'select count(*) from public.auditoria');
select pg_temp.contar('cli_banderas',   'select count(*) from public.banderas');
select pg_temp.contar('cli_reglas',     'select count(*) from public.reglas_negocio');
select pg_temp.contar('cli_reglas_no_publicas', 'select count(*) from public.reglas_negocio where not publica');
select pg_temp.intentar('cli_ins_staff',  $$insert into public.staff (user_id, rol, nombre) values ('00000000-0000-0000-0000-0000000000c1','dueno','yo')$$);
select pg_temp.intentar('cli_upd_staff',  $$update public.staff set rol = 'dueno'$$);
select pg_temp.intentar('cli_ins_reglas', $$insert into public.reglas_negocio (clave, version, valor) values ('x', 1, '1')$$);
select pg_temp.intentar('cli_upd_banderas', $$update public.banderas set activa = true$$);
select pg_temp.intentar('cli_ins_auditoria', $$insert into public.auditoria (accion, entidad) values ('x','y')$$);
select pg_temp.intentar('cli_regla_vigente', $$select private.regla_vigente('checkin.vigencia_min')$$);
select pg_temp.intentar('cli_auditar',       $$select private.auditar('x','y')$$);
reset role;

-- ----------------------------------------------------------------------------------------------
-- Cajero.
-- ----------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ca","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.contar('caj_staff',      'select count(*) from public.staff');
select pg_temp.contar('caj_auditoria',  'select count(*) from public.auditoria');
select pg_temp.contar('caj_banderas',   'select count(*) from public.banderas');
select pg_temp.contar('caj_reglas',     'select count(*) from public.reglas_negocio');
select pg_temp.intentar('caj_ins_staff',   $$insert into public.staff (user_id, rol, nombre) values ('00000000-0000-0000-0000-0000000000c1','dueno','x')$$);
select pg_temp.intentar('caj_upd_staff',   $$update public.staff set rol = 'dueno'$$);
select pg_temp.intentar('caj_ins_reglas',  $$insert into public.reglas_negocio (clave, version, valor) values ('x', 1, '1')$$);
select pg_temp.intentar('caj_upd_reglas',  $$update public.reglas_negocio set valor = '1'$$);
select pg_temp.intentar('caj_upd_banderas', $$update public.banderas set activa = true$$);
select pg_temp.intentar('caj_del_auditoria', $$delete from public.auditoria$$);
reset role;

-- ----------------------------------------------------------------------------------------------
-- Dueño: lee todo, pero tampoco escribe directo (los cambios sensibles irán por funciones con PIN).
-- ----------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d0","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.contar('due_staff',      'select count(*) from public.staff');
select pg_temp.contar('due_auditoria',  'select count(*) from public.auditoria');
select pg_temp.contar('due_banderas',   'select count(*) from public.banderas');
select pg_temp.contar('due_reglas',     'select count(*) from public.reglas_negocio');
select pg_temp.intentar('due_ins_reglas',   $$insert into public.reglas_negocio (clave, version, valor) values ('x', 1, '1')$$);
select pg_temp.intentar('due_upd_banderas', $$update public.banderas set activa = true$$);
select pg_temp.intentar('due_upd_staff',    $$update public.staff set rol = 'cajero'$$);
select pg_temp.intentar('due_upd_auditoria', $$update public.auditoria set accion = 'x'$$);
reset role;

-- ----------------------------------------------------------------------------------------------
-- Personal inactivo: pierde el acceso aunque su fila exista.
-- ----------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ee","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.contar('ina_reglas',    'select count(*) from public.reglas_negocio');
select pg_temp.contar('ina_banderas',  'select count(*) from public.banderas');
reset role;

-- ================================ Afirmaciones =================================================

-- RLS activado en todas las tablas de public
select is((select count(*) from pg_tables where schemaname = 'public' and not rowsecurity), 0::bigint,
  'todas las tablas de public tienen RLS activado');

-- Todas las funciones con security definer tienen search_path fijo
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0::bigint, 'toda función security definer fija su search_path');

-- Anónimo
select is((select s from r where k = 'anon_staff'),     '42501', 'anónimo: no lee staff');
select is((select s from r where k = 'anon_auditoria'), '42501', 'anónimo: no lee auditoría');
select is((select s from r where k = 'anon_reglas'),    '42501', 'anónimo: no lee reglas');
select is((select s from r where k = 'anon_banderas'),  '42501', 'anónimo: no lee banderas');
select is((select s from r where k = 'anon_ins_staff'), '42501', 'anónimo: no inserta en staff');

-- Cliente
select is((select n from r where k = 'cli_staff'),     0::bigint, 'cliente: no ve a nadie del personal');
select is((select n from r where k = 'cli_auditoria'), 0::bigint, 'cliente: no ve la auditoría');
select is((select n from r where k = 'cli_banderas'),  0::bigint, 'cliente: no ve las banderas');
select ok((select n from r where k = 'cli_reglas') > 0, 'cliente: ve las reglas públicas');
select is((select n from r where k = 'cli_reglas_no_publicas'), 0::bigint, 'cliente: no ve reglas no públicas');
select is((select s from r where k = 'cli_ins_staff'),   '42501', 'cliente: no puede darse un rol (insert en staff)');
select is((select s from r where k = 'cli_upd_staff'),   '42501', 'cliente: no puede cambiar roles');
select is((select s from r where k = 'cli_ins_reglas'),  '42501', 'cliente: no escribe reglas');
select is((select s from r where k = 'cli_upd_banderas'), '42501', 'cliente: no cambia banderas');
select is((select s from r where k = 'cli_ins_auditoria'), '42501', 'cliente: no escribe auditoría');
select is((select s from r where k = 'cli_regla_vigente'), '42501', 'cliente: no ejecuta funciones internas (regla_vigente)');
select is((select s from r where k = 'cli_auditar'),       '42501', 'cliente: no ejecuta funciones internas (auditar)');

-- Cajero
select is((select n from r where k = 'caj_staff'),     1::bigint, 'cajero: solo ve su propia fila de staff');
select is((select n from r where k = 'caj_auditoria'), 0::bigint, 'cajero: no ve la auditoría');
select ok((select n from r where k = 'caj_banderas') > 0, 'cajero: ve las banderas');
select is((select n from r where k = 'caj_reglas'), (select count(*) from public.reglas_negocio), 'cajero: ve todas las reglas');
select is((select s from r where k = 'caj_ins_staff'),    '42501', 'cajero: no crea personal');
select is((select s from r where k = 'caj_upd_staff'),    '42501', 'cajero: no cambia roles');
select is((select s from r where k = 'caj_ins_reglas'),   '42501', 'cajero: no escribe reglas');
select is((select s from r where k = 'caj_upd_reglas'),   '42501', 'cajero: no edita reglas');
select is((select s from r where k = 'caj_upd_banderas'), '42501', 'cajero: no cambia banderas');
select is((select s from r where k = 'caj_del_auditoria'), '42501', 'cajero: no borra auditoría');

-- Dueño
select is((select n from r where k = 'due_staff'),     3::bigint, 'dueño: ve a todo el personal');
select is((select n from r where k = 'due_auditoria'), 1::bigint, 'dueño: ve la auditoría');
select ok((select n from r where k = 'due_banderas') > 0, 'dueño: ve las banderas');
select is((select n from r where k = 'due_reglas'), (select count(*) from public.reglas_negocio), 'dueño: ve todas las reglas');
select is((select s from r where k = 'due_ins_reglas'),    '42501', 'dueño: no escribe reglas directo (irá por función con PIN)');
select is((select s from r where k = 'due_upd_banderas'),  '42501', 'dueño: no cambia banderas directo');
select is((select s from r where k = 'due_upd_staff'),     '42501', 'dueño: no edita staff directo');
select is((select s from r where k = 'due_upd_auditoria'), '42501', 'dueño: no edita la auditoría');

-- Inactivo
select is((select n from r where k = 'ina_reglas'),   (select count(*) from public.reglas_negocio where publica), 'inactivo: solo ve reglas públicas');
select is((select n from r where k = 'ina_banderas'), 0::bigint, 'inactivo: no ve banderas');

-- ----------------------------------------------------------------------------------------------
-- Inmutabilidad (como postgres: ni el dueño de la tabla puede saltarse los triggers)
-- ----------------------------------------------------------------------------------------------
select throws_ok($$update public.auditoria set accion = 'otra'$$, '23001', null, 'auditoría: no se actualiza');
select throws_ok($$delete from public.auditoria$$,               '23001', null, 'auditoría: no se borra');
select throws_ok($$truncate public.auditoria$$,                  '23001', null, 'auditoría: no se vacía');
select throws_ok($$update public.reglas_negocio set valor = '5' where clave = 'checkin.vigencia_min'$$,
  '23001', null, 'reglas: no se edita el valor de una versión');
select throws_ok($$delete from public.reglas_negocio where clave = 'checkin.vigencia_min'$$,
  '23001', null, 'reglas: no se borran');
select throws_ok($$insert into public.reglas_negocio (clave, version, valor) values ('checkin.vigencia_min', 2, '45')$$,
  '23P01', null, 'reglas: no puede haber dos versiones vigentes a la vez');

-- ----------------------------------------------------------------------------------------------
-- Versionado de reglas y banderas
-- ----------------------------------------------------------------------------------------------
select is(private.regla_vigente('checkin.vigencia_min'), '30'::jsonb, 'regla vigente: valor inicial');
select is(private.regla_vigente('checkin.vigencia_min', now() - interval '10 years'), null::jsonb, 'regla vigente: antes de su vigencia no existe');
select is(private.regla_vigente('no.existe'), null::jsonb, 'regla vigente: clave inexistente devuelve null');

update public.reglas_negocio set vigente_hasta = now() + interval '1 hour' where clave = 'checkin.vigencia_min' and version = 1;
insert into public.reglas_negocio (clave, version, valor, vigente_desde)
  values ('checkin.vigencia_min', 2, '45', now() + interval '1 hour');
select is(private.regla_vigente('checkin.vigencia_min'), '30'::jsonb, 'regla vigente: hoy sigue la versión 1');
select is(private.regla_vigente('checkin.vigencia_min', now() + interval '2 hours'), '45'::jsonb, 'regla vigente: mañana rige la versión 2');
select throws_ok($$update public.reglas_negocio set vigente_hasta = now() + interval '9 hours' where clave = 'checkin.vigencia_min' and version = 1$$,
  '23001', null, 'reglas: una vigencia ya cerrada no se reabre ni se mueve');

select is(private.bandera_activa('pago_en_linea_bold'), false, 'bandera: el pago en línea con Bold nace apagado');
select is(private.bandera_activa('no.existe'), false, 'bandera: una clave inexistente cuenta como apagada');
update public.banderas set activa = true where clave = 'pago_en_linea_bold';
select is(private.bandera_activa('pago_en_linea_bold'), true, 'bandera: encendida responde true');
update public.banderas set hasta = now() - interval '1 minute' where clave = 'pago_en_linea_bold';
select is(private.bandera_activa('pago_en_linea_bold'), false, 'bandera: fuera de su ventana de fechas responde false');

-- Valores iniciales acordados
select is(private.regla_vigente('pedidos_web.max_abiertos'),    '2'::jsonb, 'regla inicial: 2 pedidos web abiertos por cuenta');
select is(private.regla_vigente('pedidos_web.no_llego_alerta'), '3'::jsonb, 'regla inicial: alerta con 3 "No llegó"');
select is((select count(*) from public.banderas where activa), 1::bigint, 'banderas: solo la que esta prueba encendió (el resto nace apagado)');

select * from finish();
rollback;
