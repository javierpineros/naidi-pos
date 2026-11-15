-- Recuperar el PIN del dueño: exige haber confirmado el segundo factor hace pocos minutos.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000013ca', 'authenticated', 'authenticated', 'cajero13@prueba.test', '{}'),
  ('00000000-0000-0000-0000-0000000013d0', 'authenticated', 'authenticated', 'dueno13@prueba.test', '{}');
insert into public.staff (user_id, rol, nombre) values
  ('00000000-0000-0000-0000-0000000013ca', 'cajero', 'Cajero Trece'),
  ('00000000-0000-0000-0000-0000000013d0', 'dueno',  'Dueño Trece');

-- p_hace: segundos desde que se verificó el segundo factor (null = la sesión no trae esa información).
create function pg_temp.como(p_uid text, p_aal text default 'aal2', p_hace integer default null) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal,
    'amr', case when p_hace is null then '[]'::json
           else json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - p_hace)) end)::text, true) $$;

select ok(not has_function_privilege('anon', 'public.restablecer_pin(text)', 'execute'), 'anon no ejecuta restablecer_pin');

select pg_temp.como('00000000-0000-0000-0000-0000000013ca', 'aal2', 10);
select throws_ok($$select public.restablecer_pin('1357')$$, '42501', null, 'un cajero no restablece el PIN del dueño');

select pg_temp.como('00000000-0000-0000-0000-0000000013d0', 'aal1', 10);
select throws_ok($$select public.restablecer_pin('1357')$$, '42501', null, 'el dueño sin segundo factor tampoco');

-- Tiene un PIN y lo olvidó.
select pg_temp.como('00000000-0000-0000-0000-0000000013d0', 'aal2', 10);
select is(public.fijar_pin('4321') ->> 'ok', 'true', 'el dueño tenía un PIN');

select pg_temp.como('00000000-0000-0000-0000-0000000013d0', 'aal2', 3600);
select is(public.restablecer_pin('1357') ->> 'error', 'verificacion_vencida', 'con el segundo factor de hace una hora no se puede');
select pg_temp.como('00000000-0000-0000-0000-0000000013d0', 'aal2', null);
select is(public.restablecer_pin('1357') ->> 'error', 'verificacion_vencida', 'sin hora de verificación tampoco');
select is(private.chequear_pin('4321') ->> 'estado', 'ok', 'y el PIN de antes sigue igual');

select pg_temp.como('00000000-0000-0000-0000-0000000013d0', 'aal2', 20);
select throws_ok($$select public.restablecer_pin('12')$$, null, 'El PIN debe tener entre 4 y 8 dígitos.', 'rechaza un PIN que no es de 4 a 8 dígitos');
select is(public.restablecer_pin('1357') ->> 'ok', 'true', 'recién verificado, fija un PIN nuevo sin pedir el actual');
select is(private.chequear_pin('1357') ->> 'estado', 'ok', 'el PIN nuevo funciona');
select is(private.chequear_pin('4321') ->> 'estado', 'incorrecto', 'el viejo ya no');

-- Bloqueado por intentos fallidos: restablecer también desbloquea.
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select private.chequear_pin('0000');
select is(private.chequear_pin('1357') ->> 'estado', 'bloqueado', 'tras varios intentos fallidos el PIN se bloquea');
select is(public.restablecer_pin('2468') ->> 'ok', 'true', 'restablecer lo desbloquea');
select is(private.chequear_pin('2468') ->> 'estado', 'ok', 'y el PIN nuevo entra');

reset role;
select ok((select count(*) from public.auditoria where accion = 'restablecer_pin' and entidad_id = '00000000-0000-0000-0000-0000000013d0') = 2, 'cada restablecimiento queda en la auditoría');
select ok((select count(*) from public.auditoria where accion = 'restablecer_pin_rechazado' and entidad_id = '00000000-0000-0000-0000-0000000013d0') = 2, 'y cada intento rechazado también');

select * from finish();
rollback;
