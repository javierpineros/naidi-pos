-- Reenviar al iPad una venta confirmada que ya salió de la ventana de visibilidad (p. ej. se recuperó desde Caja).
alter table public.ventas add column if not exists mostrada_en timestamptz;

create or replace function public.mostrar_en_ipad(p_venta uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'confirmada' or v.canal <> 'tienda' then
    raise exception 'Solo se muestra en el iPad una venta de tienda confirmada y sin pagar (estado actual: %).', v.estado;
  end if;
  update public.ventas set mostrada_en = now() where id = p_venta;
  perform private.auditar('mostrar_en_ipad', 'venta', p_venta::text);
end;
$$;
revoke all on function public.mostrar_en_ipad(uuid) from public, anon;
grant execute on function public.mostrar_en_ipad(uuid) to authenticated;

create or replace function public.pantalla_estado(p_llave text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  d public.dispositivos;
  v public.ventas;
  v_venta jsonb := null;
  v_destino jsonb := coalesce(private.regla_vigente('transferencia.destino'), '{}'::jsonb);
  v_formas jsonb := jsonb_build_array('efectivo', 'datafono_bold', 'transferencia');
  v_qr boolean := private.bandera_activa('pago_en_linea_bold');
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
     and ((estado = 'confirmada' and greatest(confirmada_en, coalesce(mostrada_en, confirmada_en)) > now() - make_interval(mins => private.regla_int('pantalla.venta_max_minutos')))
       or (estado = 'alistando' and reabierta_en > now() - make_interval(mins => private.regla_int('pantalla.venta_max_minutos')))
       or (estado = 'pagada' and pagada_en > now() - make_interval(secs => private.regla_int('pantalla.gracias_segundos'))))
   order by coalesce(pagada_en, reabierta_en, mostrada_en, confirmada_en) desc limit 1;

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
    if v_qr and v.estado = 'confirmada' and v.total_cop >= 1000 then
      v_venta := v_venta || jsonb_build_object('codigo_pago', v.codigo_pago);
      v_formas := v_formas || jsonb_build_array('bold_online');
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'entrada_token', (select token from public.punto_venta where id = 1),
    'venta', v_venta,
    'formas_pago', v_formas,
    'transferencia', jsonb_build_object('tipo', v_destino ->> 'tipo', 'valor', coalesce(v_destino ->> 'valor', '')),
    'servidor_en', now());
end;
$$;

