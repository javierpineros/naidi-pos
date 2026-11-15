-- La venta de tienda se puede modificar después de confirmada (el cliente revisa el pedido en el iPad y pide agregar algo)
-- y el iPad la sigue mostrando mientras el vendedor la edita.
--   * reabrir_venta: confirmada -> alistando (solo canal tienda, sin pagar). Los premios usados vuelven a quedar reservados.
--   * ventas.reabierta_en: marca que la venta está en edición para que pantalla_estado la siga mostrando.
--   * pantalla_estado: una venta reabierta se muestra con estado "actualizando" (sin formas de pago hasta que se confirme otra vez).

alter table public.ventas add column reabierta_en timestamptz;

-- Misma validación de H4, más la transición confirmada -> alistando.
create or replace function private.validar_transicion_venta() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.estado in ('cancelada', 'anulada') then
    raise exception 'La venta % ya está %; no admite cambios.', old.numero, old.estado using errcode = 'restrict_violation';
  end if;
  if new.idempotency_key <> old.idempotency_key or new.numero <> old.numero then
    raise exception 'La identidad de la venta no se puede cambiar.' using errcode = 'restrict_violation';
  end if;
  if new.estado <> old.estado and not ((old.estado, new.estado) in (
      ('alistando', 'confirmada'), ('alistando', 'cancelada'), ('confirmada', 'alistando'),
      ('confirmada', 'pagada'), ('confirmada', 'cancelada'), ('pagada', 'anulada'))) then
    raise exception 'Transición no permitida: % -> %.', old.estado, new.estado using errcode = 'restrict_violation';
  end if;
  if new.cliente_id is distinct from old.cliente_id
     and not (old.estado in ('alistando', 'confirmada') or (old.cliente_id is null and old.estado = 'pagada')) then
    raise exception 'El cliente de la venta no se puede cambiar así.' using errcode = 'restrict_violation';
  end if;
  if old.estado <> 'alistando' and new.estado = old.estado
     and (new.subtotal_cop, new.descuento_cop, new.total_cop) is distinct from (old.subtotal_cop, old.descuento_cop, old.total_cop) then
    raise exception 'Los montos de una venta % no se pueden cambiar.', old.estado using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create function public.reabrir_venta(p_venta uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'confirmada' then
    raise exception 'Solo se modifica una venta confirmada y sin pagar (estado actual: %).', v.estado;
  end if;
  if v.canal <> 'tienda' then raise exception 'Solo se modifican ventas de tienda.'; end if;
  update public.ventas set estado = 'alistando', reabierta_en = now() where id = p_venta;
  -- Los premios que la confirmación dio por usados vuelven a quedar reservados mientras se edita.
  update public.vouchers set estado = 'reservado', usado_en = null where venta_id = p_venta and estado = 'usado';
  perform private.evento(p_venta, 'confirmada', 'alistando', 'reabierta');
  perform private.auditar('reabrir_venta', 'venta', p_venta::text);
end;
$$;

-- Al confirmar de nuevo, la venta deja de estar "en edición".
create or replace function public.confirmar_venta(p_venta uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  perform private.confirmar_interno(p_venta, now());
  update public.ventas set reabierta_en = null where id = p_venta and reabierta_en is not null;
  select * into v from public.ventas where id = p_venta;
  return jsonb_build_object('venta_id', v.id, 'estado', v.estado, 'subtotal_cop', v.subtotal_cop,
                            'descuento_cop', v.descuento_cop, 'total_cop', v.total_cop);
end;
$$;

-- descartar_venta ya admite "alistando"; una venta reabierta que se descarta pasa a cancelada y el iPad vuelve al reposo.

-- Lo que ve el iPad: igual que en H6, más la venta reabierta (estado "actualizando").
create or replace function public.pantalla_estado(p_llave text) returns jsonb
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
  if d.ultimo_uso is null or d.ultimo_uso < now() - interval '1 minute' then
    update public.dispositivos set ultimo_uso = now() where id = d.id;
  end if;

  select * into v from public.ventas
   where canal = 'tienda'
     and ((estado = 'confirmada' and confirmada_en > now() - make_interval(mins => private.regla_int('pantalla.venta_max_minutos')))
       or (estado = 'alistando' and reabierta_en > now() - make_interval(mins => private.regla_int('pantalla.venta_max_minutos')))
       or (estado = 'pagada' and pagada_en > now() - make_interval(secs => private.regla_int('pantalla.gracias_segundos'))))
   order by coalesce(pagada_en, reabierta_en, confirmada_en) desc limit 1;

  if found then
    v_venta := jsonb_build_object(
      'numero', v.numero, 'estado', case when v.estado = 'alistando' then 'actualizando' else v.estado end,
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

revoke all on function public.reabrir_venta(uuid) from public, anon;
grant execute on function public.reabrir_venta(uuid) to authenticated;
-- create or replace conserva los permisos de confirmar_venta y pantalla_estado (anon sigue pudiendo llamar a esta última).
