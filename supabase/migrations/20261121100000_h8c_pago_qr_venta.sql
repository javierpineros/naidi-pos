-- H8c: pagar con Bold una venta del POS escaneando el QR del iPad.
-- El QR lleva a /pagar/#<codigo_pago>; esa página (sin cuenta) le pide a una Edge Function los datos firmados del botón de Bold.
-- Como en H8b, quien decide que algo está pagado es esta base de datos con lo que Bold confirma, nunca el navegador del cliente:
--   * el monto sale SIEMPRE del total guardado de la venta;
--   * el código solo sirve mientras la venta está confirmada (sin pagar);
--   * un pago que no cuadra (monto distinto, venta ya cerrada o modificada) no se acredita y deja una alerta.

-- =============================================================================================
-- 1. Tablas: el pago puede ser de un pedido web o de una venta del POS
-- =============================================================================================
alter table public.ventas add column codigo_pago text not null default encode(extensions.gen_random_bytes(16), 'hex');
create unique index ventas_codigo_pago_idx on public.ventas (codigo_pago);

alter table public.pagos_bold alter column pedido_id drop not null;
alter table public.pagos_bold add column venta_id uuid references public.ventas (id);
alter table public.pagos_bold add constraint pagos_bold_un_destino check ((pedido_id is null) <> (venta_id is null));
create index pagos_bold_venta_idx on public.pagos_bold (venta_id) where venta_id is not null;

-- =============================================================================================
-- 2. Iniciar el pago (solo service_role: la llama la Edge Function; la persona no tiene cuenta)
-- =============================================================================================
create function public.iniciar_pago_venta_qr(p_codigo text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v  public.ventas;
  pg public.pagos_bold;
begin
  if not private.bandera_activa('pago_en_linea_bold') then
    raise exception 'El pago en línea todavía no está disponible.';
  end if;
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{32}$' then raise exception 'Este código de pago no es válido.'; end if;
  select * into v from public.ventas where codigo_pago = p_codigo for update;
  if not found then raise exception 'Este código de pago no es válido.'; end if;
  if v.estado = 'pagada' then raise exception 'Esta compra ya está pagada.'; end if;
  if v.estado = 'alistando' and v.reabierta_en is not null then
    raise exception 'Estamos actualizando tu pedido. Espera a que el vendedor lo confirme y escanea de nuevo.';
  end if;
  if v.estado <> 'confirmada' or v.canal <> 'tienda' then raise exception 'Esta compra ya no está abierta para pago.'; end if;
  if v.total_cop < 1000 then raise exception 'El pago en línea exige un total de al menos $1.000.'; end if;

  -- Un intento pendiente por un monto que ya no es el de la venta (la modificaron) deja de servir.
  update public.pagos_bold set estado = 'anulado' where venta_id = v.id and estado = 'pendiente' and monto_cop <> v.total_cop;
  select * into pg from public.pagos_bold
   where venta_id = v.id and estado = 'pendiente' and monto_cop = v.total_cop and creado_en > now() - interval '12 hours'
   order by creado_en desc limit 1;
  if not found then
    insert into public.pagos_bold (order_id, venta_id, monto_cop)
    values ('V' || v.numero || '-' || encode(extensions.gen_random_bytes(5), 'hex'), v.id, v.total_cop)
    returning * into pg;
  end if;
  return jsonb_build_object('order_id', pg.order_id, 'monto_cop', pg.monto_cop, 'moneda', pg.moneda,
                            'descripcion', 'Compra #' || v.numero || ' · Naidí');
end;
$$;

-- Referencias pendientes de una venta (por su código): la página pregunta a Bold cuando el cliente vuelve de pagar.
create function public.pagos_bold_pendientes_venta(p_codigo text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.bandera_activa('pago_en_linea_bold') then return '[]'::jsonb; end if;
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{32}$' then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('order_id', g.order_id) order by g.creado_en)
    from public.pagos_bold g join public.ventas v on v.id = g.venta_id
    where v.codigo_pago = p_codigo and g.estado = 'pendiente' and g.creado_en > now() - interval '48 hours'), '[]'::jsonb);
end;
$$;

-- Estado de la compra para la página del cliente: solo si pagó o no, sin datos de la venta.
create function public.estado_pago_venta_qr(p_codigo text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v public.ventas;
begin
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{32}$' then return jsonb_build_object('estado', 'invalido'); end if;
  select * into v from public.ventas where codigo_pago = p_codigo;
  if not found then return jsonb_build_object('estado', 'invalido'); end if;
  return jsonb_build_object('estado', case v.estado when 'pagada' then 'pagada' when 'confirmada' then 'abierta'
                                                   when 'alistando' then 'actualizando' else 'cerrada' end,
                            'total_cop', case when v.estado in ('confirmada', 'pagada') then v.total_cop end);
end;
$$;

-- =============================================================================================
-- 3. Aplicar un evento de Bold a un pago de venta (lo llama aplicar_evento_bold)
-- =============================================================================================
create function private.aplicar_evento_pago_venta(pg public.pagos_bold, p_tipo text, p_bold_payment_id text, p_monto integer,
                                                  p_moneda text, p_medio text, p_crudo jsonb) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v public.ventas;
  v_res text := 'ignorado';
begin
  select * into v from public.ventas where id = pg.venta_id for update;

  if p_tipo = 'SALE_APPROVED' then
    if pg.estado = 'aprobado' then
      return 'ya_aprobado';
    elsif p_moneda is distinct from pg.moneda or p_monto is distinct from pg.monto_cop then
      insert into public.alertas (tipo, detalle)
      values ('pago_bold', jsonb_build_object('motivo', 'monto_distinto', 'venta', v.numero, 'order_id', pg.order_id,
              'esperado', pg.monto_cop, 'recibido', p_monto, 'moneda', p_moneda));
      return 'monto_distinto';
    elsif p_bold_payment_id is not null and exists (select 1 from public.pagos_bold x where x.bold_payment_id = p_bold_payment_id and x.id <> pg.id) then
      return 'pago_repetido';
    end if;
    update public.pagos_bold set estado = 'aprobado', bold_payment_id = p_bold_payment_id, medio = left(p_medio, 40),
           evento_crudo = p_crudo, confirmado_en = now() where id = pg.id;
    if v.estado = 'confirmada' and v.total_cop = pg.monto_cop then
      perform private.pagar_interno(v.id, 'bold_online', null, now(), false);
      v_res := 'aprobado';
    else
      -- Pagó una venta que ya se cerró, que se modificó o que ya estaba pagada: requiere devolución o revisión.
      insert into public.alertas (tipo, detalle)
      values ('pago_bold', jsonb_build_object('motivo', case when v.estado = 'pagada' then 'pago_duplicado' else 'venta_no_cobrable' end,
              'venta', v.numero, 'estado_venta', v.estado, 'order_id', pg.order_id, 'monto', pg.monto_cop, 'total_venta', v.total_cop));
      v_res := 'aprobado_requiere_revision';
    end if;
    perform private.auditar('pago_bold_aprobado', 'venta', v.id::text, jsonb_build_object('order_id', pg.order_id, 'monto', pg.monto_cop, 'resultado', v_res));

  elsif p_tipo = 'SALE_REJECTED' then
    if pg.estado = 'pendiente' then
      update public.pagos_bold set estado = 'rechazado', evento_crudo = p_crudo where id = pg.id;
      v_res := 'rechazado';
    end if;

  elsif p_tipo = 'VOID_APPROVED' then
    if pg.estado = 'aprobado' then
      update public.pagos_bold set estado = 'anulado', evento_crudo = p_crudo where id = pg.id;
      -- La venta ya quedó pagada: anularla (con PIN) o devolver el dinero es decisión del dueño.
      insert into public.alertas (tipo, detalle)
      values ('pago_bold', jsonb_build_object('motivo', 'anulado_venta_pagada', 'venta', v.numero, 'estado_venta', v.estado, 'order_id', pg.order_id));
      perform private.auditar('pago_bold_anulado', 'venta', v.id::text, jsonb_build_object('order_id', pg.order_id));
      v_res := 'anulado_requiere_revision';
    end if;
  end if;
  return v_res;
end;
$$;
revoke all on function private.aplicar_evento_pago_venta(public.pagos_bold, text, text, integer, text, text, jsonb) from public;

-- Misma función de H8b, con un desvío: si el pago es de una venta del POS se aplica con la lógica de arriba.
create or replace function public.aplicar_evento_bold(p_evento_id text, p_tipo text, p_order_id text, p_bold_payment_id text,
                                                      p_monto integer, p_moneda text, p_medio text, p_crudo jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ev     bigint;
  v_res    text := 'ignorado';
  pg       public.pagos_bold;
  p        public.pedidos_web;
  v_abierto boolean;
begin
  if not private.bandera_activa('pago_en_linea_bold') then
    return jsonb_build_object('resultado', 'bandera_apagada');
  end if;
  if p_evento_id is null or length(p_evento_id) = 0 or length(p_evento_id) > 120 then
    raise exception 'Falta el id del evento.';
  end if;

  insert into public.bold_eventos (bold_evento_id, tipo, order_id) values (p_evento_id, left(coalesce(p_tipo, ''), 40), left(p_order_id, 80))
  on conflict (bold_evento_id) do nothing returning id into v_ev;
  if v_ev is null then return jsonb_build_object('resultado', 'duplicado'); end if;

  select * into pg from public.pagos_bold where order_id = p_order_id for update;
  if not found then
    v_res := 'orden_desconocida';
  elsif pg.venta_id is not null then
    v_res := private.aplicar_evento_pago_venta(pg, p_tipo, p_bold_payment_id, p_monto, p_moneda, p_medio, p_crudo);
  else
    select * into p from public.pedidos_web where id = pg.pedido_id for update;
    v_abierto := p.estado in ('recibido', 'preparando', 'listo');

    if p_tipo = 'SALE_APPROVED' then
      if pg.estado = 'aprobado' then
        v_res := 'ya_aprobado';
      elsif p_moneda is distinct from pg.moneda or p_monto is distinct from pg.monto_cop then
        insert into public.alertas (tipo, cliente_id, detalle)
        values ('pago_bold', p.cliente_id, jsonb_build_object('motivo', 'monto_distinto', 'pedido', p.numero, 'order_id', p_order_id,
                'esperado', pg.monto_cop, 'recibido', p_monto, 'moneda', p_moneda));
        v_res := 'monto_distinto';
      elsif p_bold_payment_id is not null and exists (select 1 from public.pagos_bold x where x.bold_payment_id = p_bold_payment_id and x.id <> pg.id) then
        v_res := 'pago_repetido';
      else
        update public.pagos_bold set estado = 'aprobado', bold_payment_id = p_bold_payment_id, medio = left(p_medio, 40),
               evento_crudo = p_crudo, confirmado_en = now() where id = pg.id;
        if v_abierto and p.pago_en_linea_estado = 'pendiente' then
          update public.pedidos_web set pago_en_linea_estado = 'pagado' where id = p.id;
          v_res := 'aprobado';
        else
          insert into public.alertas (tipo, cliente_id, detalle)
          values ('pago_bold', p.cliente_id, jsonb_build_object('motivo', case when v_abierto then 'pago_duplicado' else 'pedido_cerrado' end,
                  'pedido', p.numero, 'estado_pedido', p.estado, 'order_id', p_order_id, 'monto', pg.monto_cop));
          v_res := 'aprobado_requiere_revision';
        end if;
        perform private.auditar('pago_bold_aprobado', 'pedido_web', p.id::text, jsonb_build_object('order_id', p_order_id, 'monto', pg.monto_cop, 'resultado', v_res));
      end if;

    elsif p_tipo = 'SALE_REJECTED' then
      if pg.estado = 'pendiente' then
        update public.pagos_bold set estado = 'rechazado', evento_crudo = p_crudo where id = pg.id;
        v_res := 'rechazado';
      end if;

    elsif p_tipo = 'VOID_APPROVED' then
      if pg.estado = 'aprobado' then
        update public.pagos_bold set estado = 'anulado', evento_crudo = p_crudo where id = pg.id;
        if v_abierto then
          update public.pedidos_web set pago_en_linea_estado = 'pendiente' where id = p.id;
          v_res := 'anulado';
        else
          insert into public.alertas (tipo, cliente_id, detalle)
          values ('pago_bold', p.cliente_id, jsonb_build_object('motivo', 'anulado_pedido_cerrado', 'pedido', p.numero, 'estado_pedido', p.estado, 'order_id', p_order_id));
          v_res := 'anulado_requiere_revision';
        end if;
        perform private.auditar('pago_bold_anulado', 'pedido_web', p.id::text, jsonb_build_object('order_id', p_order_id, 'resultado', v_res));
      end if;
    end if;
  end if;

  update public.bold_eventos set procesado_en = now(), resultado = v_res where id = v_ev;
  return jsonb_build_object('resultado', v_res);
end;
$$;

-- =============================================================================================
-- 4. Reabrir una venta invalida sus intentos de pago pendientes
-- =============================================================================================
create or replace function public.reabrir_venta(p_venta uuid) returns void
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
  update public.vouchers set estado = 'reservado', usado_en = null where venta_id = p_venta and estado = 'usado';
  -- Un pago a medias con el total anterior ya no es válido; si Bold lo aprueba igual, queda como alerta de revisión.
  update public.pagos_bold set estado = 'anulado' where venta_id = p_venta and estado = 'pendiente';
  perform private.evento(p_venta, 'confirmada', 'alistando', 'reabierta');
  perform private.auditar('reabrir_venta', 'venta', p_venta::text);
end;
$$;

-- =============================================================================================
-- 5. El iPad recibe el código para dibujar el QR (solo con la bandera encendida y la venta lista para cobrar)
-- =============================================================================================
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

-- =============================================================================================
-- 6. Permisos: las funciones de la página del cliente las llama solo la Edge Function (service_role)
-- =============================================================================================
revoke all on function public.iniciar_pago_venta_qr(text), public.pagos_bold_pendientes_venta(text), public.estado_pago_venta_qr(text) from public, anon, authenticated;
grant execute on function public.iniciar_pago_venta_qr(text), public.pagos_bold_pendientes_venta(text), public.estado_pago_venta_qr(text) to service_role;

-- =============================================================================================
-- 7. El panel del dueño también ve los pagos de compras del POS (pedido web o compra del iPad)
-- =============================================================================================
create or replace function public.pagos_bold_resumen() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  return jsonb_build_object(
    'activo', private.bandera_activa('pago_en_linea_bold'),
    'pendientes', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', g.order_id, 'pedido', w.numero, 'venta', v.numero, 'monto_cop', g.monto_cop, 'creado_en', g.creado_en,
               'cliente', p.nombre) order by g.creado_en)
        from public.pagos_bold g
        left join public.pedidos_web w on w.id = g.pedido_id
        left join public.ventas v on v.id = g.venta_id
        left join public.perfiles p on p.user_id = w.cliente_id
       where g.estado = 'pendiente' and g.creado_en > now() - interval '48 hours'), '[]'::jsonb),
    'devoluciones', coalesce((
      select jsonb_agg(jsonb_build_object(
               'alerta_id', a.id, 'creada_en', a.creada_en, 'motivo', a.detalle ->> 'motivo', 'pedido', a.detalle -> 'pedido',
               'order_id', a.detalle ->> 'order_id', 'cliente', p.nombre, 'correo', u.email,
               'monto_cop', coalesce(g.monto_cop, nullif(a.detalle ->> 'monto', '')::integer), 'bold_payment_id', g.bold_payment_id,
               'detalle', a.detalle) order by a.creada_en)
        from public.alertas a
        left join public.pagos_bold g on g.order_id = a.detalle ->> 'order_id'
        left join public.perfiles p on p.user_id = a.cliente_id
        left join auth.users u on u.id = a.cliente_id
       where a.tipo = 'pago_bold' and a.resuelta_en is null), '[]'::jsonb),
    'recientes', coalesce((
      select jsonb_agg(x.j order by x.creado_en desc)
        from (select g.creado_en,
                     jsonb_build_object('order_id', g.order_id, 'pedido', w.numero, 'venta', v.numero, 'monto_cop', g.monto_cop, 'estado', g.estado,
                       'medio', g.medio, 'creado_en', g.creado_en, 'confirmado_en', g.confirmado_en) as j
                from public.pagos_bold g
                left join public.pedidos_web w on w.id = g.pedido_id
                left join public.ventas v on v.id = g.venta_id
               order by g.creado_en desc limit 15) x), '[]'::jsonb),
    'ultima_conciliacion', (select jsonb_build_object('corrida_en', c.corrida_en, 'revisados', c.revisados, 'resumen', c.resumen)
                              from public.bold_conciliaciones c order by c.id desc limit 1));
end;
$$;
