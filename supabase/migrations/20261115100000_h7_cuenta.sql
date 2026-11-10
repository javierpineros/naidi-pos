-- H7: cuenta del cliente (/cuenta). Casi todo lo que necesita ya existe (mi_saldo, mis_movimientos, mis_vouchers,
-- mi_compra_en_curso, canjear_premio, hacer_checkin, mi_checkin, reclamar_qr_posventa, actualizar_mi_perfil,
-- registrar_consentimiento). Aquí se agrega lo que falta: el reporte "esto no es lo que pedí", el historial de
-- compras, la lectura del perfil y las reglas públicas de fidelización.

-- =============================================================================================
-- 1. "Esto no es lo que pedí": el cliente avisa y el vendedor lo ve al instante en el POS
-- =============================================================================================
alter table public.alertas drop constraint alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('venta_sin_pagar', 'compras_inusuales', 'no_llego', 'reclamos_tope', 'cliente_reporta'));

-- El cliente no cancela ni cambia nada solo: deja el aviso (con una nota opcional) y el vendedor resuelve.
create function public.reportar_pedido(p_venta uuid, p_nota text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.exigir_cliente();
  v public.ventas;
  v_nota text := nullif(btrim(coalesce(p_nota, '')), '');
  v_filas integer;
begin
  if v_nota is not null and length(v_nota) > 200 then
    raise exception 'La nota es muy larga (máximo 200 letras).';
  end if;
  select * into v from public.ventas where id = p_venta and cliente_id = v_uid;
  if not found then raise exception 'No encontramos ese pedido.'; end if;
  if v.estado <> 'confirmada' then
    raise exception 'Este pedido ya no se puede reportar desde aquí. Habla con el personal.';
  end if;
  if (select count(*) from public.alertas where tipo = 'cliente_reporta' and venta_id = p_venta) >= 3 then
    raise exception 'Ya avisaste varias veces sobre este pedido. Habla con el personal.';
  end if;
  insert into public.alertas (tipo, venta_id, cliente_id, detalle)
  values ('cliente_reporta', p_venta, v_uid, jsonb_build_object('numero', v.numero, 'nota', v_nota))
  on conflict (tipo, venta_id) where resuelta_en is null and venta_id is not null do nothing;
  get diagnostics v_filas = row_count;
  if v_filas > 0 then
    perform private.auditar('reportar_pedido', 'venta', p_venta::text, jsonb_build_object('numero', v.numero));
  end if;
  return jsonb_build_object('ok', true, 'ya_reportado', v_filas = 0);
end;
$$;

-- Lo que ve el vendedor: reportes abiertos de ventas que siguen confirmadas (sin pagar).
create function public.reportes_abiertos() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'venta_id', a.venta_id, 'numero', v.numero, 'total_cop', v.total_cop,
             'cliente', private.nombre_pila(p.nombre), 'nota', a.detalle ->> 'nota', 'creada_en', a.creada_en) order by a.creada_en)
    from public.alertas a
    join public.ventas v on v.id = a.venta_id
    left join public.perfiles p on p.user_id = a.cliente_id
    where a.tipo = 'cliente_reporta' and a.resuelta_en is null and v.estado = 'confirmada'), '[]'::jsonb);
end;
$$;

create function public.resolver_reporte(p_id bigint, p_nota text default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_nota text := coalesce(nullif(btrim(coalesce(p_nota, '')), ''), 'Revisado por el vendedor');
begin
  perform private.exigir_staff();
  update public.alertas set resuelta_en = now(), resuelta_por = (select auth.uid()), nota = v_nota
   where id = p_id and tipo = 'cliente_reporta' and resuelta_en is null;
  if not found then raise exception 'Ese reporte no existe o ya se resolvió.'; end if;
  perform private.auditar('resolver_reporte', 'alerta', p_id::text, jsonb_build_object('nota', v_nota));
end;
$$;

-- =============================================================================================
-- 2. Historial de compras del cliente (pagadas) y su perfil
-- =============================================================================================
create function public.mis_compras(p_limite integer default 30) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return coalesce((
    select jsonb_agg(c.fila order by c.pagada_en desc, c.numero desc)
    from (
      select v.pagada_en, v.numero,
             jsonb_build_object(
               'venta_id', v.id, 'numero', v.numero, 'pagada_en', v.pagada_en, 'total_cop', v.total_cop,
               'descuento_cop', v.descuento_cop, 'medio_pago', v.medio_pago,
               'puntos', coalesce((select sum(p.puntos) from public.puntos_libro p where p.venta_id = v.id and p.tipo = 'suma'), 0),
               'lineas', coalesce((select jsonb_agg(jsonb_build_object('producto', l.producto_nombre, 'tamano', l.tamano, 'cantidad', l.cantidad) order by l.orden)
                                     from public.venta_lineas l where l.venta_id = v.id), '[]'::jsonb)) as fila
        from public.ventas v
       where v.cliente_id = v_uid and v.estado = 'pagada'
       order by v.pagada_en desc, v.numero desc
       limit least(greatest(p_limite, 1), 100)) c), '[]'::jsonb);
end;
$$;

create function public.mi_perfil() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.exigir_cliente();
begin
  return (
    select jsonb_build_object(
      'nombre', p.nombre, 'nombre_pila', private.nombre_pila(p.nombre), 'foto_url', p.foto_url,
      'celular', p.celular, 'cumpleanos', p.cumpleanos,
      'privacidad_version', private.regla_vigente('privacidad.version') #>> '{}',
      'acepta_datos', private.tiene_consentimiento_datos(v_uid),
      'acepta_mensajes', coalesce((select c.acepta from public.consentimientos c
                                    where c.user_id = v_uid and c.tipo = 'mensajes' order by c.en desc, c.id desc limit 1), false),
      'compras_pagadas', (select count(*) from public.ventas v where v.cliente_id = v_uid and v.estado = 'pagada'))
    from public.perfiles p where p.user_id = v_uid);
end;
$$;

-- =============================================================================================
-- 3. Reglas de fidelización que el cliente puede ver (progreso hacia el premio, vigencias)
-- =============================================================================================
create function public.reglas_fidelizacion() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.exigir_cliente();
  return jsonb_build_object(
    'umbrales', private.regla_vigente('premio.umbrales_puntos'),
    'descuento_pct', private.regla_vigente('premio.descuento_pct'),
    'cop_por_punto', private.regla_vigente('puntos.cop_por_punto'),
    'voucher_dias', private.regla_vigente('voucher.vigencia_dias'),
    'checkin_min', private.regla_vigente('checkin.vigencia_min'));
end;
$$;

-- =============================================================================================
-- 4. Permisos de ejecución: solo con sesión (nada para anon). pantalla_estado (H6) no se toca.
-- =============================================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.reportar_pedido(uuid,text)', 'public.reportes_abiertos()', 'public.resolver_reporte(bigint,text)',
    'public.mis_compras(integer)', 'public.mi_perfil()', 'public.reglas_fidelizacion()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
