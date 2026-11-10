-- H5: soporte del POS en el servidor: cierre de caja, alertas para el dueño, reportes y "repetir lo de la última vez".
-- Los totales se calculan por el día en hora de Bogotá. Un cierre guarda una copia del resumen (no cambia si luego se anula algo).

create function private.dia_bogota(p_ts timestamptz) returns date
language sql immutable set search_path = ''
as $$ select (p_ts at time zone 'America/Bogota')::date $$;

-- ---------------------------------------------------------------------------------------------
-- Cierres de caja y alertas
-- ---------------------------------------------------------------------------------------------
create table public.cierres_caja (
  id          uuid primary key default gen_random_uuid(),
  fecha       date not null unique,
  cerrado_por uuid references auth.users (id),
  cerrado_en  timestamptz not null default now(),
  resumen     jsonb not null
);
create trigger cierres_caja_inmutable before update or delete on public.cierres_caja
  for each row execute function private.bloquear_mutacion();

create table public.alertas (
  id           bigint generated always as identity primary key,
  tipo         text not null check (tipo in ('venta_sin_pagar', 'compras_inusuales', 'no_llego', 'reclamos_tope')),
  venta_id     uuid references public.ventas (id),
  cliente_id   uuid references auth.users (id),
  detalle      jsonb not null default '{}'::jsonb,
  creada_en    timestamptz not null default now(),
  resuelta_en  timestamptz,
  resuelta_por uuid references auth.users (id),
  nota         text
);
create unique index alertas_una_abierta_por_venta on public.alertas (tipo, venta_id) where resuelta_en is null and venta_id is not null;

alter table public.cierres_caja enable row level security;
alter table public.alertas      enable row level security;
revoke all on public.cierres_caja, public.alertas from anon, authenticated;
grant select on public.cierres_caja, public.alertas to authenticated;
create policy cierres_ver_staff on public.cierres_caja for select to authenticated using ((select private.es_staff()));
create policy alertas_ver_dueno on public.alertas      for select to authenticated using ((select private.es_dueno()));

-- ---------------------------------------------------------------------------------------------
-- Cierre de caja del día, separado por medio de pago (para conciliar con Bold y el extracto bancario)
-- ---------------------------------------------------------------------------------------------
create function private.resumen_caja(p_fecha date) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'fecha', p_fecha,
    'por_medio', coalesce((
      select jsonb_agg(jsonb_build_object('medio', x.medio_pago, 'ventas', x.n, 'total_cop', x.t) order by x.medio_pago)
      from (select v.medio_pago, count(*) as n, sum(v.total_cop)::integer as t
              from public.ventas v where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) = p_fecha
             group by v.medio_pago) x), '[]'::jsonb),
    'total_cop', coalesce((select sum(v.total_cop) from public.ventas v where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) = p_fecha), 0)::integer,
    'ventas', (select count(*) from public.ventas v where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) = p_fecha),
    'anuladas', jsonb_build_object(
      'ventas', (select count(*) from public.ventas v where v.estado = 'anulada' and private.dia_bogota(v.pagada_en) = p_fecha),
      'total_cop', coalesce((select sum(v.total_cop) from public.ventas v where v.estado = 'anulada' and private.dia_bogota(v.pagada_en) = p_fecha), 0)::integer),
    'canceladas', (select count(*) from public.ventas v where v.estado = 'cancelada' and private.dia_bogota(v.cancelada_en) = p_fecha),
    'sin_pagar', coalesce((
      select jsonb_agg(jsonb_build_object('venta_id', v.id, 'numero', v.numero, 'total_cop', v.total_cop,
               'confirmada_en', v.confirmada_en, 'cliente', private.nombre_pila(p.nombre)) order by v.confirmada_en)
      from public.ventas v left join public.perfiles p on p.user_id = v.cliente_id
      where v.estado = 'confirmada' and private.dia_bogota(v.confirmada_en) <= p_fecha), '[]'::jsonb));
$$;

create function public.cierre_de_caja(p_fecha date default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_f date := coalesce(p_fecha, private.dia_bogota(now()));
  v_c public.cierres_caja;
begin
  perform private.exigir_staff();
  select * into v_c from public.cierres_caja where fecha = v_f;
  if found then
    return v_c.resumen || jsonb_build_object('cerrado', true, 'cerrado_en', v_c.cerrado_en);
  end if;
  return private.resumen_caja(v_f) || jsonb_build_object('cerrado', false);
end;
$$;

-- Cerrar la caja guarda el resumen y marca para el dueño las ventas confirmadas que siguen sin pagar.
create function public.cerrar_caja(p_fecha date default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_f date := coalesce(p_fecha, private.dia_bogota(now()));
  v_res jsonb;
  v_n integer;
  v_c public.cierres_caja;
begin
  perform private.exigir_staff();
  if v_f > private.dia_bogota(now()) then raise exception 'No se puede cerrar la caja de un día futuro.'; end if;
  select * into v_c from public.cierres_caja where fecha = v_f;
  if found then
    return v_c.resumen || jsonb_build_object('cerrado', true, 'cerrado_en', v_c.cerrado_en, 'ya_estaba_cerrada', true);
  end if;
  v_res := private.resumen_caja(v_f);
  insert into public.cierres_caja (fecha, cerrado_por, resumen) values (v_f, (select auth.uid()), v_res);
  insert into public.alertas (tipo, venta_id, cliente_id, detalle)
  select 'venta_sin_pagar', v.id, v.cliente_id,
         jsonb_build_object('numero', v.numero, 'total_cop', v.total_cop, 'confirmada_en', v.confirmada_en, 'cierre', v_f)
    from public.ventas v where v.estado = 'confirmada' and private.dia_bogota(v.confirmada_en) <= v_f
  on conflict do nothing;
  get diagnostics v_n = row_count;
  perform private.auditar('cerrar_caja', 'caja', v_f::text, jsonb_build_object('total_cop', v_res -> 'total_cop', 'alertas', v_n));
  return v_res || jsonb_build_object('cerrado', true, 'alertas_creadas', v_n, 'ya_estaba_cerrada', false);
end;
$$;

create function public.lista_alertas() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'tipo', a.tipo, 'venta_id', a.venta_id, 'detalle', a.detalle, 'creada_en', a.creada_en) order by a.creada_en)
    from public.alertas a where a.resuelta_en is null), '[]'::jsonb);
end;
$$;

create function public.resolver_alerta(p_id bigint, p_nota text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  if p_nota is null or length(btrim(p_nota)) = 0 then raise exception 'Escribe qué pasó con esto.'; end if;
  update public.alertas set resuelta_en = now(), resuelta_por = (select auth.uid()), nota = btrim(p_nota)
   where id = p_id and resuelta_en is null;
  if not found then raise exception 'Esa alerta no existe o ya se resolvió.'; end if;
  perform private.auditar('resolver_alerta', 'alerta', p_id::text, jsonb_build_object('nota', btrim(p_nota)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Reportes del dueño: ventas por sabor, tamaño y hora; canjes y costo de premios
-- ---------------------------------------------------------------------------------------------
create function public.reporte_ventas(p_desde date, p_hasta date) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_dueno();
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 366 then
    raise exception 'Revisa el rango de fechas (máximo un año).';
  end if;
  return jsonb_build_object(
    'desde', p_desde, 'hasta', p_hasta,
    'totales', (select jsonb_build_object('ventas', count(*), 'total_cop', coalesce(sum(v.total_cop), 0),
                  'ticket_promedio_cop', coalesce(round(avg(v.total_cop)), 0))
                  from public.ventas v where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta),
    'por_sabor', coalesce((
      select jsonb_agg(jsonb_build_object('sabor', x.sabor, 'unidades', x.u, 'ingresos_cop', x.i) order by x.i desc)
      from (select coalesce(p.sabor, b.nombre, l.producto_nombre) as sabor, sum(l.cantidad)::integer as u,
                   sum(l.cantidad * l.precio_unitario_cop - l.descuento_cop)::integer as i
              from public.venta_lineas l
              join public.ventas v on v.id = l.venta_id
              join public.productos p on p.clave = l.producto_clave
              left join public.bases b on b.clave = l.base
             where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta
             group by 1) x), '[]'::jsonb),
    'por_tamano', coalesce((
      select jsonb_agg(jsonb_build_object('tamano', x.t, 'unidades', x.u, 'ingresos_cop', x.i) order by x.i desc)
      from (select coalesce(t.nombre, 'Sin tamaño') as t, sum(l.cantidad)::integer as u,
                   sum(l.cantidad * l.precio_unitario_cop - l.descuento_cop)::integer as i
              from public.venta_lineas l
              join public.ventas v on v.id = l.venta_id
              left join public.tamanos t on t.clave = l.tamano
             where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta
             group by 1) x), '[]'::jsonb),
    'por_hora', coalesce((
      select jsonb_agg(jsonb_build_object('hora', x.h, 'ventas', x.n, 'total_cop', x.t) order by x.h)
      from (select extract(hour from v.pagada_en at time zone 'America/Bogota')::integer as h, count(*) as n, sum(v.total_cop)::integer as t
              from public.ventas v where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta
             group by 1) x), '[]'::jsonb),
    'por_canal', coalesce((
      select jsonb_agg(jsonb_build_object('canal', x.canal, 'ventas', x.n, 'total_cop', x.t) order by x.canal)
      from (select v.canal, count(*) as n, sum(v.total_cop)::integer as t
              from public.ventas v where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta
             group by v.canal) x), '[]'::jsonb));
end;
$$;

create function public.reporte_canjes(p_desde date, p_hasta date) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ventas integer;
  v_costo integer;
begin
  perform private.exigir_dueno();
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 366 then
    raise exception 'Revisa el rango de fechas (máximo un año).';
  end if;
  select coalesce(sum(v.total_cop), 0)::integer into v_ventas
    from public.ventas v where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta;
  -- costo = lo que se dejó de cobrar por premios y regalos en ventas pagadas (descuentos en líneas y sobre la compra)
  select coalesce(sum(x.costo), 0)::integer into v_costo from (
    select (v.descuento_cop) as costo from public.ventas v
     where v.estado = 'pagada' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta and v.descuento_cop > 0) x;
  return jsonb_build_object(
    'desde', p_desde, 'hasta', p_hasta,
    'canjes', (select jsonb_build_object('cantidad', count(*), 'puntos', coalesce(-sum(l.puntos), 0))
                 from public.puntos_libro l where l.tipo = 'canje' and private.dia_bogota(l.creado_en) between p_desde and p_hasta),
    'puntos_acreditados', (select coalesce(sum(l.puntos), 0) from public.puntos_libro l
                            where l.tipo = 'suma' and private.dia_bogota(l.creado_en) between p_desde and p_hasta),
    'costo_premios', coalesce((
      select jsonb_agg(jsonb_build_object('tipo', y.tipo, 'modalidad', y.modalidad, 'usos', y.usos, 'costo_cop', y.costo) order by y.tipo, y.modalidad)
      from (
        select w.tipo, w.modalidad, count(distinct w.id) as usos,
               coalesce(sum(case when w.modalidad = 'descuento_compra' then v.descuento_cop - coalesce(ld.d, 0) else l.descuento_cop end), 0)::integer as costo
          from public.vouchers w
          join public.ventas v on v.id = w.venta_id and v.estado = 'pagada'
          left join public.venta_lineas l on l.voucher_id = w.id
          left join lateral (select sum(descuento_cop) as d from public.venta_lineas where venta_id = v.id) ld on true
         where w.estado = 'usado' and private.dia_bogota(v.pagada_en) between p_desde and p_hasta
         group by w.tipo, w.modalidad) y), '[]'::jsonb),
    'costo_total_cop', v_costo,
    'ventas_pagadas_cop', v_ventas,
    'costo_sobre_ventas_pct', case when v_ventas > 0 then round(v_costo * 100.0 / v_ventas, 1) else 0 end);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- "Repetir lo de la última vez": las líneas de la última venta pagada del cliente
-- ---------------------------------------------------------------------------------------------
create function public.ultima_compra_de(p_cliente uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v public.ventas;
begin
  perform private.exigir_staff();
  select * into v from public.ventas where cliente_id = p_cliente and estado = 'pagada' order by pagada_en desc, numero desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('venta_id', v.id, 'pagada_en', v.pagada_en, 'lineas', coalesce((
    select jsonb_agg(jsonb_build_object('producto', l.producto_clave, 'nombre', l.producto_nombre, 'tamano', l.tamano,
             'presentacion', l.presentacion, 'base', l.base, 'cantidad', l.cantidad,
             'toppings', coalesce((select jsonb_agg(t ->> 'clave') from jsonb_array_elements(l.toppings) t), '[]'::jsonb)) order by l.orden)
    from public.venta_lineas l where l.venta_id = v.id), '[]'::jsonb));
end;
$$;

-- Ventas del día para el POS (vendedor): lo mínimo para ver y, el dueño, anular.
create function public.ventas_del_dia(p_fecha date default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_f date := coalesce(p_fecha, private.dia_bogota(now()));
begin
  perform private.exigir_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', v.id, 'numero', v.numero, 'estado', v.estado, 'canal', v.canal, 'medio_pago', v.medio_pago,
             'total_cop', v.total_cop, 'cliente', private.nombre_pila(p.nombre), 'pagada_en', v.pagada_en, 'confirmada_en', v.confirmada_en)
           order by v.numero desc)
    from public.ventas v left join public.perfiles p on p.user_id = v.cliente_id
    where private.dia_bogota(coalesce(v.pagada_en, v.confirmada_en, v.creada_en)) = v_f and v.estado in ('confirmada', 'pagada', 'anulada')), '[]'::jsonb);
end;
$$;

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
