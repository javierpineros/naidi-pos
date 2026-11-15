-- Recuperar el PIN del dueño sin tocar la base de datos.
-- Quien olvidó su PIN (o lo tiene bloqueado) prueba que es el dueño volviendo a escribir el código de su app de
-- verificación (segundo factor): el servidor exige que esa verificación sea de los últimos minutos. Con eso fija un
-- PIN nuevo sin pedir el actual. Queda auditado. Una sesión que lleva horas abierta no basta.
create or replace function public.restablecer_pin(p_nuevo text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ultimo bigint;
begin
  if not (select private.es_dueno()) then
    raise exception 'Solo el dueño, con verificación en dos pasos, puede hacer esto.' using errcode = '42501';
  end if;
  if p_nuevo is null or p_nuevo !~ '^[0-9]{4,8}$' then
    raise exception 'El PIN debe tener entre 4 y 8 dígitos.';
  end if;
  -- amr: lista de métodos con los que entró la sesión, cada uno con su hora (segundos Unix).
  select max((e ->> 'timestamp')::bigint) into v_ultimo
    from jsonb_array_elements(coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb)) e
   where e ->> 'method' = 'totp' and (e ->> 'timestamp') ~ '^[0-9]+$';
  if v_ultimo is null or v_ultimo < extract(epoch from now())::bigint - 300 then
    perform private.auditar('restablecer_pin_rechazado', 'pin', v_uid::text);
    return jsonb_build_object('ok', false, 'error', 'verificacion_vencida');
  end if;
  insert into private.staff_pin (user_id, pin_hash) values (v_uid, extensions.crypt(p_nuevo, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set pin_hash = excluded.pin_hash, intentos = 0, bloqueado_hasta = null, updated_at = now();
  perform private.auditar('restablecer_pin', 'pin', v_uid::text);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.restablecer_pin(text) from public, anon;
grant execute on function public.restablecer_pin(text) to authenticated;
