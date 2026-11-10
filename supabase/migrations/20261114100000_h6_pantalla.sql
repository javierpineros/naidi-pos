-- H6: pantalla del cliente (iPad). Llave de dispositivo revocable, sin sesión del personal.
-- La pantalla solo lee, y solo a través de public.pantalla_estado(llave). No toca tablas.

-- =============================================================================================
-- 1. Dispositivos (llaves). Solo se guarda el hash; la llave se muestra una única vez al emitirla.
-- =============================================================================================
create table public.dispositivos (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null check (length(btrim(nombre)) between 1 and 60),
  llave_hash  text not null unique,
  creado_por  uuid references auth.users (id),
  creado_en   timestamptz not null default now(),
  ultimo_uso  timestamptz,
  revocado_en timestamptz,
  revocado_por uuid references auth.users (id)
);
alter table public.dispositivos enable row level security;
revoke all on public.dispositivos from anon, authenticated;
-- El dueño ve la lista, pero nunca el hash.
grant select (id, nombre, creado_por, creado_en, ultimo_uso, revocado_en, revocado_por) on public.dispositivos to authenticated;
create policy dispositivos_ver_dueno on public.dispositivos for select to authenticated using ((select private.es_dueno()));

-- =============================================================================================
-- 2. Reglas (parametrizables, con vigencia)
-- =============================================================================================
insert into public.reglas_negocio (clave, version, valor, descripcion, publica) values
  ('pantalla.max_dispositivos',   1, '3'::jsonb,
     'Máximo de pantallas (iPad) activas a la vez.', false),
  ('pantalla.gracias_segundos',   1, '20'::jsonb,
     'Segundos que la pantalla muestra "Pagado, gracias" después de marcar la venta como Pagada.', false),
  ('pantalla.venta_max_minutos',  1, '60'::jsonb,
     'Una venta confirmada y sin pagar deja de mostrarse en la pantalla pasado este tiempo.', false);

-- =============================================================================================
-- 3. Emitir, listar y revocar (dueño con PIN). Un PIN incorrecto devuelve {ok:false}.
-- =============================================================================================
create function public.emitir_llave_dispositivo(p_nombre text, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_fallo jsonb;
  v_llave text := 'nd_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  v_fallo := private.exigir_pin(p_pin, 'emitir_llave_dispositivo');
  if v_fallo is not null then return v_fallo; end if;
  if p_nombre is null or length(btrim(p_nombre)) = 0 or length(btrim(p_nombre)) > 60 then
    raise exception 'Ponle un nombre a la pantalla (hasta 60 letras).';
  end if;
  if (select count(*) from public.dispositivos where revocado_en is null) >= private.regla_int('pantalla.max_dispositivos') then
    raise exception 'Ya hay el máximo de pantallas activas. Revoca una antes de emitir otra llave.';
  end if;
  insert into public.dispositivos (nombre, llave_hash, creado_por)
  values (btrim(p_nombre), encode(extensions.digest(v_llave, 'sha256'), 'hex'), (select auth.uid()))
  returning id into v_id;
  perform private.auditar('emitir_llave_dispositivo', 'dispositivos', v_id::text, jsonb_build_object('nombre', btrim(p_nombre)));
  return jsonb_build_object('ok', true, 'id', v_id, 'llave', v_llave);
end;
$$;

create function public.revocar_dispositivo(p_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'revocar_dispositivo');
  if v_fallo is not null then return v_fallo; end if;
  update public.dispositivos set revocado_en = now(), revocado_por = (select auth.uid())
   where id = p_id and revocado_en is null;
  if not found then raise exception 'Esa pantalla no existe o ya estaba revocada.'; end if;
  perform private.auditar('revocar_dispositivo', 'dispositivos', p_id::text);
  return jsonb_build_object('ok', true);
end;
$$;

create function public.listar_dispositivos() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select private.es_dueno()) then
    raise exception 'Solo el dueño, con verificación en dos pasos, puede ver las pantallas.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'nombre', d.nombre, 'creado_en', d.creado_en,
             'ultimo_uso', d.ultimo_uso, 'revocado_en', d.revocado_en, 'activo', d.revocado_en is null)
           order by d.creado_en desc)
    from public.dispositivos d), '[]'::jsonb);
end;
$$;

-- =============================================================================================
-- 4. Lo que lee el iPad. Se llama sin sesión (rol anon) con la llave del dispositivo.
-- Devuelve {ok:false,error:'llave_invalida'} (no lanza error) si la llave no existe o fue revocada.
-- Solo expone lo que el cliente puede ver en el mostrador: el token de entrada, las líneas, el total
-- y las formas de pago. Nada del cliente (ni nombre) ni de los puntos.
-- =============================================================================================
create function public.pantalla_estado(p_llave text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  d public.dispositivos;
  v public.ventas;
  v_venta jsonb := null;
  v_destino jsonb := coalesce(private.regla_vigente('transferencia.destino'), '{}'::jsonb);
begin
  if p_llave is null or length(p_llave) > 200 then
    return jsonb_build_object('ok', false, 'error', 'llave_invalida');
  end if;
  select * into d from public.dispositivos
   where llave_hash = encode(extensions.digest(p_llave, 'sha256'), 'hex') and revocado_en is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'llave_invalida');
  end if;
  -- Marca de último uso: como mucho una vez por minuto, para no escribir en cada consulta.
  if d.ultimo_uso is null or d.ultimo_uso < now() - interval '1 minute' then
    update public.dispositivos set ultimo_uso = now() where id = d.id;
  end if;

  -- La venta en curso: la actividad más reciente entre una confirmada sin pagar (reciente) y una que se acaba de pagar
  -- (unos segundos). Así, "Pagado, gracias" no lo tapa una venta confirmada más vieja que quedó sin pagar.
  select * into v from public.ventas
   where canal = 'tienda'
     and ((estado = 'confirmada' and confirmada_en > now() - make_interval(mins => private.regla_int('pantalla.venta_max_minutos')))
       or (estado = 'pagada' and pagada_en > now() - make_interval(secs => private.regla_int('pantalla.gracias_segundos'))))
   order by coalesce(pagada_en, confirmada_en) desc limit 1;

  if found then
    v_venta := jsonb_build_object(
      'numero', v.numero, 'estado', v.estado,
      'subtotal_cop', v.subtotal_cop, 'descuento_cop', v.descuento_cop, 'total_cop', v.total_cop,
      'lineas', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'nombre', l.producto_nombre, 'tamano', t.nombre, 'cantidad', l.cantidad,
                 'toppings', coalesce((select jsonb_agg(e ->> 'nombre') from jsonb_array_elements(l.toppings) e), '[]'::jsonb),
                 'precio_unitario_cop', l.precio_unitario_cop, 'descuento_cop', l.descuento_cop,
                 'total_cop', l.cantidad * l.precio_unitario_cop - l.descuento_cop) order by l.orden)
        from public.venta_lineas l left join public.tamanos t on t.clave = l.tamano
        where l.venta_id = v.id), '[]'::jsonb));
  end if;

  return jsonb_build_object(
    'ok', true,
    'entrada_token', (select token from public.punto_venta where id = 1),
    'venta', v_venta,
    'formas_pago', jsonb_build_array('efectivo', 'datafono_bold', 'transferencia'),
    'transferencia', jsonb_build_object('tipo', v_destino ->> 'tipo', 'valor', coalesce(v_destino ->> 'valor', '')),
    'servidor_en', now());
end;
$$;

-- =============================================================================================
-- 5. Permisos de ejecución. Misma regla de siempre (solo "authenticated"), con una excepción:
-- pantalla_estado la llama el iPad sin sesión, así que se concede a anon DESPUÉS del bucle.
-- Si una migración futura repite el bucle, la prueba 07 avisa que anon perdió el permiso.
-- =============================================================================================
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'private'::regnamespace
             and p.proname not in ('es_staff', 'es_dueno', 'es_cajero', 'bloquear_mutacion') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function public.pantalla_estado(text) to anon, authenticated;
