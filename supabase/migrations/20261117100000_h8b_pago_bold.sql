-- H8b: pago en línea con Bold para pedidos web. Apagado por defecto (bandera pago_en_linea_bold).
-- Quien decide qué está pagado es esta base de datos, nunca la pasarela ni la redirección del navegador:
-- el webhook (Edge Function con la firma ya verificada) solo entrega el evento a aplicar_evento_bold, que es idempotente,
-- valida monto y moneda contra el pedido y tolera eventos repetidos o fuera de orden.
-- Las llaves de Bold viven solo como secretos de las Edge Functions; aquí no hay ninguna.

-- =============================================================================================
-- 1. Tablas
-- =============================================================================================
create table public.pagos_bold (
  id               uuid primary key default gen_random_uuid(),
  order_id         text not null unique check (order_id ~ '^[A-Za-z0-9_-]{1,60}$'),   -- referencia que se envía a Bold
  pedido_id        uuid not null references public.pedidos_web (id),
  monto_cop        integer not null check (monto_cop >= 1000),                         -- mínimo del botón de Bold
  moneda           text not null default 'COP' check (moneda = 'COP'),
  estado           text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado', 'anulado')),
  bold_payment_id  text unique,
  medio            text,
  evento_crudo     jsonb,
  creado_en        timestamptz not null default now(),
  confirmado_en    timestamptz
);
create index pagos_bold_pedido_idx on public.pagos_bold (pedido_id);
create index pagos_bold_pendientes_idx on public.pagos_bold (creado_en) where estado = 'pendiente';

-- Libro de eventos recibidos: la clave única del evento es la garantía contra reprocesar un reintento.
create table public.bold_eventos (
  id            bigint generated always as identity primary key,
  bold_evento_id text not null unique,
  tipo          text not null,
  order_id      text,
  recibido_en   timestamptz not null default now(),
  procesado_en  timestamptz,
  resultado     text
);

alter table public.pagos_bold   enable row level security;
alter table public.bold_eventos enable row level security;
revoke all on public.pagos_bold, public.bold_eventos from anon, authenticated;
-- Sin políticas: ni clientes ni personal leen estas tablas directo; el dueño las verá por funciones (H9).

alter table public.alertas drop constraint alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('venta_sin_pagar', 'compras_inusuales', 'no_llego', 'reclamos_tope', 'cliente_reporta', 'pago_bold'));

-- =============================================================================================
-- 2. Cliente: iniciar el pago de su pedido
-- El monto sale SIEMPRE del pedido guardado; el cliente no envía nada más que el id de su pedido.
-- =============================================================================================
create function public.iniciar_pago_pedido_web(p_pedido uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  p public.pedidos_web;
  pg public.pagos_bold;
begin
  if not private.bandera_activa('pago_en_linea_bold') then
    raise exception 'El pago en línea todavía no está disponible.';
  end if;
  select * into p from public.pedidos_web where id = p_pedido and cliente_id = v_uid for update;
  if not found then raise exception 'No encontramos ese pedido.'; end if;
  if p.metodo_pago <> 'en_linea' then raise exception 'Este pedido se paga al recoger.'; end if;
  if p.estado not in ('recibido', 'preparando', 'listo') then raise exception 'Este pedido ya no está abierto.'; end if;
  if p.pago_en_linea_estado = 'pagado' then raise exception 'Este pedido ya está pagado.'; end if;
  if p.total_cop < 1000 then raise exception 'El pago en línea exige un total de al menos $1.000.'; end if;

  -- Reutiliza el intento pendiente reciente (el cliente pudo cerrar la ventana de pago); si no, crea uno nuevo.
  select * into pg from public.pagos_bold
   where pedido_id = p.id and estado = 'pendiente' and creado_en > now() - interval '12 hours'
   order by creado_en desc limit 1;
  if not found then
    insert into public.pagos_bold (order_id, pedido_id, monto_cop)
    values ('NW' || p.numero || '-' || encode(extensions.gen_random_bytes(5), 'hex'), p.id, p.total_cop)
    returning * into pg;
  end if;
  return jsonb_build_object('order_id', pg.order_id, 'monto_cop', pg.monto_cop, 'moneda', pg.moneda,
                            'descripcion', 'Pedido web #' || p.numero || ' · Naidí');
end;
$$;

-- =============================================================================================
-- 3. Webhook: aplicar un evento de Bold (solo service_role, desde la Edge Function)
-- =============================================================================================
create function public.aplicar_evento_bold(p_evento_id text, p_tipo text, p_order_id text, p_bold_payment_id text,
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
  -- Con la bandera apagada ninguna ruta de pago en línea responde ni guarda nada.
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
  else
    select * into p from public.pedidos_web where id = pg.pedido_id for update;
    v_abierto := p.estado in ('recibido', 'preparando', 'listo');

    if p_tipo = 'SALE_APPROVED' then
      if pg.estado = 'aprobado' then
        v_res := 'ya_aprobado';
      elsif p_moneda is distinct from pg.moneda or p_monto is distinct from pg.monto_cop then
        -- Monto o moneda distintos del pedido: no se acredita y el dueño lo revisa.
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
          -- Pagó un pedido que ya se cerró (cancelado, no llegó) o que ya estaba pagado por otro intento: requiere devolución.
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
      end if;   -- un rechazo que llega después de una aprobación se ignora (fuera de orden)

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
      end if;   -- una anulación que llega antes de la aprobación se ignora; la conciliación la resuelve
    end if;
  end if;

  update public.bold_eventos set procesado_en = now(), resultado = v_res where id = v_ev;
  return jsonb_build_object('resultado', v_res);
end;
$$;

-- Pagos pendientes de más de N minutos (y de menos de 48 h), para conciliar con la consulta a Bold.
create function public.pagos_bold_por_conciliar(p_minutos integer default 15) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.bandera_activa('pago_en_linea_bold') then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('order_id', order_id, 'monto_cop', monto_cop, 'moneda', moneda) order by creado_en)
    from public.pagos_bold
    where estado = 'pendiente' and creado_en < now() - make_interval(mins => greatest(p_minutos, 1)) and creado_en > now() - interval '48 hours'), '[]'::jsonb);
end;
$$;

-- =============================================================================================
-- 4. Un pedido en línea sin pagar no se prepara
-- =============================================================================================
create or replace function public.cambiar_estado_pedido_web(p_pedido uuid, p_estado text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare p public.pedidos_web;
begin
  perform private.exigir_staff();
  if p_estado not in ('preparando', 'listo') then raise exception 'Estado no válido: solo se pasa a Preparando o a Listo.'; end if;
  select * into p from public.pedidos_web where id = p_pedido for update;
  if not found then raise exception 'El pedido no existe.'; end if;
  if p.estado not in ('recibido', 'preparando') or (p.estado = 'preparando' and p_estado = 'preparando') then
    raise exception 'El pedido % está %; no se puede pasar a %.', p.numero, p.estado, p_estado;
  end if;
  if p.metodo_pago = 'en_linea' and p.pago_en_linea_estado <> 'pagado' then
    raise exception 'El pedido % se paga en línea y todavía no aparece pagado; espera la confirmación antes de prepararlo.', p.numero;
  end if;
  update public.pedidos_web set estado = p_estado where id = p_pedido;
  perform private.evento_pedido_web(p_pedido, p.estado, p_estado);
  return private.pedido_web_json(p_pedido, false);
end;
$$;

-- =============================================================================================
-- 5. Permisos
-- =============================================================================================
revoke all on function public.iniciar_pago_pedido_web(uuid) from public, anon;
grant execute on function public.iniciar_pago_pedido_web(uuid) to authenticated;
revoke all on function public.cambiar_estado_pedido_web(uuid, text) from public, anon;
grant execute on function public.cambiar_estado_pedido_web(uuid, text) to authenticated;
-- Solo el servidor (Edge Functions con la service_role) aplica eventos y concilia; ni clientes ni personal.
revoke all on function public.aplicar_evento_bold(text, text, text, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.pagos_bold_por_conciliar(integer) from public, anon, authenticated;
grant execute on function public.aplicar_evento_bold(text, text, text, text, integer, text, text, jsonb) to service_role;
grant execute on function public.pagos_bold_por_conciliar(integer) to service_role;
