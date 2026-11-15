-- Reclamar los puntos de una compra ya pagada sin cliente, en el momento (el iPad, el POS y la página /pagar muestran el QR).
-- La credencial es el código largo de la venta (128 bits). Solo vale mientras la venta sigue pagada, sin cliente y dentro de
-- qr_posventa.vigencia_min desde el pago; un solo uso.
insert into public.reglas_negocio (clave, version, valor, descripcion, publica) values
  ('pantalla.puntos_segundos', 1, '90'::jsonb,
     'Segundos que la pantalla sigue mostrando el QR para reclamar puntos tras pagar una venta sin cliente.', false);

create function public.reclamar_puntos_venta(p_codigo text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  v public.ventas;
  v_hoy timestamptz := (date_trunc('day', now() at time zone 'America/Bogota')) at time zone 'America/Bogota';
  v_pts integer;
begin
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{32}$' then
    raise exception 'Este código no es válido, ya se usó o venció.';
  end if;
  if (select count(*) from public.qr_posventa where usado_por = v_uid and usado_en >= v_hoy)
       >= private.regla_int('antifraude.max_reclamos_qr_dia') then
    raise exception 'Llegaste al tope de reclamos de hoy. Inténtalo mañana o habla con el personal.';
  end if;
  select * into v from public.ventas where codigo_pago = p_codigo for update;
  if not found or v.estado <> 'pagada' or v.cliente_id is not null or v.canal <> 'tienda'
     or v.pagada_en <= now() - make_interval(mins => private.regla_int('qr_posventa.vigencia_min')) then
    raise exception 'Este código no es válido, ya se usó o venció.';
  end if;
  -- Un solo reclamo por venta, también frente al QR que entrega el POS: ambos comparten la fila de qr_posventa.
  if exists (select 1 from public.qr_posventa where venta_id = v.id and (usado_en is not null or invalidado_en is not null)) then
    raise exception 'Este código no es válido, ya se usó o venció.';
  end if;
  insert into public.qr_posventa (venta_id, token_hash, vence_en, usado_en, usado_por)
  values (v.id, extensions.digest('codigo:' || p_codigo, 'sha256'), now(), now(), v_uid)
  on conflict (venta_id) do update set usado_en = now(), usado_por = v_uid;
  update public.ventas set cliente_id = v_uid where id = v.id;
  v_pts := private.acreditar_puntos(v.id, v_uid);
  perform private.auditar('reclamar_puntos_venta', 'venta', v.id::text, jsonb_build_object('cliente', v_uid, 'puntos', v_pts));
  return jsonb_build_object('venta_id', v.id, 'puntos_acreditados', v_pts);
end;
$$;
revoke all on function public.reclamar_puntos_venta(text) from public, anon;
grant execute on function public.reclamar_puntos_venta(text) to authenticated;

-- La página /pagar sabe si todavía puede ofrecer "Reclamar mis puntos".
create or replace function public.estado_pago_venta_qr(p_codigo text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v public.ventas;
begin
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{32}$' then return jsonb_build_object('estado', 'invalido'); end if;
  select * into v from public.ventas where codigo_pago = p_codigo;
  if not found then return jsonb_build_object('estado', 'invalido'); end if;
  return jsonb_build_object('estado', case v.estado when 'pagada' then 'pagada' when 'confirmada' then 'abierta'
                                                   when 'alistando' then 'actualizando' else 'cerrada' end,
                            'total_cop', case when v.estado in ('confirmada', 'pagada') then v.total_cop end,
                            'numero', case when v.estado in ('confirmada', 'pagada') then v.numero end,
                            'puntos_reclamables', v.estado = 'pagada' and v.cliente_id is null and v.canal = 'tienda'
                              and v.pagada_en > now() - make_interval(mins => private.regla_int('qr_posventa.vigencia_min'))
                              and not exists (select 1 from public.qr_posventa q where q.venta_id = v.id and (q.usado_en is not null or q.invalidado_en is not null)));
end;
$$;

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
       or (estado = 'pagada' and pagada_en > now() - make_interval(secs => case when cliente_id is null
             then greatest(private.regla_int('pantalla.gracias_segundos'), private.regla_int('pantalla.puntos_segundos'))
             else private.regla_int('pantalla.gracias_segundos') end)))
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
    -- Venta pagada sin cliente: el iPad ofrece un QR para que el cliente reclame sus puntos con su celular.
    if v.estado = 'pagada' and v.cliente_id is null then
      v_venta := v_venta || jsonb_build_object('codigo_puntos', v.codigo_pago);
    end if;
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

