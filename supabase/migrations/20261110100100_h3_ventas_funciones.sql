-- H3 (2/3): funciones del servidor. Todas con search_path fijo; las que expone la API verifican el rol dentro.
-- El cliente nunca envía montos ni puntos: el servidor los calcula a partir del catálogo y de las reglas vigentes.

-- ---------------------------------------------------------------------------------------------
-- Ayudantes internos (esquema private, no expuesto)
-- ---------------------------------------------------------------------------------------------
create function private.exigir_staff() returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select private.es_staff()) then
    raise exception 'Solo el personal puede hacer esto.' using errcode = '42501';
  end if;
end;
$$;

create function private.exigir_dueno() returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select private.es_dueno()) then
    raise exception 'Solo el dueño puede hacer esto.' using errcode = '42501';
  end if;
end;
$$;

create function private.exigir_cliente() returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not exists (select 1 from public.perfiles where user_id = v_uid) then
    raise exception 'Inicia sesión con tu cuenta para continuar.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function private.regla_int(p_clave text) returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare v jsonb := private.regla_vigente(p_clave);
begin
  if v is null or jsonb_typeof(v) <> 'number' then
    raise exception 'Falta la regla numérica vigente "%".', p_clave;
  end if;
  return (v #>> '{}')::integer;
end;
$$;

-- Versiones de reglas usadas, para dejarlas en cada movimiento del libro.
create function private.versiones_reglas(p_claves text[]) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_object_agg(r.clave, r.version), '{}'::jsonb)
  from public.reglas_negocio r
  where r.clave = any (p_claves) and r.vigente_desde <= now() and (r.vigente_hasta is null or r.vigente_hasta > now());
$$;

create function private.evento(p_venta uuid, p_de text, p_a text, p_motivo text default null, p_detalle jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.venta_eventos (venta_id, de_estado, a_estado, actor, motivo, detalle)
  values (p_venta, p_de, p_a, (select auth.uid()), p_motivo, coalesce(p_detalle, '{}'::jsonb));
$$;

create function private.recalcular_totales(p_venta uuid) returns void
language sql security definer set search_path = ''
as $$
  update public.ventas v set
    subtotal_cop  = coalesce((select sum(l.cantidad * l.precio_unitario_cop) from public.venta_lineas l where l.venta_id = v.id), 0),
    descuento_cop = coalesce((select sum(l.descuento_cop) from public.venta_lineas l where l.venta_id = v.id), 0),
    total_cop     = coalesce((select sum(l.cantidad * l.precio_unitario_cop) from public.venta_lineas l where l.venta_id = v.id), 0)
                  - coalesce((select sum(l.descuento_cop) from public.venta_lineas l where l.venta_id = v.id), 0)
  where v.id = p_venta;
$$;

-- Precio de una línea a partir del catálogo (mismas reglas que la web):
--   menú: precio del tamaño + todos los toppings agregados; personalizado: precio del tamaño + los toppings
--   que pasen de los incluidos; café y litro: precio fijo.
create function private.precio_linea(p_producto text, p_tamano text, p_presentacion text, p_base text, p_toppings text[])
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  pr   public.productos;
  tm   public.tamanos;
  t    public.toppings;
  k    text;
  i    integer := 0;
  v_unit integer;
  v_extra boolean;
  v_tops jsonb := '[]'::jsonb;
  v_pres text := null;
  v_base text := null;
begin
  select * into pr from public.productos where clave = p_producto and activo;
  if not found then
    raise exception 'El producto "%" no está disponible.', p_producto;
  end if;

  if pr.usa_tamanos then
    select * into tm from public.tamanos where clave = p_tamano and activo;
    if not found then
      raise exception 'Elige un tamaño válido para "%".', pr.nombre;
    end if;
    v_unit := tm.precio_cop;
    v_pres := coalesce(p_presentacion, 'bowl');
    if not exists (select 1 from public.presentaciones where clave = v_pres) then
      raise exception 'Presentación no válida: %.', v_pres;
    end if;
    if pr.tipo = 'personalizado' then
      if not exists (select 1 from public.bases where clave = p_base and activo) then
        raise exception 'Elige una base válida para el bowl personalizado.';
      end if;
      v_base := p_base;
    end if;
    foreach k in array coalesce(p_toppings, '{}'::text[]) loop
      select * into t from public.toppings where clave = k and activo;
      if not found then
        raise exception 'El topping "%" no está disponible.', k;
      end if;
      i := i + 1;
      v_extra := (pr.tipo = 'menu') or (i > tm.toppings_incluidos);
      if v_extra then v_unit := v_unit + t.precio_cop; end if;
      v_tops := v_tops || jsonb_build_array(jsonb_build_object('clave', t.clave, 'nombre', t.nombre, 'precio_cop', t.precio_cop, 'extra', v_extra));
    end loop;
  else
    if p_tamano is not null or cardinality(coalesce(p_toppings, '{}'::text[])) > 0 then
      raise exception '"%" no lleva tamaño ni toppings.', pr.nombre;
    end if;
    v_unit := pr.precio_fijo_cop;
  end if;

  return jsonb_build_object('producto_nombre', pr.nombre, 'categoria', pr.categoria, 'tamano', p_tamano,
    'presentacion', v_pres, 'base', v_base, 'toppings', v_tops, 'precio_unitario_cop', v_unit);
end;
$$;

-- Libera los vouchers que una venta tenía reservados o usados.
create function private.liberar_vouchers(p_venta uuid) returns void
language sql security definer set search_path = ''
as $$
  update public.vouchers set estado = 'activo', venta_id = null, usado_en = null where venta_id = p_venta;
$$;

-- Regalo de bienvenida: una vez por cuenta, mientras no haya vendido nada confirmado.
create function private.otorgar_bienvenida(p_cliente uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_regalo jsonb := private.regla_vigente('bienvenida.regalo');
begin
  if v_regalo is null or jsonb_typeof(v_regalo) <> 'object' then return; end if;
  if exists (select 1 from public.ventas where cliente_id = p_cliente and estado in ('confirmada', 'pagada')) then return; end if;
  insert into public.vouchers (cliente_id, tipo, descuento_pct, tamanos_permitidos, vence_en)
  values (p_cliente, 'bienvenida', (v_regalo ->> 'descuento_pct')::smallint,
          array(select jsonb_array_elements_text(v_regalo -> 'tamanos')),
          now() + make_interval(days => private.regla_int('voucher.vigencia_dias')))
  on conflict do nothing;
end;
$$;

-- Puntos de una venta pagada: 1 por cada N pesos efectivamente pagados, en las categorías que suman.
-- Devuelve los puntos acreditados (0 si ya estaban acreditados o no alcanza).
create function private.acreditar_puntos(p_venta uuid, p_cliente uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_base integer;
  v_pts  integer;
  v_ins  integer;
begin
  select coalesce(sum(l.cantidad * l.precio_unitario_cop - l.descuento_cop), 0)::integer into v_base
  from public.venta_lineas l
  where l.venta_id = p_venta
    and l.categoria in (select jsonb_array_elements_text(private.regla_vigente('puntos.categorias_que_suman')));
  v_pts := floor(v_base::numeric / private.regla_int('puntos.cop_por_punto'))::integer;
  if v_pts <= 0 then return 0; end if;
  insert into public.puntos_libro (cliente_id, tipo, puntos, venta_id, regla_versiones)
  values (p_cliente, 'suma', v_pts, p_venta, private.versiones_reglas(array['puntos.cop_por_punto', 'puntos.categorias_que_suman']))
  on conflict (venta_id) where tipo = 'suma' do nothing
  returning puntos into v_ins;
  return coalesce(v_ins, 0);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Armado de la venta (personal)
-- ---------------------------------------------------------------------------------------------
create function public.crear_venta(p_idem uuid, p_cliente uuid default null, p_offline boolean default false, p_creada_en timestamptz default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  perform private.exigir_staff();
  if p_idem is null then raise exception 'Falta la clave de idempotencia de la venta.'; end if;
  if p_cliente is not null and not exists (select 1 from public.perfiles where user_id = p_cliente) then
    raise exception 'Ese cliente no existe.';
  end if;
  insert into public.ventas (idempotency_key, cliente_id, creada_por, creada_offline, creada_en)
  values (p_idem, p_cliente, (select auth.uid()), coalesce(p_offline, false),
          case when p_offline then least(coalesce(p_creada_en, now()), now()) else now() end)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.ventas where idempotency_key = p_idem;
    return v_id;
  end if;
  perform private.evento(v_id, null, 'alistando');
  if p_cliente is not null then perform private.otorgar_bienvenida(p_cliente); end if;
  return v_id;
end;
$$;

-- El vendedor elige en la lista de espera quién es el cliente. Cambiar un cliente ya asignado
-- (reasignar) queda para el dueño con PIN en H4.
create function public.asignar_cliente(p_venta uuid, p_cliente uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'alistando' then raise exception 'El cliente se asigna mientras se alista la venta.'; end if;
  if v.cliente_id is not null then
    raise exception 'La venta ya tiene cliente; reasignarlo requiere al dueño con PIN.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.perfiles where user_id = p_cliente) then raise exception 'Ese cliente no existe.'; end if;
  update public.ventas set cliente_id = p_cliente where id = p_venta;
  perform private.otorgar_bienvenida(p_cliente);
  perform private.auditar('asignar_cliente', 'venta', p_venta::text, jsonb_build_object('cliente', p_cliente));
end;
$$;

create function public.agregar_linea(p_venta uuid, p_producto text, p_tamano text default null, p_presentacion text default null,
                                     p_base text default null, p_toppings text[] default '{}', p_cantidad integer default 1)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v public.ventas;
  p jsonb;
  v_id uuid;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'alistando' then raise exception 'Solo se agregan productos mientras la venta está en alistando.'; end if;
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > 20 then raise exception 'La cantidad debe estar entre 1 y 20.'; end if;
  p := private.precio_linea(p_producto, p_tamano, p_presentacion, p_base, p_toppings);
  insert into public.venta_lineas (venta_id, orden, producto_clave, producto_nombre, categoria, tamano, presentacion, base, toppings, cantidad, precio_unitario_cop)
  values (p_venta, coalesce((select max(orden) from public.venta_lineas where venta_id = p_venta), 0) + 1, p_producto,
          p ->> 'producto_nombre', p ->> 'categoria', p ->> 'tamano', p ->> 'presentacion', p ->> 'base',
          p -> 'toppings', p_cantidad, (p ->> 'precio_unitario_cop')::integer)
  returning id into v_id;
  perform private.recalcular_totales(p_venta);
  return v_id;
end;
$$;

create function public.quitar_linea(p_linea uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.venta_lineas;
  v public.ventas;
begin
  perform private.exigir_staff();
  select * into l from public.venta_lineas where id = p_linea;
  if not found then raise exception 'La línea no existe.'; end if;
  select * into v from public.ventas where id = l.venta_id for update;
  if v.estado <> 'alistando' then raise exception 'Solo se quitan productos mientras la venta está en alistando.'; end if;
  if l.voucher_id is not null then
    update public.vouchers set estado = 'activo', venta_id = null, usado_en = null where id = l.voucher_id;
  end if;
  delete from public.venta_lineas where id = p_linea;
  perform private.recalcular_totales(l.venta_id);
end;
$$;

create function public.aplicar_voucher(p_linea uuid, p_voucher uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.venta_lineas;
  v public.ventas;
  w public.vouchers;
begin
  perform private.exigir_staff();
  select * into l from public.venta_lineas where id = p_linea;
  if not found then raise exception 'La línea no existe.'; end if;
  select * into v from public.ventas where id = l.venta_id for update;
  if v.estado <> 'alistando' then raise exception 'Solo se aplica un premio mientras la venta está en alistando.'; end if;
  select * into w from public.vouchers where id = p_voucher for update;
  if not found then raise exception 'El premio no existe.'; end if;
  if v.cliente_id is null or w.cliente_id <> v.cliente_id then
    raise exception 'Ese premio no es del cliente de esta venta.';
  end if;
  if w.estado <> 'activo' then raise exception 'Ese premio ya se usó o está en otra venta.'; end if;
  if w.vence_en <= now() then raise exception 'Ese premio ya venció.'; end if;
  if l.voucher_id is not null then raise exception 'Esa línea ya tiene un premio aplicado.'; end if;
  if l.tamano is null or not (l.tamano = any (w.tamanos_permitidos)) then
    raise exception 'Ese premio no aplica a este producto o tamaño.';
  end if;
  update public.venta_lineas
     set voucher_id = p_voucher, descuento_cop = round(precio_unitario_cop * w.descuento_pct / 100.0)::integer
   where id = p_linea;
  update public.vouchers set estado = 'reservado', venta_id = l.venta_id where id = p_voucher;
  perform private.recalcular_totales(l.venta_id);
  perform private.auditar('aplicar_voucher', 'venta', l.venta_id::text, jsonb_build_object('voucher', p_voucher, 'tipo', w.tipo, 'linea', p_linea));
end;
$$;

create function public.quitar_voucher(p_linea uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.venta_lineas;
  v public.ventas;
begin
  perform private.exigir_staff();
  select * into l from public.venta_lineas where id = p_linea;
  if not found then raise exception 'La línea no existe.'; end if;
  select * into v from public.ventas where id = l.venta_id for update;
  if v.estado <> 'alistando' then raise exception 'Solo se quita un premio mientras la venta está en alistando.'; end if;
  if l.voucher_id is null then return; end if;
  update public.vouchers set estado = 'activo', venta_id = null, usado_en = null where id = l.voucher_id;
  update public.venta_lineas set voucher_id = null, descuento_cop = 0 where id = p_linea;
  perform private.recalcular_totales(l.venta_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Transiciones
-- ---------------------------------------------------------------------------------------------
create function private.confirmar_interno(p_venta uuid, p_cuando timestamptz) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'alistando' then raise exception 'Solo se confirma una venta en alistando (estado actual: %).', v.estado; end if;
  if not exists (select 1 from public.venta_lineas where venta_id = p_venta) then
    raise exception 'La venta no tiene productos.';
  end if;
  perform private.recalcular_totales(p_venta);
  update public.ventas set estado = 'confirmada', confirmada_en = p_cuando where id = p_venta;
  update public.vouchers set estado = 'usado', usado_en = p_cuando where venta_id = p_venta and estado = 'reservado';
  perform private.evento(p_venta, 'alistando', 'confirmada');
end;
$$;

create function public.confirmar_venta(p_venta uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  perform private.confirmar_interno(p_venta, now());
  select * into v from public.ventas where id = p_venta;
  return jsonb_build_object('venta_id', v.id, 'estado', v.estado, 'subtotal_cop', v.subtotal_cop,
                            'descuento_cop', v.descuento_cop, 'total_cop', v.total_cop);
end;
$$;

create function public.descartar_venta(p_venta uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'alistando' then raise exception 'Solo se descarta una venta en alistando; si ya está confirmada, cancélala con un motivo.'; end if;
  update public.ventas set estado = 'cancelada', cancelada_en = now(), motivo_cancelacion = 'descartada' where id = p_venta;
  perform private.liberar_vouchers(p_venta);
  perform private.evento(p_venta, 'alistando', 'cancelada', 'descartada');
end;
$$;

create function public.cancelar_venta(p_venta uuid, p_motivo text) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  if p_motivo is null or length(btrim(p_motivo)) = 0 then raise exception 'Escribe el motivo de la cancelación.'; end if;
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'confirmada' then
    raise exception 'Solo se cancela una venta confirmada y sin pagar (estado actual: %); una venta pagada solo la anula el dueño.', v.estado;
  end if;
  update public.ventas set estado = 'cancelada', cancelada_en = now(), motivo_cancelacion = btrim(p_motivo) where id = p_venta;
  perform private.liberar_vouchers(p_venta);
  perform private.evento(p_venta, 'confirmada', 'cancelada', btrim(p_motivo));
  perform private.auditar('cancelar_venta', 'venta', p_venta::text, jsonb_build_object('motivo', btrim(p_motivo), 'total_cop', v.total_cop));
end;
$$;

-- Cobro: registra el medio de pago, acredita los puntos (si hay cliente) o emite el QR posterior (si no).
create function private.pagar_interno(p_venta uuid, p_medio text, p_efectivo integer, p_cuando timestamptz, p_emitir_qr boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v public.ventas;
  v_cambio integer := null;
  v_pts integer := 0;
  v_token text := null;
begin
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'confirmada' then raise exception 'Solo se cobra una venta confirmada (estado actual: %).', v.estado; end if;
  if p_medio not in ('efectivo', 'datafono_bold', 'transferencia', 'bold_online') then
    raise exception 'Medio de pago no válido: %.', p_medio;
  end if;
  if p_medio = 'efectivo' then
    if p_efectivo is null or p_efectivo < v.total_cop then
      raise exception 'El efectivo recibido no alcanza para el total de %.', v.total_cop;
    end if;
    v_cambio := p_efectivo - v.total_cop;
  elsif p_efectivo is not null then
    raise exception 'El efectivo recibido solo aplica al pago en efectivo.';
  end if;

  update public.ventas
     set estado = 'pagada', pagada_en = p_cuando, medio_pago = p_medio,
         efectivo_recibido_cop = p_efectivo, cambio_cop = v_cambio
   where id = p_venta;
  perform private.evento(p_venta, 'confirmada', 'pagada', null, jsonb_build_object('medio_pago', p_medio));

  if v.cliente_id is not null then
    v_pts := private.acreditar_puntos(p_venta, v.cliente_id);
  elsif p_emitir_qr then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');   -- 256 bits
    insert into public.qr_posventa (venta_id, token_hash, vence_en)
    values (p_venta, extensions.digest(v_token, 'sha256'),
            p_cuando + make_interval(mins => private.regla_int('qr_posventa.vigencia_min')));
  end if;

  return jsonb_build_object('venta_id', p_venta, 'estado', 'pagada', 'total_cop', v.total_cop,
                            'cambio_cop', v_cambio, 'puntos_acreditados', v_pts, 'qr_token', v_token);
end;
$$;

-- El pago en línea (bold_online) lo registra solo el servidor al recibir el webhook (H8b), no el POS.
create function public.pagar_venta(p_venta uuid, p_medio text, p_efectivo_recibido integer default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  if p_medio = 'bold_online' then
    raise exception 'El pago en línea se registra solo desde el servidor.' using errcode = '42501';
  end if;
  return private.pagar_interno(p_venta, p_medio, p_efectivo_recibido, now(), true);
end;
$$;

-- Anulación de una venta pagada: solo el dueño. (H4 le suma la verificación del PIN.)
create function public.anular_venta(p_venta uuid, p_motivo text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v public.ventas;
  v_pts integer;
begin
  perform private.exigir_dueno();
  if p_motivo is null or length(btrim(p_motivo)) = 0 then raise exception 'Escribe el motivo de la anulación.'; end if;
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'pagada' then raise exception 'Solo se anula una venta pagada (estado actual: %).', v.estado; end if;

  update public.ventas
     set estado = 'anulada', anulada_en = now(), anulada_por = (select auth.uid()), motivo_anulacion = btrim(p_motivo)
   where id = p_venta;
  update public.qr_posventa set invalidado_en = now() where venta_id = p_venta and invalidado_en is null;
  perform private.liberar_vouchers(p_venta);

  select puntos into v_pts from public.puntos_libro where venta_id = p_venta and tipo = 'suma';
  if v_pts is not null then
    insert into public.puntos_libro (cliente_id, tipo, puntos, venta_id, regla_versiones, nota)
    select cliente_id, 'anulacion', -puntos, venta_id, regla_versiones, btrim(p_motivo)
      from public.puntos_libro where venta_id = p_venta and tipo = 'suma'
    on conflict (venta_id) where tipo = 'anulacion' do nothing;
  end if;

  perform private.evento(p_venta, 'pagada', 'anulada', btrim(p_motivo));
  perform private.auditar('anular_venta', 'venta', p_venta::text,
    jsonb_build_object('motivo', btrim(p_motivo), 'total_cop', v.total_cop, 'puntos_revertidos', coalesce(v_pts, 0)));
  return jsonb_build_object('venta_id', p_venta, 'estado', 'anulada', 'puntos_revertidos', coalesce(v_pts, 0));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Venta sin internet: el POS la guarda localmente y la sincroniza aquí, sin cliente.
-- Idempotente por clave: reenviar la misma venta devuelve la ya registrada.
-- ---------------------------------------------------------------------------------------------
create function public.registrar_venta_offline(p_idem uuid, p_creada_en timestamptz, p_lineas jsonb, p_medio text,
                                               p_efectivo_recibido integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_cuando timestamptz;
  e jsonb;
  v_res jsonb;
begin
  perform private.exigir_staff();
  if p_medio = 'bold_online' then raise exception 'El pago en línea se registra solo desde el servidor.' using errcode = '42501'; end if;
  select id into v_id from public.ventas where idempotency_key = p_idem;
  if v_id is not null then
    return jsonb_build_object('venta_id', v_id, 'duplicada', true);
  end if;
  v_cuando := least(coalesce(p_creada_en, now()), now());
  if v_cuando < now() - interval '7 days' then
    raise exception 'Esta venta es de hace más de 7 días; revísala con el dueño antes de registrarla.';
  end if;
  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'La venta no tiene productos.';
  end if;

  v_id := public.crear_venta(p_idem, null, true, v_cuando);
  for e in select * from jsonb_array_elements(p_lineas) loop
    perform public.agregar_linea(v_id, e ->> 'producto', e ->> 'tamano', e ->> 'presentacion', e ->> 'base',
      coalesce(array(select jsonb_array_elements_text(coalesce(e -> 'toppings', '[]'::jsonb))), '{}'::text[]),
      coalesce((e ->> 'cantidad')::integer, 1));
  end loop;
  perform private.confirmar_interno(v_id, v_cuando);
  v_res := private.pagar_interno(v_id, p_medio, p_efectivo_recibido, v_cuando, false);
  return jsonb_build_object('venta_id', v_id, 'duplicada', false, 'total_cop', v_res -> 'total_cop', 'cambio_cop', v_res -> 'cambio_cop');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- QR posterior a la venta: el cliente reclama los puntos de una venta pagada sin cliente.
-- Un solo uso garantizado por un UPDATE atómico; los reclamos simultáneos se serializan en la fila.
-- ---------------------------------------------------------------------------------------------
create function public.reclamar_qr_posventa(p_token text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  v_venta uuid;
  v_hoy timestamptz := (date_trunc('day', now() at time zone 'America/Bogota')) at time zone 'America/Bogota';
  v_pts integer;
begin
  if p_token is null or length(p_token) <> 64 or p_token !~ '^[0-9a-f]+$' then
    raise exception 'Este QR no es válido, ya se usó o venció.';
  end if;
  if (select count(*) from public.qr_posventa where usado_por = v_uid and usado_en >= v_hoy)
       >= private.regla_int('antifraude.max_reclamos_qr_dia') then
    raise exception 'Llegaste al tope de reclamos de hoy. Inténtalo mañana o habla con el personal.';
  end if;

  update public.qr_posventa q
     set usado_en = now(), usado_por = v_uid
   where q.token_hash = extensions.digest(p_token, 'sha256')
     and q.usado_en is null and q.invalidado_en is null and q.vence_en > now()
  returning q.venta_id into v_venta;
  if v_venta is null then
    raise exception 'Este QR no es válido, ya se usó o venció.';
  end if;

  update public.ventas set cliente_id = v_uid where id = v_venta and cliente_id is null and estado = 'pagada';
  if not found then
    raise exception 'Este QR no es válido, ya se usó o venció.';   -- revierte también el uso del token
  end if;
  v_pts := private.acreditar_puntos(v_venta, v_uid);
  perform private.auditar('reclamar_qr_posventa', 'venta', v_venta::text, jsonb_build_object('cliente', v_uid, 'puntos', v_pts));
  return jsonb_build_object('venta_id', v_venta, 'puntos_acreditados', v_pts);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Canje: el cliente activa su premio; se descuentan los puntos y queda un voucher de un solo uso.
-- El perfil se bloquea para que dos canjes simultáneos no gasten los mismos puntos.
-- ---------------------------------------------------------------------------------------------
create function public.canjear_premio(p_tamano text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  v_umbral integer;
  v_saldo integer;
  v_id uuid;
  v_vence timestamptz;
begin
  perform 1 from public.perfiles where user_id = v_uid for update;
  v_umbral := (private.regla_vigente('premio.umbrales_puntos') ->> p_tamano)::integer;
  if v_umbral is null then raise exception 'Ese tamaño no entra al premio.'; end if;
  select coalesce(sum(puntos), 0) into v_saldo from public.puntos_libro where cliente_id = v_uid;
  if v_saldo < v_umbral then
    raise exception 'Te faltan % puntos para este premio.', v_umbral - v_saldo;
  end if;
  v_vence := now() + make_interval(days => private.regla_int('voucher.vigencia_dias'));
  insert into public.vouchers (cliente_id, tipo, descuento_pct, tamanos_permitidos, vence_en)
  values (v_uid, 'premio', private.regla_int('premio.descuento_pct'), array[p_tamano], v_vence)
  returning id into v_id;
  insert into public.puntos_libro (cliente_id, tipo, puntos, voucher_id, regla_versiones)
  values (v_uid, 'canje', -v_umbral, v_id, private.versiones_reglas(array['premio.umbrales_puntos', 'premio.descuento_pct', 'voucher.vigencia_dias']));
  return jsonb_build_object('voucher_id', v_id, 'tamano', p_tamano, 'puntos_descontados', v_umbral, 'vence_en', v_vence);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Lecturas del cliente (sin acceso directo a las tablas)
-- ---------------------------------------------------------------------------------------------
create function public.mi_saldo() returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return (select coalesce(sum(puntos), 0)::integer from public.puntos_libro where cliente_id = v_uid);
end;
$$;

create function public.mis_movimientos(p_limite integer default 50) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('tipo', m.tipo, 'puntos', m.puntos, 'creado_en', m.creado_en) order by m.creado_en desc, m.id desc)
    from (select * from public.puntos_libro where cliente_id = v_uid order by creado_en desc, id desc limit least(greatest(p_limite, 1), 200)) m
  ), '[]'::jsonb);
end;
$$;

create function public.mis_vouchers() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'tipo', w.tipo, 'descuento_pct', w.descuento_pct,
             'tamanos', w.tamanos_permitidos, 'estado', w.estado, 'vence_en', w.vence_en) order by w.vence_en)
    from public.vouchers w
    where w.cliente_id = v_uid and w.estado in ('activo', 'reservado') and w.vence_en > now()
  ), '[]'::jsonb);
end;
$$;

-- La compra en curso: confirmada ("Por pagar") o pagada hace poco ("Pagado" con sus puntos nuevos).
create function public.mi_compra_en_curso() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return (
    select jsonb_build_object(
      'venta_id', v.id, 'estado', v.estado, 'subtotal_cop', v.subtotal_cop, 'descuento_cop', v.descuento_cop,
      'total_cop', v.total_cop, 'medio_pago', v.medio_pago,
      'puntos_ganados', coalesce((select sum(p.puntos) from public.puntos_libro p where p.venta_id = v.id and p.tipo = 'suma'), 0),
      'lineas', (select jsonb_agg(jsonb_build_object('producto', l.producto_nombre, 'tamano', l.tamano, 'presentacion', l.presentacion,
                   'toppings', l.toppings, 'cantidad', l.cantidad, 'precio_unitario_cop', l.precio_unitario_cop,
                   'descuento_cop', l.descuento_cop) order by l.orden)
                 from public.venta_lineas l where l.venta_id = v.id))
    from public.ventas v
    where v.cliente_id = v_uid
      and (v.estado = 'confirmada' or (v.estado = 'pagada' and v.pagada_en > now() - interval '10 minutes'))
    order by v.confirmada_en desc nulls last
    limit 1);
end;
$$;

-- Para el POS: premios que el cliente tiene listos (regalo o canje) al armar la venta.
create function public.vouchers_activos_de(p_cliente uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'tipo', w.tipo, 'descuento_pct', w.descuento_pct,
             'tamanos', w.tamanos_permitidos, 'vence_en', w.vence_en) order by w.vence_en)
    from public.vouchers w
    where w.cliente_id = p_cliente and w.estado = 'activo' and w.vence_en > now()
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Permisos de ejecución: nada para anónimos; los internos no se exponen.
-- ---------------------------------------------------------------------------------------------
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
