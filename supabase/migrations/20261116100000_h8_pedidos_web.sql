-- H8: tienda web. Pedidos para recoger en tienda.
-- El pedido vive en su propia tabla (estados propios: recibido, preparando, listo, entregado, no_llego, cancelado).
-- Al marcar "Entregado" el servidor crea la venta (canal 'web'), la cobra y acredita los puntos con la misma lógica
-- de H3: los puntos y el topping de cortesía solo existen para pedidos pagados y entregados.
-- Ningún rol de la API escribe directo; el cliente nunca envía montos: el servidor reprecia desde el catálogo.

-- =============================================================================================
-- 1. Banderas y reglas (editables sin tocar código)
-- =============================================================================================
insert into public.banderas (clave, activa, descripcion) values
  ('pedidos_web', false, 'Tienda web: pedidos para recoger en tienda. Apagada por defecto; la web actual con WhatsApp sigue hasta encenderla.');

insert into public.reglas_negocio (clave, version, valor, descripcion, publica) values
  ('pedido_web.max_abiertos', 1, '2'::jsonb,
     'Máximo de pedidos web abiertos (recibido, preparando o listo) por cuenta.', true),
  ('pedido_web.no_llego_alerta', 1, '3'::jsonb,
     'Al llegar a este número de pedidos marcados "No llegó", la cuenta se señala para que el dueño decida (prepago o bloqueo).', false),
  ('pedido_web.ventana', 1, '{"min_anticipacion_min":20,"max_anticipacion_horas":3,"max_duracion_min":60}'::jsonb,
     'Ventana de recogida: anticipación mínima y máxima (en horas; acota hasta cuándo se puede pedir), y duración máxima de la ventana.', true),
  ('pedido_web.pagos', 1, '{"al_recoger":true,"en_linea":true}'::jsonb,
     'Formas de pago ofrecidas en la tienda web. "en_linea" solo funciona además con la bandera pago_en_linea_bold encendida.', true),
  ('pedido_web.topping_cortesia', 1, '{"activo":true,"cantidad":1,"solo_primera_vez":false}'::jsonb,
     'Topping de cortesía por pedir en línea: se incluye sin costo en el pedido y solo cuenta si el pedido se entrega y paga. "solo_primera_vez" lo limita a la primera compra web de la cuenta.', true);

-- =============================================================================================
-- 2. Tablas
-- Interruptor en vivo: el personal lo enciende mientras la tienda está abierta y lo apaga al cerrar (o si se agota algo).
-- No depende de un horario fijo. Para recibir pedidos web deben estar encendidos la bandera pedidos_web (la habilita el
-- dueño) y este interruptor (lo maneja cualquier persona del personal desde el POS). Apagarlo no afecta los pedidos ya hechos.
-- ---------------------------------------------------------------------------------------------
create table public.pedidos_web_interruptor (
  id         smallint primary key check (id = 1),
  abierta    boolean not null default false,
  cambiado_por uuid references auth.users (id),
  cambiado_en  timestamptz not null default now()
);
insert into public.pedidos_web_interruptor (id) values (1);
alter table public.pedidos_web_interruptor enable row level security;
revoke all on public.pedidos_web_interruptor from anon, authenticated;

create function private.tienda_abierta() returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.bandera_activa('pedidos_web') and coalesce((select i.abierta from public.pedidos_web_interruptor i where i.id = 1), false);
$$;

-- =============================================================================================
create table public.pedidos_web (
  id                   uuid primary key default gen_random_uuid(),
  numero               bigint generated always as identity unique,
  idempotency_key      uuid not null unique,
  cliente_id           uuid not null references auth.users (id),
  estado               text not null default 'recibido'
                         check (estado in ('recibido', 'preparando', 'listo', 'entregado', 'no_llego', 'cancelado')),
  metodo_pago          text not null check (metodo_pago in ('al_recoger', 'en_linea')),
  pago_en_linea_estado text not null default 'no_aplica' check (pago_en_linea_estado in ('no_aplica', 'pendiente', 'pagado')),
  codigo               text not null check (codigo ~ '^[A-Z0-9]{4}$'),
  ventana_inicio       timestamptz not null,
  ventana_fin          timestamptz not null,
  en_camino_en         timestamptz,
  cortesia_toppings    text[] not null default '{}',
  nota                 text check (nota is null or length(nota) <= 200),
  subtotal_cop         integer not null check (subtotal_cop >= 0),
  total_cop            integer not null check (total_cop >= 0),
  venta_id             uuid references public.ventas (id),
  creado_en            timestamptz not null default now(),
  entregado_en         timestamptz,
  no_llego_en          timestamptz,
  cancelado_en         timestamptz,
  motivo_cancelacion   text,
  constraint pedidos_web_ventana_valida check (ventana_fin > ventana_inicio),
  constraint pedidos_web_total_coherente check (total_cop = subtotal_cop),
  constraint pedidos_web_en_linea_coherente check ((metodo_pago = 'en_linea') = (pago_en_linea_estado <> 'no_aplica')),
  constraint pedidos_web_entrega_coherente check ((estado = 'entregado') = (venta_id is not null))
);
create index pedidos_web_cliente_idx on public.pedidos_web (cliente_id);
create index pedidos_web_estado_idx  on public.pedidos_web (estado, ventana_inicio);
-- El código corto no se repite entre pedidos abiertos.
create unique index pedidos_web_codigo_abierto on public.pedidos_web (codigo) where estado in ('recibido', 'preparando', 'listo');

create table public.pedido_web_lineas (
  id                  uuid primary key default gen_random_uuid(),
  pedido_id           uuid not null references public.pedidos_web (id),
  orden               smallint not null,
  producto_clave      text not null references public.productos (clave),
  producto_nombre     text not null,
  categoria           text not null,
  tamano              text references public.tamanos (clave),
  presentacion        text references public.presentaciones (clave),
  base                text references public.bases (clave),
  toppings            jsonb not null default '[]'::jsonb,
  cantidad            smallint not null default 1 check (cantidad between 1 and 20),
  precio_unitario_cop integer not null check (precio_unitario_cop >= 0),
  unique (pedido_id, orden)
);

create table public.pedido_web_eventos (
  id        bigint generated always as identity primary key,
  pedido_id uuid not null references public.pedidos_web (id),
  de_estado text,
  a_estado  text not null,
  actor     uuid,
  motivo    text,
  en        timestamptz not null default now()
);
create index pedido_web_eventos_idx on public.pedido_web_eventos (pedido_id);

-- Cuentas señaladas por el dueño tras varios "No llegó": prepago o bloqueo.
create table public.cuentas_pedidos_web (
  cliente_id uuid primary key references auth.users (id),
  modo       text not null check (modo in ('prepago', 'bloqueo')),
  motivo     text,
  fijada_por uuid references auth.users (id),
  fijada_en  timestamptz not null default now()
);

create trigger pedido_web_lineas_inmutables before update or delete on public.pedido_web_lineas
  for each row execute function private.bloquear_mutacion();
create trigger pedido_web_eventos_inmutables before update or delete on public.pedido_web_eventos
  for each row execute function private.bloquear_mutacion();

-- Transiciones permitidas del pedido; lo demás no cambia después de creado.
create function private.validar_transicion_pedido_web() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.estado in ('entregado', 'no_llego', 'cancelado') then
    raise exception 'El pedido % ya está %; no admite cambios.', old.numero, old.estado using errcode = 'restrict_violation';
  end if;
  if new.idempotency_key <> old.idempotency_key or new.numero <> old.numero or new.cliente_id <> old.cliente_id
     or new.codigo <> old.codigo or new.metodo_pago <> old.metodo_pago
     -- Los montos se fijan una sola vez, al terminar de crear el pedido (de 0 a su valor); después no cambian.
     or (old.subtotal_cop <> 0 and (new.total_cop <> old.total_cop or new.subtotal_cop <> old.subtotal_cop)) then
    raise exception 'La identidad y los montos del pedido no se pueden cambiar.' using errcode = 'restrict_violation';
  end if;
  if new.estado <> old.estado and not ((old.estado, new.estado) in (
      ('recibido', 'preparando'), ('recibido', 'listo'), ('preparando', 'listo'),
      ('recibido', 'entregado'), ('preparando', 'entregado'), ('listo', 'entregado'),
      ('recibido', 'no_llego'), ('preparando', 'no_llego'), ('listo', 'no_llego'),
      ('recibido', 'cancelado'), ('preparando', 'cancelado'), ('listo', 'cancelado'))) then
    raise exception 'Transición no permitida: % -> %.', old.estado, new.estado using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger pedidos_web_transicion before update on public.pedidos_web
  for each row execute function private.validar_transicion_pedido_web();

-- RLS con denegación por defecto. Solo el personal lee (lo necesita el tiempo real del POS);
-- los clientes usan funciones propias y nadie escribe directo.
alter table public.pedidos_web          enable row level security;
alter table public.pedido_web_lineas    enable row level security;
alter table public.pedido_web_eventos   enable row level security;
alter table public.cuentas_pedidos_web  enable row level security;
revoke all on public.pedidos_web, public.pedido_web_lineas, public.pedido_web_eventos, public.cuentas_pedidos_web from anon, authenticated;
grant select on public.pedidos_web, public.pedido_web_lineas to authenticated;
create policy pedidos_web_ver_staff on public.pedidos_web       for select to authenticated using ((select private.es_staff()));
create policy pedido_web_lineas_ver_staff on public.pedido_web_lineas for select to authenticated using ((select private.es_staff()));
-- Los eventos y las cuentas señaladas no se leen directo (ni el personal): salen por funciones.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.pedidos_web;
  end if;
end $$;

-- =============================================================================================
-- 3. Ayudantes internos
-- =============================================================================================
create function private.evento_pedido_web(p_pedido uuid, p_de text, p_a text, p_motivo text default null) returns void
language sql security definer set search_path = ''
as $$
  insert into public.pedido_web_eventos (pedido_id, de_estado, a_estado, actor, motivo)
  values (p_pedido, p_de, p_a, (select auth.uid()), p_motivo);
$$;

-- Código corto de 4 caracteres sin letras ni números que se confundan (sin I, L, O, 0, 1).
create function private.codigo_pedido_web() returns text
language plpgsql volatile set search_path = ''
as $$
declare
  alfabeto constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := extensions.gen_random_bytes(4);
  r text := '';
  i integer;
begin
  for i in 0..3 loop
    r := r || substr(alfabeto, (get_byte(b, i) % length(alfabeto)) + 1, 1);
  end loop;
  return r;
end;
$$;

-- Ficha del pedido. El cliente ve su código; el personal no (lo digita el cliente al reclamar).
create function private.pedido_web_json(p_id uuid, p_para_cliente boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
      'id', p.id, 'numero', p.numero, 'estado', p.estado, 'metodo_pago', p.metodo_pago,
      'pago_en_linea_estado', p.pago_en_linea_estado,
      'ventana_inicio', p.ventana_inicio, 'ventana_fin', p.ventana_fin, 'en_camino_en', p.en_camino_en,
      'cortesia_toppings', (select coalesce(jsonb_agg(jsonb_build_object('clave', t.clave, 'nombre', t.nombre) order by t.orden), '[]'::jsonb)
                              from public.toppings t where t.clave = any (p.cortesia_toppings)),
      'nota', p.nota, 'subtotal_cop', p.subtotal_cop, 'total_cop', p.total_cop, 'creado_en', p.creado_en,
      'entregado_en', p.entregado_en, 'venta_id', p.venta_id,
      'lineas', (select coalesce(jsonb_agg(jsonb_build_object(
                    'producto_clave', l.producto_clave, 'producto_nombre', l.producto_nombre, 'categoria', l.categoria,
                    'tamano', l.tamano, 'presentacion', l.presentacion, 'base', l.base, 'toppings', l.toppings,
                    'cantidad', l.cantidad, 'precio_unitario_cop', l.precio_unitario_cop) order by l.orden), '[]'::jsonb)
                   from public.pedido_web_lineas l where l.pedido_id = p.id))
    || case when p_para_cliente then jsonb_build_object('codigo', p.codigo)
            else jsonb_build_object('cliente_id', p.cliente_id, 'nombre_pila', private.nombre_pila(pf.nombre),
                                    'inicial', private.inicial_apellido(pf.nombre), 'foto_url', pf.foto_url) end
  from public.pedidos_web p
  left join public.perfiles pf on pf.user_id = p.cliente_id
  where p.id = p_id;
$$;

create function private.pedidos_abiertos_de(p_cliente uuid) returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from public.pedidos_web where cliente_id = p_cliente and estado in ('recibido', 'preparando', 'listo');
$$;

-- ¿Le corresponde el topping de cortesía a esta cuenta? Respeta la bandera de la regla y "solo la primera vez".
create function private.cortesia_disponible(p_cliente uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare r jsonb := private.regla_vigente('pedido_web.topping_cortesia');
begin
  if r is null or coalesce((r ->> 'activo')::boolean, false) is not true or coalesce((r ->> 'cantidad')::integer, 0) <= 0 then
    return false;
  end if;
  if coalesce((r ->> 'solo_primera_vez')::boolean, false) then
    return not exists (select 1 from public.pedidos_web
                        where cliente_id = p_cliente and cardinality(cortesia_toppings) > 0
                          and estado in ('recibido', 'preparando', 'listo', 'entregado'));
  end if;
  return true;
end;
$$;

-- =============================================================================================
-- 4. Cliente
-- =============================================================================================
-- Configuración pública de la tienda (sin sesión): si está abierta y qué formas de pago ofrece.
create function public.tienda_estado() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_pagos jsonb := coalesce(private.regla_vigente('pedido_web.pagos'), '{}'::jsonb);
  v_cort  jsonb := coalesce(private.regla_vigente('pedido_web.topping_cortesia'), '{}'::jsonb);
begin
  return jsonb_build_object(
    'abierta', private.tienda_abierta(),
    'habilitada', private.bandera_activa('pedidos_web'),
    'pagos', jsonb_build_object(
      'al_recoger', coalesce((v_pagos ->> 'al_recoger')::boolean, false),
      'en_linea', coalesce((v_pagos ->> 'en_linea')::boolean, false) and private.bandera_activa('pago_en_linea_bold')),
    'ventana', private.regla_vigente('pedido_web.ventana'),
    'max_abiertos', private.regla_vigente('pedido_web.max_abiertos'),
    'cortesia', jsonb_build_object('activo', coalesce((v_cort ->> 'activo')::boolean, false), 'cantidad', coalesce((v_cort ->> 'cantidad')::integer, 0)));
end;
$$;

-- Lo propio de la cuenta para pedir: cortesía disponible, pedidos abiertos y restricción.
create function public.mi_tienda() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return jsonb_build_object(
    'acepta_datos', private.tiene_consentimiento_datos(v_uid),
    'cortesia_disponible', private.cortesia_disponible(v_uid),
    'abiertos', private.pedidos_abiertos_de(v_uid),
    'max_abiertos', private.regla_int('pedido_web.max_abiertos'),
    'restriccion', (select c.modo from public.cuentas_pedidos_web c where c.cliente_id = v_uid));
end;
$$;

-- p_lineas: [{producto, tamano?, presentacion?, base?, toppings?:[claves], cantidad?}]
create function public.crear_pedido_web(p_idem uuid, p_lineas jsonb, p_ventana_inicio timestamptz, p_ventana_fin timestamptz,
                                        p_pago text, p_cortesia text[] default '{}', p_nota text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid     uuid := private.exigir_cliente();
  v_prev    public.pedidos_web;
  v_id      uuid;
  v_codigo  text;
  v_intento integer := 0;
  v_pagos   jsonb := coalesce(private.regla_vigente('pedido_web.pagos'), '{}'::jsonb);
  v_vent    jsonb := private.regla_vigente('pedido_web.ventana');
  v_rest    text;
  v_item    jsonb;
  v_ord     smallint := 0;
  v_cant    integer;
  v_prod    text;
  v_precio  jsonb;
  v_tops    text[];
  v_sub     integer := 0;
  v_cort    text[] := coalesce(p_cortesia, '{}');
  v_cort_r  jsonb;
  v_hay_bowl boolean := false;
  v_nota    text := nullif(btrim(coalesce(p_nota, '')), '');
  k         text;
begin
  if p_idem is null then raise exception 'Falta la clave de idempotencia del pedido.'; end if;

  -- Reintento del mismo envío: devuelve el pedido ya creado, sin duplicarlo.
  select * into v_prev from public.pedidos_web where idempotency_key = p_idem;
  if found then
    if v_prev.cliente_id <> v_uid then raise exception 'No encontramos ese pedido.'; end if;
    return private.pedido_web_json(v_prev.id, true) || jsonb_build_object('repetido', true);
  end if;

  if not private.tienda_abierta() then
    raise exception 'Por ahora no estamos recibiendo pedidos en línea. Puedes pedir directamente en la tienda.';
  end if;
  if not private.tiene_consentimiento_datos(v_uid) then
    raise exception 'Antes de pedir debes aceptar el tratamiento de datos en tu cuenta.';
  end if;

  -- Cuentas señaladas por el dueño
  select modo into v_rest from public.cuentas_pedidos_web where cliente_id = v_uid;
  if v_rest = 'bloqueo' then
    raise exception 'Por ahora no podemos recibir pedidos web de esta cuenta. Habla con el personal en la tienda.';
  end if;

  if p_pago not in ('al_recoger', 'en_linea') then raise exception 'Elige cómo vas a pagar.'; end if;
  if v_rest = 'prepago' and p_pago <> 'en_linea' then
    raise exception 'Para esta cuenta los pedidos web se pagan en línea.';
  end if;
  if p_pago = 'al_recoger' and coalesce((v_pagos ->> 'al_recoger')::boolean, false) is not true then
    raise exception 'El pago al recoger no está disponible.';
  end if;
  if p_pago = 'en_linea' and not (coalesce((v_pagos ->> 'en_linea')::boolean, false) and private.bandera_activa('pago_en_linea_bold')) then
    raise exception 'El pago en línea todavía no está disponible.';
  end if;

  if private.pedidos_abiertos_de(v_uid) >= private.regla_int('pedido_web.max_abiertos') then
    raise exception 'Ya tienes % pedido(s) abierto(s). Cuando recojas alguno podrás pedir de nuevo.', private.regla_int('pedido_web.max_abiertos');
  end if;

  -- Ventana de recogida
  if p_ventana_inicio is null or p_ventana_fin is null or p_ventana_fin <= p_ventana_inicio then
    raise exception 'Elige una ventana de recogida válida.';
  end if;
  if p_ventana_inicio < now() + make_interval(mins => (v_vent ->> 'min_anticipacion_min')::integer) then
    raise exception 'Necesitamos al menos % minutos para alistar tu pedido. Elige una hora más tarde.', v_vent ->> 'min_anticipacion_min';
  end if;
  if p_ventana_inicio > now() + make_interval(hours => (v_vent ->> 'max_anticipacion_horas')::integer) then
    raise exception 'Solo recibimos pedidos para las próximas % horas.', v_vent ->> 'max_anticipacion_horas';
  end if;
  if p_ventana_fin - p_ventana_inicio > make_interval(mins => (v_vent ->> 'max_duracion_min')::integer) then
    raise exception 'La ventana de recogida puede durar máximo % minutos.', v_vent ->> 'max_duracion_min';
  end if;

  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'Tu pedido no tiene productos.';
  end if;
  if jsonb_array_length(p_lineas) > 15 then raise exception 'Tu pedido tiene demasiados productos (máximo 15).'; end if;
  if v_nota is not null and length(v_nota) > 200 then raise exception 'La nota es muy larga (máximo 200 letras).'; end if;

  -- Código corto (reintenta si choca con otro pedido abierto)
  loop
    v_codigo := private.codigo_pedido_web();
    exit when not exists (select 1 from public.pedidos_web where codigo = v_codigo and estado in ('recibido', 'preparando', 'listo'));
    v_intento := v_intento + 1;
    if v_intento > 30 then raise exception 'No pudimos generar el código del pedido. Inténtalo de nuevo.'; end if;
  end loop;

  insert into public.pedidos_web (idempotency_key, cliente_id, metodo_pago, pago_en_linea_estado, codigo, ventana_inicio, ventana_fin,
                                  nota, subtotal_cop, total_cop)
  values (p_idem, v_uid, p_pago, case when p_pago = 'en_linea' then 'pendiente' else 'no_aplica' end, v_codigo,
          p_ventana_inicio, p_ventana_fin, v_nota, 0, 0)
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_lineas) loop
    v_ord := v_ord + 1;
    v_prod := v_item ->> 'producto';
    v_cant := coalesce((v_item ->> 'cantidad')::integer, 1);
    if v_cant < 1 or v_cant > 20 then raise exception 'La cantidad de cada producto va de 1 a 20.'; end if;
    v_tops := coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'toppings', '[]'::jsonb))), '{}'::text[]);
    v_precio := private.precio_linea(v_prod, v_item ->> 'tamano', v_item ->> 'presentacion', v_item ->> 'base', v_tops);
    insert into public.pedido_web_lineas (pedido_id, orden, producto_clave, producto_nombre, categoria, tamano, presentacion, base,
                                          toppings, cantidad, precio_unitario_cop)
    values (v_id, v_ord, v_prod, v_precio ->> 'producto_nombre', v_precio ->> 'categoria', v_precio ->> 'tamano',
            v_precio ->> 'presentacion', v_precio ->> 'base', v_precio -> 'toppings', v_cant, (v_precio ->> 'precio_unitario_cop')::integer);
    v_sub := v_sub + v_cant * (v_precio ->> 'precio_unitario_cop')::integer;
    if (v_precio ->> 'tamano') is not null then v_hay_bowl := true; end if;
  end loop;

  -- Topping de cortesía: solo si la regla lo permite, la cuenta es elegible y el pedido lleva un bowl
  if cardinality(v_cort) > 0 then
    v_cort_r := private.regla_vigente('pedido_web.topping_cortesia');
    if not private.cortesia_disponible(v_uid) then
      raise exception 'El topping de cortesía no está disponible para tu cuenta.';
    end if;
    if cardinality(v_cort) > (v_cort_r ->> 'cantidad')::integer then
      raise exception 'Tu pedido incluye máximo % topping(s) de cortesía.', v_cort_r ->> 'cantidad';
    end if;
    if not v_hay_bowl then raise exception 'El topping de cortesía va con un bowl.'; end if;
    if (select count(distinct x) from unnest(v_cort) x) <> cardinality(v_cort) then
      raise exception 'Elige toppings de cortesía distintos.';
    end if;
    foreach k in array v_cort loop
      if not exists (select 1 from public.toppings where clave = k and activo) then
        raise exception 'El topping "%" no está disponible.', k;
      end if;
    end loop;
  end if;

  update public.pedidos_web set subtotal_cop = v_sub, total_cop = v_sub, cortesia_toppings = v_cort where id = v_id;
  perform private.evento_pedido_web(v_id, null, 'recibido');
  return private.pedido_web_json(v_id, true) || jsonb_build_object('repetido', false);
end;
$$;

create function public.mis_pedidos_web(p_limite integer default 20) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return coalesce((
    select jsonb_agg(private.pedido_web_json(x.id, true) order by x.creado_en desc)
    from (select id, creado_en from public.pedidos_web where cliente_id = v_uid
           order by creado_en desc limit least(greatest(p_limite, 1), 50)) x), '[]'::jsonb);
end;
$$;

create function public.voy_en_camino(p_pedido uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  p public.pedidos_web;
begin
  select * into p from public.pedidos_web where id = p_pedido and cliente_id = v_uid for update;
  if not found then raise exception 'No encontramos ese pedido.'; end if;
  if p.estado not in ('recibido', 'preparando', 'listo') then raise exception 'Este pedido ya no está abierto.'; end if;
  if p.en_camino_en is null then
    update public.pedidos_web set en_camino_en = now() where id = p_pedido;
    perform private.evento_pedido_web(p_pedido, p.estado, p.estado, 'en_camino');
  end if;
  return private.pedido_web_json(p_pedido, true);
end;
$$;

-- El cliente solo cancela mientras el pedido está Recibido (si ya lo están preparando, habla con el personal).
create function public.cancelar_mi_pedido_web(p_pedido uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  p public.pedidos_web;
begin
  select * into p from public.pedidos_web where id = p_pedido and cliente_id = v_uid for update;
  if not found then raise exception 'No encontramos ese pedido.'; end if;
  if p.estado <> 'recibido' then
    raise exception 'Tu pedido ya está en preparación o cerrado; habla con el personal para cambiarlo.';
  end if;
  if p.pago_en_linea_estado = 'pagado' then
    raise exception 'Este pedido ya está pagado en línea; habla con el personal para cancelarlo.';
  end if;
  update public.pedidos_web set estado = 'cancelado', cancelado_en = now(), motivo_cancelacion = 'cancelado por el cliente' where id = p_pedido;
  perform private.evento_pedido_web(p_pedido, p.estado, 'cancelado', 'cancelado por el cliente');
  return private.pedido_web_json(p_pedido, true);
end;
$$;

-- =============================================================================================
-- 5. Personal (POS)
-- =============================================================================================
-- Pedidos abiertos y los cerrados hoy (hora de Bogotá), por ventana de recogida. Sin el código del cliente.
create function public.pedidos_web_abiertos() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  return coalesce((
    select jsonb_agg(private.pedido_web_json(x.id, false) order by (x.estado in ('entregado', 'no_llego', 'cancelado')), x.ventana_inicio, x.numero)
    from (select id, estado, ventana_inicio, numero from public.pedidos_web
           where estado in ('recibido', 'preparando', 'listo')
              or private.dia_bogota(coalesce(entregado_en, no_llego_en, cancelado_en)) = private.dia_bogota(now())) x), '[]'::jsonb);
end;
$$;

create function public.cambiar_estado_pedido_web(p_pedido uuid, p_estado text) returns jsonb
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
  update public.pedidos_web set estado = p_estado where id = p_pedido;
  perform private.evento_pedido_web(p_pedido, p.estado, p_estado);
  return private.pedido_web_json(p_pedido, false);
end;
$$;

-- Entrega: verifica el código, crea la venta (canal web), la cobra y acredita los puntos. Una sola vez.
create function public.entregar_pedido_web(p_pedido uuid, p_codigo text, p_medio text default null, p_efectivo_recibido integer default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p       public.pedidos_web;
  v_venta uuid;
  v_medio text;
  v_pago  jsonb;
begin
  perform private.exigir_staff();
  select * into p from public.pedidos_web where id = p_pedido for update;
  if not found then raise exception 'El pedido no existe.'; end if;
  if p.estado = 'entregado' then raise exception 'Este pedido ya se entregó.'; end if;
  if p.estado not in ('recibido', 'preparando', 'listo') then raise exception 'El pedido % está %; no se puede entregar.', p.numero, p.estado; end if;
  if upper(btrim(coalesce(p_codigo, ''))) <> p.codigo then
    raise exception 'El código no coincide con el del pedido. Pídele al cliente que lo revise en su cuenta.';
  end if;

  if p.metodo_pago = 'en_linea' then
    if p.pago_en_linea_estado <> 'pagado' then
      raise exception 'Este pedido se paga en línea y todavía no aparece pagado.';
    end if;
    v_medio := 'bold_online';
  else
    if p_medio is null or p_medio not in ('efectivo', 'datafono_bold', 'transferencia') then
      raise exception 'Registra cómo pagó el cliente: efectivo, datáfono o transferencia.';
    end if;
    v_medio := p_medio;
  end if;

  insert into public.ventas (idempotency_key, canal, cliente_id, creada_por)
  values (p.id, 'web', p.cliente_id, (select auth.uid()))
  returning id into v_venta;
  perform private.evento(v_venta, null, 'alistando', null, jsonb_build_object('pedido_web', p.numero));
  perform private.otorgar_bienvenida(p.cliente_id);
  insert into public.venta_lineas (venta_id, orden, producto_clave, producto_nombre, categoria, tamano, presentacion, base, toppings, cantidad, precio_unitario_cop)
  select v_venta, l.orden, l.producto_clave, l.producto_nombre, l.categoria, l.tamano, l.presentacion, l.base, l.toppings, l.cantidad, l.precio_unitario_cop
  from public.pedido_web_lineas l where l.pedido_id = p.id;
  perform private.confirmar_interno(v_venta, now());
  v_pago := private.pagar_interno(v_venta, v_medio, p_efectivo_recibido, now(), false);

  update public.pedidos_web set estado = 'entregado', entregado_en = now(), venta_id = v_venta where id = p.id;
  perform private.evento_pedido_web(p.id, p.estado, 'entregado');
  return jsonb_build_object('pedido_id', p.id, 'numero', p.numero, 'venta_id', v_venta, 'estado', 'entregado',
    'total_cop', p.total_cop, 'medio_pago', v_medio, 'cambio_cop', v_pago -> 'cambio_cop',
    'puntos_acreditados', v_pago -> 'puntos_acreditados');
end;
$$;

-- "No llegó": solo cuando la ventana de recogida ya terminó. Al llegar al umbral, la cuenta queda señalada para el dueño.
create function public.marcar_no_llego(p_pedido uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pedidos_web;
  v_n integer;
  v_umbral integer := private.regla_int('pedido_web.no_llego_alerta');
  v_senalada boolean := false;
begin
  perform private.exigir_staff();
  select * into p from public.pedidos_web where id = p_pedido for update;
  if not found then raise exception 'El pedido no existe.'; end if;
  if p.estado not in ('recibido', 'preparando', 'listo') then raise exception 'El pedido % está %; no se puede marcar.', p.numero, p.estado; end if;
  if now() < p.ventana_fin then
    raise exception 'La ventana de recogida de este pedido termina más tarde; espera a que pase.';
  end if;
  update public.pedidos_web set estado = 'no_llego', no_llego_en = now() where id = p_pedido;
  perform private.evento_pedido_web(p_pedido, p.estado, 'no_llego');
  select count(*) into v_n from public.pedidos_web where cliente_id = p.cliente_id and estado = 'no_llego';
  if v_n >= v_umbral then
    v_senalada := true;
    if not exists (select 1 from public.alertas where tipo = 'no_llego' and cliente_id = p.cliente_id and resuelta_en is null) then
      insert into public.alertas (tipo, cliente_id, detalle)
      values ('no_llego', p.cliente_id, jsonb_build_object('pedidos_no_llego', v_n, 'ultimo_numero', p.numero));
    end if;
  end if;
  perform private.auditar('pedido_web_no_llego', 'pedido_web', p_pedido::text, jsonb_build_object('numero', p.numero, 'total_no_llego', v_n));
  return jsonb_build_object('estado', 'no_llego', 'no_llego_total', v_n, 'cuenta_senalada', v_senalada);
end;
$$;

create function public.cancelar_pedido_web(p_pedido uuid, p_motivo text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare p public.pedidos_web;
begin
  perform private.exigir_staff();
  if p_motivo is null or length(btrim(p_motivo)) = 0 then raise exception 'Escribe el motivo de la cancelación.'; end if;
  select * into p from public.pedidos_web where id = p_pedido for update;
  if not found then raise exception 'El pedido no existe.'; end if;
  if p.estado not in ('recibido', 'preparando', 'listo') then raise exception 'El pedido % está %; no se puede cancelar.', p.numero, p.estado; end if;
  if p.pago_en_linea_estado = 'pagado' then
    raise exception 'Este pedido ya se pagó en línea; la devolución la gestiona el dueño.';
  end if;
  update public.pedidos_web set estado = 'cancelado', cancelado_en = now(), motivo_cancelacion = btrim(p_motivo) where id = p_pedido;
  perform private.evento_pedido_web(p_pedido, p.estado, 'cancelado', btrim(p_motivo));
  perform private.auditar('cancelar_pedido_web', 'pedido_web', p_pedido::text, jsonb_build_object('numero', p.numero, 'motivo', btrim(p_motivo)));
  return private.pedido_web_json(p_pedido, false);
end;
$$;

-- El dueño decide qué hacer con una cuenta señalada: exigir prepago, bloquear o quitar la restricción (modo null).
create function public.restringir_pedidos_web(p_cliente uuid, p_modo text, p_motivo text, p_pin text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_fallo jsonb;
begin
  v_fallo := private.exigir_pin(p_pin, 'restringir_pedidos_web');
  if v_fallo is not null then return v_fallo; end if;
  if p_modo is not null and p_modo not in ('prepago', 'bloqueo') then raise exception 'Modo no válido: usa prepago o bloqueo.'; end if;
  if not exists (select 1 from public.perfiles where user_id = p_cliente) then raise exception 'Ese cliente no existe.'; end if;
  if p_modo is null then
    delete from public.cuentas_pedidos_web where cliente_id = p_cliente;
  else
    insert into public.cuentas_pedidos_web (cliente_id, modo, motivo, fijada_por)
    values (p_cliente, p_modo, nullif(btrim(coalesce(p_motivo, '')), ''), (select auth.uid()))
    on conflict (cliente_id) do update set modo = excluded.modo, motivo = excluded.motivo, fijada_por = excluded.fijada_por, fijada_en = now();
  end if;
  update public.alertas set resuelta_en = now(), resuelta_por = (select auth.uid()),
         nota = coalesce(nota, 'Decisión: ' || coalesce(p_modo, 'sin restricción'))
   where tipo = 'no_llego' and cliente_id = p_cliente and resuelta_en is null;
  perform private.auditar('restringir_pedidos_web', 'cliente', p_cliente::text, jsonb_build_object('modo', p_modo, 'motivo', p_motivo));
  return jsonb_build_object('ok', true, 'modo', p_modo);
end;
$$;

-- Interruptor de pedidos web: cualquier persona del personal lo enciende al abrir y lo apaga al cerrar.
create function public.fijar_pedidos_web(p_abierta boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  if p_abierta is null then raise exception 'Indica si se reciben pedidos o no.'; end if;
  if p_abierta and not private.bandera_activa('pedidos_web') then
    raise exception 'Los pedidos web no están habilitados. Pídele al dueño que los habilite.';
  end if;
  update public.pedidos_web_interruptor set abierta = p_abierta, cambiado_por = (select auth.uid()), cambiado_en = now() where id = 1;
  perform private.auditar('fijar_pedidos_web', 'pedidos_web', '1', jsonb_build_object('abierta', p_abierta));
  return jsonb_build_object('abierta', private.tienda_abierta(), 'habilitada', private.bandera_activa('pedidos_web'));
end;
$$;

-- Marca "Pedido web listo" junto al nombre en la lista de espera del POS.
create or replace function public.lista_espera() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'checkin_id', c.id, 'cliente_id', c.cliente_id,
      'nombre_pila', private.nombre_pila(p.nombre), 'inicial', private.inicial_apellido(p.nombre),
      'foto_url', p.foto_url, 'llegada_en', c.llegada_en, 'vence_en', c.vence_en,
      'cliente_nuevo', c.cliente_nuevo,
      'alerta_pendiente', (c.cliente_nuevo and c.alerta_vista_en is null),
      'regalo_bienvenida', exists (select 1 from public.vouchers w where w.cliente_id = c.cliente_id and w.tipo = 'bienvenida' and w.estado = 'activo' and w.vence_en > now()),
      'premio_listo', exists (select 1 from public.vouchers w where w.cliente_id = c.cliente_id and w.tipo = 'premio' and w.estado = 'activo' and w.vence_en > now()),
      'pedido_web_listo', exists (select 1 from public.pedidos_web w where w.cliente_id = c.cliente_id and w.estado = 'listo')) order by c.llegada_en)
    from public.checkins c join public.perfiles p on p.user_id = c.cliente_id
    where c.estado = 'activo' and c.vence_en > now()
  ), '[]'::jsonb);
end;
$$;

-- =============================================================================================
-- 6. Permisos de ejecución
-- =============================================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.mi_tienda()', 'public.crear_pedido_web(uuid,jsonb,timestamptz,timestamptz,text,text[],text)',
    'public.mis_pedidos_web(integer)', 'public.voy_en_camino(uuid)', 'public.cancelar_mi_pedido_web(uuid)',
    'public.pedidos_web_abiertos()', 'public.cambiar_estado_pedido_web(uuid,text)',
    'public.entregar_pedido_web(uuid,text,text,integer)', 'public.marcar_no_llego(uuid)',
    'public.cancelar_pedido_web(uuid,text)', 'public.restringir_pedidos_web(uuid,text,text,text)',
    'public.lista_espera()', 'public.fijar_pedidos_web(boolean)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- La configuración de la tienda es pública: la tienda la lee antes de que la persona inicie sesión.
  revoke all on function public.tienda_estado() from public;
  grant execute on function public.tienda_estado() to anon, authenticated;
  -- Los ayudantes internos no se exponen.
  revoke all on function private.evento_pedido_web(uuid, text, text, text) from public, anon, authenticated;
  revoke all on function private.tienda_abierta() from public, anon, authenticated;
  revoke all on function private.codigo_pedido_web() from public, anon, authenticated;
  revoke all on function private.pedido_web_json(uuid, boolean) from public, anon, authenticated;
  revoke all on function private.pedidos_abiertos_de(uuid) from public, anon, authenticated;
  revoke all on function private.cortesia_disponible(uuid) from public, anon, authenticated;
  revoke all on function private.validar_transicion_pedido_web() from public, anon, authenticated;
end $$;
