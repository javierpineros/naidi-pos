// Vista de venta. Dos modos:
//  - "vivo": venta con cliente. Cada cambio pasa por el servidor (precios, premios y totales los calcula él).
//  - "local": venta sin cliente. Se arma en el dispositivo y se cobra de una vez (admite vender sin internet).
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fmtCop, MEDIOS } from '../../lib/format.js';
import { precioLinea } from '../../lib/precio.js';
import { qrSvg } from '../../lib/qr.js';
import { crearPanelCatalogo, resumenLinea } from './catalogo.js';
import { pedirTexto, confirmar } from './modal.js';
import { nuevaClave, cobrarSinCliente } from '../vender.js';

export function crearVistaVenta(ctx) {
  const el = h('section', { class: 'vista vista-venta', 'data-vista': 'venta' });
  const zona = h('div', { class: 'carrito' });
  let v = null;
  let ocupado = false;

  const panel = crearPanelCatalogo(ctx, (linea) => agregarLinea(linea));
  el.append(panel.el, zona);

  const vacia = () => ({
    modo: 'local', idem: nuevaClave(), cliente: null, ventaId: null, lineas: [], servidor: null, vouchers: [],
    fase: 'armando', medio: 'efectivo', recibido: '', resultado: null, progreso: null,
  });

  async function guardar(fn) {
    if (ocupado) return undefined;
    ocupado = true;
    pintar();
    try {
      return await fn();
    } catch (e) {
      if (e.name === 'ErrorRed') {
        ctx.avisar(v && v.modo === 'vivo'
          ? 'Sin conexión. Una venta con cliente necesita internet; si no vuelve, véndela sin cliente.'
          : 'Sin conexión con el servidor.', 'error');
      } else {
        ctx.avisar(e.message, 'error');
      }
      return undefined;
    } finally {
      ocupado = false;
      pintar();
    }
  }

  async function recargar() {
    if (!v || v.modo !== 'vivo') return;
    v.servidor = await ctx.api.venta(v.ventaId);
    if (v.servidor && v.servidor.estado === 'alistando') v.vouchers = (await ctx.api.vouchersActivosDe(v.cliente.id)) || [];
  }

  // ---------------------------------------------------------------- Iniciar
  function iniciarSinCliente() {
    if (!v || v.fase === 'listo') v = vacia();
    ctx.irA('venta');
    pintar();
  }

  async function iniciarConCliente(item) {
    if (v && v.fase !== 'listo' && (v.lineas.length || v.modo === 'vivo')) {
      ctx.avisar('Termina o descarta la venta que tienes abierta antes de atender a otro cliente.', 'error');
      ctx.irA('venta');
      return;
    }
    await guardar(async () => {
      const idem = nuevaClave();
      const ventaId = await ctx.api.crearVenta({ idem, cliente: item.cliente_id });
      v = { ...vacia(), modo: 'vivo', idem, ventaId, cliente: { id: item.cliente_id, nombre: item.nombre_pila, inicial: item.inicial } };
      if (item.alerta_pendiente && item.checkin_id) { try { await ctx.api.marcarAlertaVista(item.checkin_id); } catch (e) { /* la alerta se marca sola luego */ } }
      await recargar();
      ctx.irA('venta');
      ctx.refrescarEspera();
    });
  }

  async function reanudar(ventaId) {
    await guardar(async () => {
      const row = await ctx.api.venta(ventaId);
      if (!row) throw new Error('No encuentro esa venta.');
      if (row.estado !== 'confirmada' && row.estado !== 'alistando') throw new Error('Esa venta ya no está abierta.');
      v = { ...vacia(), modo: 'vivo', idem: row.idempotency_key, ventaId, servidor: row, fase: row.estado === 'confirmada' ? 'pago' : 'armando',
        cliente: row.cliente_id ? { id: row.cliente_id, nombre: 'Cliente', inicial: '' } : null };
      if (!row.cliente_id) {
        // venta sin cliente que ya existe en el servidor: se continúa por ahí
        v.cliente = null;
        v.progreso = { ventaId };
        v.lineas = row.venta_lineas.map((l) => ({ producto: l.producto_clave, tamano: l.tamano, presentacion: l.presentacion, base: l.base, toppings: (l.toppings || []).map((t) => t.clave), cantidad: l.cantidad }));
        v.modo = 'local';
        v.servidor = null;
        v.fase = row.estado === 'confirmada' ? 'pago' : 'armando';
      } else {
        await recargar();
      }
      ctx.irA('venta');
    });
  }

  // Pasa una venta local (sin cliente) a una venta con cliente cuando el cliente aparece en la lista de espera.
  async function asignarCliente(item) {
    if (!v || v.modo !== 'local' || v.progreso) return;
    await guardar(async () => {
      const ventaId = await ctx.api.crearVenta({ idem: v.idem, cliente: item.cliente_id });
      const locales = v.lineas.slice();
      v = { ...v, modo: 'vivo', ventaId, cliente: { id: item.cliente_id, nombre: item.nombre_pila, inicial: item.inicial }, lineas: [] };
      let fallidas = 0;
      for (const l of locales) {
        try { await ctx.api.agregarLinea(ventaId, l); } catch (e) { if (e.name === 'ErrorRed') throw e; fallidas++; }
      }
      if (fallidas) ctx.avisar(fallidas + ' producto(s) no se pudieron pasar; revísalos.', 'error');
      if (item.checkin_id) { try { await ctx.api.marcarAlertaVista(item.checkin_id); } catch (e) { /* ok */ } }
      await recargar();
      ctx.refrescarEspera();
    });
  }

  // ---------------------------------------------------------------- Armado
  async function agregarLinea(linea) {
    if (!v || v.fase === 'listo') v = vacia();
    if (v.fase !== 'armando') { ctx.avisar('La venta ya está confirmada; no se le pueden agregar productos.', 'error'); return; }
    if (v.modo === 'local') {
      try { precioLinea(ctx.cat, linea); } catch (e) { ctx.avisar(e.message, 'error'); return; }
      v.lineas.push(linea);
      pintar();
      return;
    }
    await guardar(async () => {
      await ctx.api.agregarLinea(v.ventaId, linea);
      await recargar();
    });
  }

  async function quitar(fila) {
    if (v.modo === 'local') { v.lineas.splice(fila.indice, 1); pintar(); return; }
    await guardar(async () => { await ctx.api.quitarLinea(fila.id); await recargar(); });
  }

  async function repetirUltima() {
    await guardar(async () => {
      const u = await ctx.api.ultimaCompraDe(v.cliente.id);
      if (!u || !u.lineas.length) { ctx.avisar('Este cliente aún no tiene compras para repetir.', 'error'); return; }
      const fallidas = [];
      for (const l of u.lineas) {
        try {
          await ctx.api.agregarLinea(v.ventaId, { producto: l.producto, tamano: l.tamano, presentacion: l.presentacion, base: l.base, toppings: l.toppings, cantidad: l.cantidad });
        } catch (e) {
          if (e.name === 'ErrorRed') throw e;
          fallidas.push(l.nombre);
        }
      }
      if (fallidas.length) ctx.avisar('Ya no está disponible: ' + fallidas.join(', ') + '.', 'error');
      await recargar();
    });
  }

  async function aplicarPremio(w, lineaId) {
    await guardar(async () => {
      if (w.modalidad === 'descuento_compra') await ctx.api.aplicarVoucherCompra(v.ventaId, w.id);
      else await ctx.api.aplicarVoucher(lineaId, w.id);
      await recargar();
    });
  }

  async function quitarPremio(lineaId) {
    await guardar(async () => {
      if (lineaId) await ctx.api.quitarVoucher(lineaId);
      else await ctx.api.quitarVoucherCompra(v.ventaId);
      await recargar();
    });
  }

  // ---------------------------------------------------------------- Confirmar, cobrar, cancelar
  async function confirmarPedido() {
    if (v.modo === 'local') {
      if (!v.lineas.length) { ctx.avisar('Agrega al menos un producto.', 'error'); return; }
      v.fase = 'pago';
      pintar();
      return;
    }
    await guardar(async () => {
      await ctx.api.confirmarVenta(v.ventaId);
      await recargar();
      v.fase = 'pago';
    });
  }

  function totalActual() {
    if (v.modo === 'vivo') return v.servidor ? v.servidor.total_cop : 0;
    try { return v.lineas.reduce((a, l) => a + precioLinea(ctx.cat, l).subtotal, 0); } catch (e) { return 0; }
  }

  async function registrarPago() {
    const total = totalActual();
    const recibido = v.medio === 'efectivo' ? Number(String(v.recibido).replace(/\D/g, '')) : undefined;
    if (v.medio === 'efectivo' && (!recibido || recibido < total)) { ctx.avisar('El efectivo recibido no alcanza para el total.', 'error'); return; }
    await guardar(async () => {
      if (v.modo === 'vivo') {
        const resultado = await ctx.api.pagarVenta(v.ventaId, v.medio, recibido);
        v.resultado = { modo: 'servidor', resultado };
        ctx.refrescarEspera();
      } else {
        v.medio_pago = v.medio;
        const r = await cobrarSinCliente({
          api: ctx.api, cola: ctx.cola, enLinea: ctx.enLinea,
          venta: { idem: v.idem, lineas: v.lineas, medio: v.medio, efectivo_recibido: recibido, total_estimado: total, progreso: v.progreso },
        });
        v.resultado = r;
        if (r.modo === 'cola') ctx.avisarCola();
      }
      v.fase = 'listo';
    });
  }

  async function descartar() {
    if (v.modo === 'local') { v = null; pintar(); return; }
    const ok = await confirmar({ titulo: 'Descartar venta', mensaje: 'Se descarta esta venta y los premios aplicados quedan disponibles. ¿Seguro?', boton: 'Descartar' });
    if (!ok) return;
    await guardar(async () => { await ctx.api.descartarVenta(v.ventaId); v = null; ctx.refrescarEspera(); });
  }

  async function cancelarConfirmada() {
    const motivo = await pedirTexto({ titulo: 'Cancelar venta', etiqueta: 'Motivo de la cancelación', boton: 'Cancelar la venta' });
    if (!motivo) return;
    await guardar(async () => { await ctx.api.cancelarVenta(v.ventaId, motivo); v = null; });
  }

  // ---------------------------------------------------------------- Pintar
  function filas() {
    const cat = ctx.cat;
    if (v.modo === 'local') {
      return v.lineas.map((l, i) => {
        let p = { unitario: 0, subtotal: 0 };
        try { p = precioLinea(cat, l); } catch (e) { /* línea inválida: se muestra en 0 */ }
        const r = resumenLinea(cat, l);
        return { indice: i, titulo: r.nombre, detalle: r.detalle, cantidad: l.cantidad || 1, subtotal: p.subtotal, descuento: 0, voucher: null };
      });
    }
    if (!v.servidor) return [];
    return v.servidor.venta_lineas.map((l) => {
      const tops = (l.toppings || []).map((t) => t.nombre).join(', ');
      const partes = [l.tamano && cat.tamanos.get(l.tamano) ? cat.tamanos.get(l.tamano).nombre : null,
        l.presentacion && l.presentacion !== 'bowl' && cat.presentaciones.get(l.presentacion) ? cat.presentaciones.get(l.presentacion).nombre : null,
        l.base && cat.bases.get(l.base) ? cat.bases.get(l.base).nombre : null, tops || null].filter(Boolean);
      return { id: l.id, titulo: l.producto_nombre, detalle: partes.join(' · '), cantidad: l.cantidad, subtotal: l.cantidad * l.precio_unitario_cop, descuento: l.descuento_cop, voucher: l.voucher_id };
    });
  }

  function pintarPremios(lista) {
    if (v.modo !== 'vivo' || v.fase !== 'armando') return null;
    const aplicadoCompra = v.servidor && v.servidor.voucher_compra_id;
    const bloques = [];
    if (aplicadoCompra) {
      bloques.push(h('div', { class: 'premio aplicado', 'data-premio': 'compra' }, 'Descuento sobre la compra aplicado',
        h('button', { type: 'button', class: 'btn', 'data-accion': 'quitar-premio-compra', onclick: () => quitarPremio(null) }, 'Quitar')));
    }
    for (const w of v.vouchers) {
      const nombreTipo = w.tipo === 'bienvenida' ? 'Regalo de bienvenida' : 'Premio';
      if (w.modalidad === 'descuento_compra') {
        if (aplicadoCompra) continue;
        bloques.push(h('div', { class: 'premio', 'data-premio': w.id },
          h('span', null, nombreTipo + ': ' + w.descuento_pct + '% de la compra'),
          h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'aplicar-premio', onclick: () => aplicarPremio(w) }, 'Aplicar')));
        continue;
      }
      const elegibles = lista.filter((f) => !f.voucher && f.id && (w.modalidad === 'toppings_gratis' || (w.tamanos || []).length));
      const sel = h('select', { 'data-campo': 'linea-premio', 'aria-label': 'Producto para el premio' },
        elegibles.map((f) => h('option', { value: f.id }, f.titulo + (f.detalle ? ' · ' + f.detalle : ''))));
      const texto = w.modalidad === 'toppings_gratis'
        ? nombreTipo + ': ' + w.cantidad_toppings + (w.cantidad_toppings === 1 ? ' topping gratis' : ' toppings gratis')
        : nombreTipo + ': ' + w.descuento_pct + '% en un bowl';
      bloques.push(h('div', { class: 'premio', 'data-premio': w.id },
        h('span', null, texto), sel,
        h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'aplicar-premio', disabled: !elegibles.length, onclick: () => aplicarPremio(w, sel.value) }, 'Aplicar')));
    }
    if (!bloques.length) return null;
    return h('div', { class: 'premios' }, h('h3', null, 'Premios del cliente'), bloques);
  }

  function pintarPago(total) {
    const destino = ctx.destino();
    const cambio = h('strong', { class: 'mono', 'data-campo': 'cambio' }, '');
    const boton = h('button', { type: 'button', class: 'btn btn-primario grande', 'data-accion': 'registrar-pago', onclick: registrarPago }, 'Registrar pago');
    const actualizar = () => {
      const r = Number(String(v.recibido).replace(/\D/g, '')) || 0;
      cambio.textContent = v.medio === 'efectivo' ? (r >= total ? 'Cambio: ' + fmtCop(r - total) : 'Faltan ' + fmtCop(total - r)) : '';
      boton.disabled = v.medio === 'efectivo' && r < total;
    };
    const recibido = h('input', { type: 'text', inputmode: 'numeric', 'data-campo': 'recibido', 'aria-label': 'Efectivo recibido', value: v.recibido, autocomplete: 'off' });
    recibido.addEventListener('input', () => { v.recibido = recibido.value; actualizar(); });
    const medios = ['efectivo', 'datafono_bold', 'transferencia'].map((m) =>
      h('button', { type: 'button', class: 'chip' + (v.medio === m ? ' activo' : ''), 'data-medio': m, onclick: () => { v.medio = m; pintar(); } }, MEDIOS[m]));
    const nodos = [h('h3', null, 'Cobro'), h('div', { class: 'chips' }, medios)];
    if (v.medio === 'efectivo') {
      nodos.push(h('label', null, 'Efectivo recibido', recibido),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'monto-exacto', onclick: () => { v.recibido = String(total); pintar(); } }, 'Monto exacto'), cambio);
    } else if (v.medio === 'transferencia') {
      nodos.push(h('p', { 'data-campo': 'destino' }, destino && destino.valor
        ? 'El cliente transfiere a ' + (destino.tipo === 'bre-b' ? 'la llave Bre-B ' : 'este número ') + destino.valor + '. Verifica en la app del banco que entró.'
        : 'Aún no hay llave Bre-B ni número configurado; el dueño lo completa en el panel. Verifica en la app del banco que el pago entró.'));
    } else {
      nodos.push(h('p', null, 'Cobra en el datáfono y confirma que la transacción quedó aprobada.'));
    }
    nodos.push(boton);
    actualizar();
    return h('div', { class: 'pago' }, nodos);
  }

  function pintarListo() {
    const r = v.resultado;
    const nodos = [];
    if (r.modo === 'cola') {
      nodos.push(h('h2', null, 'Venta guardada sin conexión'),
        h('p', null, 'Ya puedes entregar el pedido. Se enviará sola cuando vuelva el internet.'));
    } else if (r.yaPagada) {
      nodos.push(h('h2', null, 'La venta ya estaba pagada'));
    } else {
      const res = r.resultado;
      nodos.push(h('h2', { 'data-campo': 'pagado' }, 'Pagado ✓'));
      if (res.cambio_cop !== null && res.cambio_cop !== undefined) nodos.push(h('p', { class: 'mono' }, 'Cambio: ' + fmtCop(res.cambio_cop)));
      if (v.modo === 'vivo') nodos.push(h('p', { 'data-campo': 'puntos' }, 'Puntos acreditados a ' + v.cliente.nombre + ': ' + (res.puntos_acreditados || 0)));
      if (res.qr_token) {
        const url = ctx.origen() + '/cuenta/#qr=' + res.qr_token;
        nodos.push(h('div', { class: 'qr-posventa', 'data-campo': 'qr-posventa' },
          h('p', null, '¿El cliente quiere sus puntos? Que escanee este código con su celular. Dura 30 minutos y se usa una sola vez.'),
          qrSvg(url, 6)));
      }
    }
    nodos.push(h('button', { type: 'button', class: 'btn btn-primario grande', 'data-accion': 'nueva-venta', onclick: () => { v = null; pintar(); ctx.irA('espera'); } }, 'Nueva venta'));
    return h('div', { class: 'listo' }, nodos);
  }

  function pintar() {
    vaciar(zona);
    if (!v) {
      zona.append(h('div', { class: 'vacio' }, h('h2', null, 'Sin venta abierta'),
        h('p', null, 'Atiende a un cliente de la lista de espera, o empieza una venta sin cliente.'),
        h('button', { type: 'button', class: 'btn btn-primario grande', 'data-accion': 'venta-sin-cliente', onclick: iniciarSinCliente }, 'Venta sin cliente')));
      return;
    }
    if (v.fase === 'listo') { zona.append(pintarListo()); return; }

    const lista = filas();
    const total = totalActual();
    const encabezado = h('div', { class: 'cliente' },
      v.cliente
        ? h('strong', { 'data-campo': 'cliente' }, 'Cliente: ' + v.cliente.nombre + (v.cliente.inicial ? ' ' + v.cliente.inicial + '.' : ''))
        : h('strong', { 'data-campo': 'cliente' }, 'Sin cliente'));
    if (v.modo === 'local' && v.fase === 'armando' && !v.progreso && ctx.espera().length) {
      const sel = h('select', { 'data-campo': 'asignar', 'aria-label': 'Cliente en espera' },
        ctx.espera().map((i) => h('option', { value: i.cliente_id }, i.nombre_pila + ' ' + (i.inicial ? i.inicial + '.' : ''))));
      encabezado.append(sel, h('button', { type: 'button', class: 'btn', 'data-accion': 'asignar-cliente',
        onclick: () => asignarCliente(ctx.espera().find((i) => i.cliente_id === sel.value)) }, 'Asignar cliente'));
    }
    if (v.modo === 'vivo' && v.fase === 'armando') {
      encabezado.append(h('button', { type: 'button', class: 'btn', 'data-accion': 'repetir-ultima', onclick: repetirUltima }, 'Repetir lo de la última vez'));
    }

    const items = lista.length
      ? h('ul', { class: 'lineas' }, lista.map((f) =>
          h('li', { 'data-linea': f.id || f.indice },
            h('div', null, h('strong', null, (f.cantidad > 1 ? f.cantidad + ' × ' : '') + f.titulo), f.detalle ? h('small', null, f.detalle) : null,
              f.descuento ? h('small', { class: 'descuento' }, 'Premio: −' + fmtCop(f.descuento)) : null),
            h('span', { class: 'mono' }, fmtCop(f.subtotal)),
            v.fase === 'armando' ? h('button', { type: 'button', class: 'btn-icono', 'data-accion': 'quitar-linea', 'aria-label': 'Quitar', onclick: () => quitar(f) }, '×') : null,
            f.voucher && v.fase === 'armando' ? h('button', { type: 'button', class: 'btn', 'data-accion': 'quitar-premio', onclick: () => quitarPremio(f.id) }, 'Quitar premio') : null)))
      : h('p', { class: 'vacio' }, 'Aún no hay productos.');

    const sub = v.modo === 'vivo' && v.servidor ? v.servidor.subtotal_cop : total;
    const desc = v.modo === 'vivo' && v.servidor ? v.servidor.descuento_cop : 0;
    const totales = h('div', { class: 'totales' },
      desc ? h('p', null, 'Subtotal ', h('span', { class: 'mono' }, fmtCop(sub))) : null,
      desc ? h('p', { class: 'descuento' }, 'Premios ', h('span', { class: 'mono' }, '−' + fmtCop(desc))) : null,
      h('p', { class: 'total' }, 'Total ', h('strong', { class: 'mono', 'data-campo': 'total' }, fmtCop(total))));

    const acciones = [];
    if (v.fase === 'armando') {
      acciones.push(
        h('button', { type: 'button', class: 'btn btn-primario grande', 'data-accion': 'confirmar-pedido', disabled: !lista.length || ocupado, onclick: confirmarPedido },
          v.modo === 'vivo' ? 'Confirmar pedido' : 'Cobrar'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'descartar', disabled: ocupado, onclick: descartar }, 'Descartar venta'));
    } else if (v.modo === 'vivo') {
      acciones.push(h('button', { type: 'button', class: 'btn', 'data-accion': 'cancelar-venta', disabled: ocupado, onclick: cancelarConfirmada }, 'Cancelar venta'));
    } else if (!v.progreso) {
      acciones.push(h('button', { type: 'button', class: 'btn', 'data-accion': 'volver-a-armar', onclick: () => { v.fase = 'armando'; pintar(); } }, 'Volver a editar'));
    }

    agregar(zona, encabezado, items, pintarPremios(lista), totales, v.fase === 'pago' ? pintarPago(total) : null, h('div', { class: 'acciones' }, acciones));
  }

  pintar();
  return {
    el, iniciarConCliente, iniciarSinCliente, reanudar, pintar, repintarCatalogo: () => panel.pintar(),
    hayVenta: () => !!v && v.fase !== 'listo',
  };
}
