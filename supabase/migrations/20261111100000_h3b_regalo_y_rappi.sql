-- H3b: (1) regalo de bienvenida flexible (toppings gratis o porcentaje de la compra o descuento en un bowl)
--      (2) ventas de Rappi registradas en el POS (una por pedido, pagadas, sin cliente ni puntos).

-- =============================================================================================
-- 1. Vouchers con varias modalidades
-- =============================================================================================
alter table public.vouchers
  add column modalidad text not null default 'descuento_linea'
    check (modalidad in ('descuento_linea', 'toppings_gratis', 'descuento_compra')),
  add column cantidad_toppings smallint,
  add column toppings_permitidos text[];
alter table public.vouchers alter column descuento_pct drop not null;
alter table public.vouchers alter column tamanos_permitidos drop not null;
alter table public.vouchers add constraint vouchers_modalidad_coherente check (
     (modalidad = 'descuento_linea'  and descuento_pct is not null and tamanos_permitidos is not null and cantidad_toppings is null)
  or (modalidad = 'descuento_compra' and descuento_pct is not null and cantidad_toppings is null)
  or (modalidad = 'toppings_gratis'  and cantidad_toppings between 1 and 20 and descuento_pct is null));

-- Descuento sobre toda la compra: un voucher por venta.
alter table public.ventas add column voucher_compra_id uuid references public.vouchers (id);

-- Totales: el descuento de compra se calcula sobre lo que queda tras los descuentos de línea.
drop function private.recalcular_totales(uuid);
create function private.recalcular_totales(p_venta uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_sub integer;
  v_desc_lineas integer;
  v_pct smallint;
  v_compra integer := 0;
begin
  select coalesce(sum(cantidad * precio_unitario_cop), 0), coalesce(sum(descuento_cop), 0)
    into v_sub, v_desc_lineas from public.venta_lineas where venta_id = p_venta;
  select w.descuento_pct into v_pct
    from public.ventas v join public.vouchers w on w.id = v.voucher_compra_id where v.id = p_venta;
  if v_pct is not null then
    v_compra := round((v_sub - v_desc_lineas) * v_pct / 100.0)::integer;
  end if;
  update public.ventas
     set subtotal_cop = v_sub, descuento_cop = v_desc_lineas + v_compra, total_cop = v_sub - v_desc_lineas - v_compra
   where id = p_venta;
end;
$$;

-- Regalo de bienvenida según la regla vigente `bienvenida.regalo`:
--   {"tipo":"toppings_gratis","cantidad":2,"toppings":null | ["miel","chia"]}
--   {"tipo":"descuento_compra","descuento_pct":20}
--   {"tipo":"descuento_linea","descuento_pct":20,"tamanos":["mini","pequeno",...]}   (sin "tipo" = este)
-- Una regla mal configurada no bloquea la venta: simplemente no se otorga el regalo.
create or replace function private.otorgar_bienvenida(p_cliente uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_regalo jsonb := private.regla_vigente('bienvenida.regalo');
  v_tipo text;
  v_vence timestamptz;
begin
  if v_regalo is null or jsonb_typeof(v_regalo) <> 'object' then return; end if;
  if exists (select 1 from public.ventas where cliente_id = p_cliente and estado in ('confirmada', 'pagada')) then return; end if;
  v_tipo := coalesce(v_regalo ->> 'tipo', 'descuento_linea');
  v_vence := now() + make_interval(days => private.regla_int('voucher.vigencia_dias'));
  begin
    if v_tipo = 'toppings_gratis' then
      insert into public.vouchers (cliente_id, tipo, modalidad, cantidad_toppings, toppings_permitidos, vence_en)
      values (p_cliente, 'bienvenida', 'toppings_gratis', (v_regalo ->> 'cantidad')::smallint,
              case when jsonb_typeof(v_regalo -> 'toppings') = 'array' then array(select jsonb_array_elements_text(v_regalo -> 'toppings')) end,
              v_vence)
      on conflict do nothing;
    elsif v_tipo = 'descuento_compra' then
      insert into public.vouchers (cliente_id, tipo, modalidad, descuento_pct, vence_en)
      values (p_cliente, 'bienvenida', 'descuento_compra', (v_regalo ->> 'descuento_pct')::smallint, v_vence)
      on conflict do nothing;
    elsif v_tipo = 'descuento_linea' then
      insert into public.vouchers (cliente_id, tipo, modalidad, descuento_pct, tamanos_permitidos, vence_en)
      values (p_cliente, 'bienvenida', 'descuento_linea', (v_regalo ->> 'descuento_pct')::smallint,
              array(select jsonb_array_elements_text(v_regalo -> 'tamanos')), v_vence)
      on conflict do nothing;
    end if;
  exception when others then
    return;   -- regla inválida: se vende igual, sin regalo
  end;
end;
$$;

-- Aplica un voucher a una línea: descuento en un bowl o toppings gratis (los de más valor primero).
create or replace function public.aplicar_voucher(p_linea uuid, p_voucher uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.venta_lineas;
  v public.ventas;
  w public.vouchers;
  v_desc integer;
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

  if w.modalidad = 'descuento_compra' then
    raise exception 'Ese premio es sobre toda la compra; aplícalo a la venta, no a una línea.';
  elsif w.modalidad = 'toppings_gratis' then
    select coalesce(sum(x.precio), 0) into v_desc from (
      select (t ->> 'precio_cop')::integer as precio
        from jsonb_array_elements(l.toppings) t
       where (t ->> 'extra')::boolean
         and (w.toppings_permitidos is null or (t ->> 'clave') = any (w.toppings_permitidos))
       order by 1 desc
       limit w.cantidad_toppings) x;
    if v_desc <= 0 then
      raise exception 'Esa línea no tiene toppings con costo para regalar.';
    end if;
  else
    if l.tamano is null or not (l.tamano = any (w.tamanos_permitidos)) then
      raise exception 'Ese premio no aplica a este producto o tamaño.';
    end if;
    v_desc := round(l.precio_unitario_cop * w.descuento_pct / 100.0)::integer;
  end if;

  update public.venta_lineas set voucher_id = p_voucher, descuento_cop = v_desc where id = p_linea;
  update public.vouchers set estado = 'reservado', venta_id = l.venta_id where id = p_voucher;
  perform private.recalcular_totales(l.venta_id);
  perform private.auditar('aplicar_voucher', 'venta', l.venta_id::text,
    jsonb_build_object('voucher', p_voucher, 'tipo', w.tipo, 'modalidad', w.modalidad, 'linea', p_linea, 'descuento_cop', v_desc));
end;
$$;

create function public.aplicar_voucher_compra(p_venta uuid, p_voucher uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v public.ventas;
  w public.vouchers;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'alistando' then raise exception 'Solo se aplica un premio mientras la venta está en alistando.'; end if;
  select * into w from public.vouchers where id = p_voucher for update;
  if not found then raise exception 'El premio no existe.'; end if;
  if v.cliente_id is null or w.cliente_id <> v.cliente_id then
    raise exception 'Ese premio no es del cliente de esta venta.';
  end if;
  if w.modalidad <> 'descuento_compra' then raise exception 'Ese premio no es un descuento sobre toda la compra.'; end if;
  if w.estado <> 'activo' then raise exception 'Ese premio ya se usó o está en otra venta.'; end if;
  if w.vence_en <= now() then raise exception 'Ese premio ya venció.'; end if;
  if v.voucher_compra_id is not null then raise exception 'Esta venta ya tiene un descuento sobre la compra.'; end if;
  update public.ventas set voucher_compra_id = p_voucher where id = p_venta;
  update public.vouchers set estado = 'reservado', venta_id = p_venta where id = p_voucher;
  perform private.recalcular_totales(p_venta);
  perform private.auditar('aplicar_voucher_compra', 'venta', p_venta::text,
    jsonb_build_object('voucher', p_voucher, 'tipo', w.tipo, 'descuento_pct', w.descuento_pct));
end;
$$;

create function public.quitar_voucher_compra(p_venta uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'La venta no existe.'; end if;
  if v.estado <> 'alistando' then raise exception 'Solo se quita un premio mientras la venta está en alistando.'; end if;
  if v.voucher_compra_id is null then return; end if;
  update public.vouchers set estado = 'activo', venta_id = null, usado_en = null where id = v.voucher_compra_id;
  update public.ventas set voucher_compra_id = null where id = p_venta;
  perform private.recalcular_totales(p_venta);
end;
$$;

-- Puntos: el descuento sobre toda la compra se reparte proporcionalmente entre lo que suma y lo que no.
create or replace function private.acreditar_puntos(p_venta uuid, p_cliente uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total_lineas integer;
  v_suman integer;
  v_desc_compra integer;
  v_base numeric;
  v_pts integer;
  v_ins integer;
begin
  select coalesce(sum(l.cantidad * l.precio_unitario_cop - l.descuento_cop), 0)::integer,
         coalesce(sum(l.cantidad * l.precio_unitario_cop - l.descuento_cop)
                  filter (where l.categoria in (select jsonb_array_elements_text(private.regla_vigente('puntos.categorias_que_suman')))), 0)::integer
    into v_total_lineas, v_suman
    from public.venta_lineas l where l.venta_id = p_venta;
  select v.descuento_cop - coalesce((select sum(l.descuento_cop) from public.venta_lineas l where l.venta_id = v.id), 0)
    into v_desc_compra from public.ventas v where v.id = p_venta;
  v_base := v_suman;
  if v_desc_compra > 0 and v_total_lineas > 0 then
    v_base := v_suman - round(v_desc_compra::numeric * v_suman / v_total_lineas);
  end if;
  v_pts := floor(v_base / private.regla_int('puntos.cop_por_punto'))::integer;
  if v_pts <= 0 then return 0; end if;
  insert into public.puntos_libro (cliente_id, tipo, puntos, venta_id, regla_versiones)
  values (p_cliente, 'suma', v_pts, p_venta, private.versiones_reglas(array['puntos.cop_por_punto', 'puntos.categorias_que_suman']))
  on conflict (venta_id) where tipo = 'suma' do nothing
  returning puntos into v_ins;
  return coalesce(v_ins, 0);
end;
$$;

-- Lecturas con la modalidad del premio.
create or replace function public.mis_vouchers() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'tipo', w.tipo, 'modalidad', w.modalidad, 'descuento_pct', w.descuento_pct,
             'tamanos', w.tamanos_permitidos, 'cantidad_toppings', w.cantidad_toppings, 'toppings', w.toppings_permitidos,
             'estado', w.estado, 'vence_en', w.vence_en) order by w.vence_en)
    from public.vouchers w
    where w.cliente_id = v_uid and w.estado in ('activo', 'reservado') and w.vence_en > now()
  ), '[]'::jsonb);
end;
$$;

create or replace function public.vouchers_activos_de(p_cliente uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'tipo', w.tipo, 'modalidad', w.modalidad, 'descuento_pct', w.descuento_pct,
             'tamanos', w.tamanos_permitidos, 'cantidad_toppings', w.cantidad_toppings, 'toppings', w.toppings_permitidos,
             'vence_en', w.vence_en) order by w.vence_en)
    from public.vouchers w
    where w.cliente_id = p_cliente and w.estado = 'activo' and w.vence_en > now()
  ), '[]'::jsonb);
end;
$$;

-- El dueño elige el regalo de bienvenida: versión nueva de la regla (la anterior se cierra).
-- Por defecto, 1 topping gratis en la primera compra (decisión de Javier; la cantidad la ajusta desde el panel).
update public.reglas_negocio set vigente_hasta = now() where clave = 'bienvenida.regalo' and vigente_hasta is null;
insert into public.reglas_negocio (clave, version, valor, descripcion, publica, vigente_desde) values
  ('bienvenida.regalo', 2, '{"tipo":"toppings_gratis","cantidad":1,"toppings":null}'::jsonb,
   'Regalo de bienvenida (una vez por cuenta): {"tipo":"toppings_gratis","cantidad":N,"toppings":null|[claves]}, {"tipo":"descuento_compra","descuento_pct":N} o {"tipo":"descuento_linea","descuento_pct":N,"tamanos":[...]}.',
   true, now());

-- =============================================================================================
-- 2. Rappi
-- =============================================================================================
alter table public.ventas drop constraint ventas_canal_check;
alter table public.ventas add constraint ventas_canal_check check (canal in ('tienda', 'web', 'rappi'));
alter table public.ventas drop constraint ventas_medio_pago_check;
alter table public.ventas add constraint ventas_medio_pago_check
  check (medio_pago in ('efectivo', 'datafono_bold', 'transferencia', 'bold_online', 'rappi'));
alter table public.ventas add column referencia_externa text
  check (referencia_externa is null or (length(btrim(referencia_externa)) between 1 and 40));
create unique index ventas_referencia_externa_uq on public.ventas (canal, referencia_externa) where referencia_externa is not null;
alter table public.ventas add constraint ventas_rappi_coherente check (
  (canal = 'rappi') = (referencia_externa is not null)
  and (medio_pago is null or ((medio_pago = 'rappi') = (canal = 'rappi')))
  and (canal <> 'rappi' or cliente_id is null));

-- crear_venta pasa a usar un ayudante con canal y referencia (misma firma pública).
create function private.crear_venta_interna(p_idem uuid, p_cliente uuid, p_offline boolean, p_creada_en timestamptz,
                                            p_canal text, p_ref text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if p_idem is null then raise exception 'Falta la clave de idempotencia de la venta.'; end if;
  if p_cliente is not null and not exists (select 1 from public.perfiles where user_id = p_cliente) then
    raise exception 'Ese cliente no existe.';
  end if;
  insert into public.ventas (idempotency_key, cliente_id, creada_por, creada_offline, creada_en, canal, referencia_externa)
  values (p_idem, p_cliente, (select auth.uid()), coalesce(p_offline, false),
          case when p_offline then least(coalesce(p_creada_en, now()), now()) else now() end, p_canal, p_ref)
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

create or replace function public.crear_venta(p_idem uuid, p_cliente uuid default null, p_offline boolean default false, p_creada_en timestamptz default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  return private.crear_venta_interna(p_idem, p_cliente, p_offline, p_creada_en, 'tienda', null);
end;
$$;

-- Carga las líneas de un arreglo JSON [{producto, tamano, presentacion, base, toppings[], cantidad}].
create function private.cargar_lineas(p_venta uuid, p_lineas jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare e jsonb;
begin
  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'La venta no tiene productos.';
  end if;
  for e in select * from jsonb_array_elements(p_lineas) loop
    perform public.agregar_linea(p_venta, e ->> 'producto', e ->> 'tamano', e ->> 'presentacion', e ->> 'base',
      coalesce(array(select jsonb_array_elements_text(coalesce(e -> 'toppings', '[]'::jsonb))), '{}'::text[]),
      coalesce((e ->> 'cantidad')::integer, 1));
  end loop;
end;
$$;

-- Cobro: 'rappi' solo para ventas de Rappi; el pago en línea solo lo registra el servidor.
create or replace function private.pagar_interno(p_venta uuid, p_medio text, p_efectivo integer, p_cuando timestamptz, p_emitir_qr boolean)
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
  if p_medio not in ('efectivo', 'datafono_bold', 'transferencia', 'bold_online', 'rappi') then
    raise exception 'Medio de pago no válido: %.', p_medio;
  end if;
  if (p_medio = 'rappi') <> (v.canal = 'rappi') then
    raise exception 'El medio "%" no corresponde al canal de esta venta (%).', p_medio, v.canal;
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
  elsif p_emitir_qr and v.canal = 'tienda' then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.qr_posventa (venta_id, token_hash, vence_en)
    values (p_venta, extensions.digest(v_token, 'sha256'),
            p_cuando + make_interval(mins => private.regla_int('qr_posventa.vigencia_min')));
  end if;

  return jsonb_build_object('venta_id', p_venta, 'estado', 'pagada', 'total_cop', v.total_cop,
                            'cambio_cop', v_cambio, 'puntos_acreditados', v_pts, 'qr_token', v_token);
end;
$$;

create or replace function public.pagar_venta(p_venta uuid, p_medio text, p_efectivo_recibido integer default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  if p_medio = 'bold_online' then
    raise exception 'El pago en línea se registra solo desde el servidor.' using errcode = '42501';
  end if;
  if p_medio = 'rappi' then
    raise exception 'Las ventas de Rappi se registran con su propio formulario.';
  end if;
  return private.pagar_interno(p_venta, p_medio, p_efectivo_recibido, now(), true);
end;
$$;

create or replace function public.registrar_venta_offline(p_idem uuid, p_creada_en timestamptz, p_lineas jsonb, p_medio text,
                                                          p_efectivo_recibido integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_cuando timestamptz;
  v_res jsonb;
begin
  perform private.exigir_staff();
  if p_medio = 'bold_online' then raise exception 'El pago en línea se registra solo desde el servidor.' using errcode = '42501'; end if;
  if p_medio = 'rappi' then raise exception 'Las ventas de Rappi se registran con su propio formulario.'; end if;
  select id into v_id from public.ventas where idempotency_key = p_idem;
  if v_id is not null then
    return jsonb_build_object('venta_id', v_id, 'duplicada', true);
  end if;
  v_cuando := least(coalesce(p_creada_en, now()), now());
  if v_cuando < now() - interval '7 days' then
    raise exception 'Esta venta es de hace más de 7 días; revísala con el dueño antes de registrarla.';
  end if;
  v_id := private.crear_venta_interna(p_idem, null, true, v_cuando, 'tienda', null);
  perform private.cargar_lineas(v_id, p_lineas);
  perform private.confirmar_interno(v_id, v_cuando);
  v_res := private.pagar_interno(v_id, p_medio, p_efectivo_recibido, v_cuando, false);
  return jsonb_build_object('venta_id', v_id, 'duplicada', false, 'total_cop', v_res -> 'total_cop', 'cambio_cop', v_res -> 'cambio_cop');
end;
$$;

-- Venta de Rappi: un pedido, ya pagado por Rappi. Mismos precios del catálogo; sin cliente, puntos ni QR.
-- Idempotente por clave y también por número de pedido de Rappi (no se registra dos veces).
create function public.registrar_venta_rappi(p_idem uuid, p_pedido text, p_lineas jsonb, p_creada_en timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_ref text := btrim(coalesce(p_pedido, ''));
  v_cuando timestamptz := least(coalesce(p_creada_en, now()), now());
  v_res jsonb;
begin
  perform private.exigir_staff();
  if length(v_ref) = 0 or length(v_ref) > 40 then
    raise exception 'Escribe el número de pedido de Rappi (máximo 40 caracteres).';
  end if;
  select id into v_id from public.ventas
   where idempotency_key = p_idem or (canal = 'rappi' and referencia_externa = v_ref);
  if v_id is not null then
    return jsonb_build_object('venta_id', v_id, 'duplicada', true);
  end if;
  if v_cuando < now() - interval '7 days' then
    raise exception 'Este pedido es de hace más de 7 días; revísalo con el dueño antes de registrarlo.';
  end if;
  v_id := private.crear_venta_interna(p_idem, null, p_creada_en is not null, v_cuando, 'rappi', v_ref);
  perform private.cargar_lineas(v_id, p_lineas);
  perform private.confirmar_interno(v_id, v_cuando);
  v_res := private.pagar_interno(v_id, 'rappi', null, v_cuando, false);
  return jsonb_build_object('venta_id', v_id, 'duplicada', false, 'total_cop', v_res -> 'total_cop');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Permisos de ejecución (se repite el barrido: las funciones nuevas nacen con permisos por defecto)
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
