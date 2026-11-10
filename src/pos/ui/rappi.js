// Ventas de Rappi: un pedido a la vez, ya pagado por Rappi, con el mismo catálogo. Sin cliente, puntos ni QR.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fmtCop } from '../../lib/format.js';
import { precioLinea } from '../../lib/precio.js';
import { crearPanelCatalogo, resumenLinea } from './catalogo.js';
import { nuevaClave } from '../vender.js';

export function crearVistaRappi(ctx) {
  const el = h('section', { class: 'vista vista-rappi', 'data-vista': 'rappi' });
  const zona = h('div', { class: 'carrito' });
  let lineas = [];
  let idem = nuevaClave();
  let pedido = '';
  let ocupado = false;
  let mensaje = null;

  const panel = crearPanelCatalogo(ctx, (l) => {
    try { precioLinea(ctx.cat, l); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    lineas.push(l);
    mensaje = null;
    pintar();
  });
  el.append(panel.el, zona);

  async function registrar() {
    if (ocupado) return;
    if (!pedido.trim()) { ctx.avisar('Escribe el número de pedido de Rappi.', 'error'); return; }
    if (!lineas.length) { ctx.avisar('Agrega al menos un producto.', 'error'); return; }
    ocupado = true;
    try {
      const r = await ctx.api.registrarVentaRappi({ idem, pedido: pedido.trim(), lineas });
      mensaje = r.duplicada
        ? 'El pedido ' + pedido.trim() + ' ya estaba registrado; no se duplicó.'
        : 'Pedido ' + pedido.trim() + ' registrado por ' + fmtCop(r.total_cop) + '.';
      lineas = [];
      pedido = '';
      idem = nuevaClave();
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión. Las ventas de Rappi necesitan internet; inténtalo de nuevo (no se duplica).' : e.message, 'error');
    } finally {
      ocupado = false;
      pintar();
    }
  }

  function pintar() {
    vaciar(zona);
    let total = 0;
    const filas = lineas.map((l, i) => {
      let p = { subtotal: 0 };
      try { p = precioLinea(ctx.cat, l); } catch (e) { /* inválida */ }
      total += p.subtotal;
      const r = resumenLinea(ctx.cat, l);
      return h('li', { 'data-linea': i },
        h('div', null, h('strong', null, (l.cantidad > 1 ? l.cantidad + ' × ' : '') + r.nombre), r.detalle ? h('small', null, r.detalle) : null),
        h('span', { class: 'mono' }, fmtCop(p.subtotal)),
        h('button', { type: 'button', class: 'btn-icono', 'data-accion': 'quitar-linea', 'aria-label': 'Quitar', onclick: () => { lineas.splice(i, 1); pintar(); } }, '×'));
    });
    const campo = h('input', { type: 'text', 'data-campo': 'pedido-rappi', 'aria-label': 'Número de pedido de Rappi', value: pedido, maxlength: '40', autocomplete: 'off' });
    campo.addEventListener('input', () => { pedido = campo.value; });
    agregar(zona,
      h('h2', null, 'Venta de Rappi'),
      mensaje ? h('p', { class: 'ok', role: 'status', 'data-campo': 'mensaje-rappi' }, mensaje) : null,
      h('label', null, 'Número de pedido de Rappi', campo),
      filas.length ? h('ul', { class: 'lineas' }, filas) : h('p', { class: 'vacio' }, 'Aún no hay productos.'),
      h('p', { class: 'total' }, 'Total ', h('strong', { class: 'mono', 'data-campo': 'total' }, fmtCop(total))),
      h('button', { type: 'button', class: 'btn btn-primario grande', 'data-accion': 'registrar-rappi', disabled: ocupado, onclick: registrar }, 'Registrar venta de Rappi'));
  }

  pintar();
  return { el, pintar, repintarCatalogo: () => panel.pintar() };
}
