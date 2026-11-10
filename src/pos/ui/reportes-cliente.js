// Reportes del cliente: cuando alguien toca "esto no es lo que pedí" en su celular, el vendedor lo ve aquí al instante
// (desde cualquier pestaña), con sonido una sola vez por reporte, y lo marca como revisado cuando lo atiende.
import { h, vaciar } from '../../lib/dom.js';
import { fmtCop } from '../../lib/format.js';

export function crearReportesCliente(ctx) {
  const el = h('section', { class: 'reportes-cliente', 'aria-live': 'assertive', 'data-campo': 'reportes-cliente' });
  const avisados = new Set();
  let items = [];

  function pintar() {
    vaciar(el);
    el.hidden = !items.length;
    for (const r of items) {
      el.append(h('article', { class: 'reporte-item', 'data-reporte': r.id },
        h('div', { class: 'reporte-texto' },
          h('strong', null, '⚠ ' + r.cliente + ' dice que su pedido no es lo que pidió'),
          h('small', null, 'Venta #' + r.numero + ' · ' + fmtCop(r.total_cop) + (r.nota ? ' · «' + r.nota + '»' : ''))),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'reporte-revisado', onclick: () => revisado(r) }, 'Ya lo revisé')));
    }
  }

  async function revisado(r) {
    try { await ctx.api.resolverReporte(r.id); } catch (e) { ctx.avisar(e.message, 'error'); }
    await refrescar();
  }

  async function refrescar() {
    let nuevos;
    try { nuevos = (await ctx.api.reportesAbiertos()) || []; } catch (e) { return; }   // sin internet se conserva lo que había
    items = nuevos;
    let hayNuevo = false;
    for (const r of items) { if (!avisados.has(r.id)) { avisados.add(r.id); hayNuevo = true; } }
    if (hayNuevo) ctx.sonido.alertar();
    pintar();
  }

  pintar();
  return { el, refrescar, items: () => items };
}
