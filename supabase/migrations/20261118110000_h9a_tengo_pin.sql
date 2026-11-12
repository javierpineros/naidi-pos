-- H9a: el panel necesita saber si el dueño ya tiene PIN para pedir (o no) el PIN actual al cambiarlo.
-- Responder con fijar_pin(null) gastaría un intento; esta función solo lee.
create function public.tengo_pin() returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select private.es_dueno()) then
    raise exception 'Solo el dueño, con verificación en dos pasos, puede hacer esto.' using errcode = '42501';
  end if;
  return exists (select 1 from private.staff_pin where user_id = (select auth.uid()));
end;
$$;
revoke all on function public.tengo_pin() from public, anon;
grant execute on function public.tengo_pin() to authenticated;
