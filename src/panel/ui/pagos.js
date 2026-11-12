// Pagos Bold: devoluciones por resolver, pagos pendientes, recientes y si la conciliación automática está viva.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fmtCop, fechaCorta, horaBogota } from '../../lib/format.js';
import { pedirTexto } from '../../pos/ui/modal.js';

const ESTADOS = { pendiente: 'Pendiente', aprobado: 'Aprobado', rechazado: 'Rechazado', anulado: 'Anulado' };
const MOTIVOS = {
  monto_distinto: 'Monto distinto al del pedido',
  pago_duplicado: 'Pago repetido',
  pedido_cerrado: 'Pagado con el pedido ya cerrado',
  anulado_pedido_cerrado: 'Anulación con el pedido ya cerrado',
};
// Si el cron corre cada 10 min, más de 30 sin noticias es una falla que el dueño debe ver.
const MINUTOS_SIN_NOTICIAS = 30;

export function crearVistaPagos(ctx) {
  const el = h('section', { class: 'vista vista-pagos', 'data-vista': 'pagos' });
  let datos = null;

  async function refrescar() {
    try {
      datos = await ctx.api.pagosBold();
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar los pagos.' : e.message, 'error');
      return;
    }
    ctx.marcarConteo('pagos', (datos.devoluciones || []).length);
    pintar();
  }

  async function resolver(d) {
    const nota = await pedirTexto({ titulo: 'Marcar devolución como resuelta', etiqueta: '¿Qué hiciste? (por ejemplo: devolución hecha en Bold)', boton: 'Marcar resuelta' });
    if (!nota) return;
    try { await ctx.api.resolverAlerta(d.alerta_id, nota); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    ctx.avisar('Devolución marcada como resuelta.', 'ok');
    await ctx.refrescarTodo();
  }

  const cuando = (iso) => (iso ? fechaCorta(iso, ctx.ahora()) + ' ' + horaBogota(iso) : '—');

  function estadoConciliacion() {
    const c = datos.ultima_conciliacion;
    if (!c) {
      return h('div', { class: 'aviso', 'data-campo': 'conciliacion', 'data-estado': 'sin-corridas' },
        h('strong', null, 'La conciliación automática no ha corrido nunca. '),
        'Si un cliente paga y cierra Bold sin volver a la tienda, su pedido solo se confirma por el webhook. Programa bold-conciliar (ver DECISIONES.md).');
    }
    const minutos = Math.max(0, Math.round((ctx.ahora().getTime() - new Date(c.corrida_en).getTime()) / 60000));
    const viva = minutos <= MINUTOS_SIN_NOTICIAS;
    return h('p', { class: viva ? 'pequeno' : 'aviso', 'data-campo': 'conciliacion', 'data-estado': viva ? 'viva' : 'detenida' },
      (viva ? 'Conciliación automática al día: ' : 'La conciliación automática lleva rato sin correr: ') +
      'última revisión hace ' + minutos + ' min (' + c.revisados + (c.revisados === 1 ? ' pago revisado' : ' pagos revisados') + ').');
  }

  function pintar() {
    vaciar(el);
    if (!datos) { el.append(h('p', { class: 'vacio' }, 'Cargando los pagos…')); return; }
    const dev = datos.devoluciones || [];
    const pen = datos.pendientes || [];
    const rec = datos.recientes || [];
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Pagos Bold'),
        h('span', { class: 'pastilla ' + (datos.activo ? 'en-linea' : 'sin-conexion'), 'data-campo': 'estado-bold' }, datos.activo ? 'Pago en línea encendido' : 'Pago en línea apagado'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-pagos', onclick: refrescar }, 'Actualizar')),
      estadoConciliacion(),
      h('h3', null, 'Devoluciones por resolver (' + dev.length + ')'),
      dev.length
        ? h('table', { class: 'tabla', 'data-tabla': 'devoluciones' },
            h('thead', null, h('tr', null, h('th', null, 'Pedido'), h('th', null, 'Motivo'), h('th', null, 'Cliente'), h('th', { class: 'num' }, 'Monto'), h('th', null, 'Referencia'), h('th', null, ''))),
            h('tbody', null, dev.map((d) =>
              h('tr', { 'data-alerta': d.alerta_id },
                h('td', { class: 'mono' }, d.pedido ? '#' + d.pedido : '—'),
                h('td', null, MOTIVOS[d.motivo] || 'Revisar en Bold'),
                h('td', null, h('strong', null, d.cliente || '—'), h('br'), h('span', { class: 'pequeno' }, d.correo || '')),
                h('td', { class: 'num mono' }, d.monto_cop ? fmtCop(d.monto_cop) : '—'),
                h('td', { class: 'mono pequeno' }, d.order_id || '—'),
                h('td', null, h('button', { type: 'button', class: 'btn', 'data-accion': 'resolver-devolucion', onclick: () => resolver(d) }, 'Marcar resuelta'))))))
        : h('p', { class: 'vacio', 'data-campo': 'sin-devoluciones' }, 'No hay devoluciones pendientes.'),
      h('p', { class: 'pequeno' }, 'La devolución se hace en el panel de Bold; aquí solo queda la constancia de que la hiciste.'),
      h('h3', null, 'Pagos pendientes (' + pen.length + ')'),
      pen.length
        ? h('table', { class: 'tabla', 'data-tabla': 'pendientes' },
            h('tbody', null, pen.map((p) =>
              h('tr', { 'data-orden': p.order_id }, h('td', { class: 'mono' }, '#' + p.pedido), h('td', null, p.cliente || '—'), h('td', { class: 'num mono' }, fmtCop(p.monto_cop)), h('td', null, cuando(p.creado_en))))))
        : h('p', { class: 'vacio', 'data-campo': 'sin-pendientes' }, 'No hay pagos pendientes.'),
      h('h3', null, 'Pagos recientes'),
      rec.length
        ? h('table', { class: 'tabla', 'data-tabla': 'recientes' },
            h('tbody', null, rec.map((p) =>
              h('tr', { 'data-orden': p.order_id }, h('td', { class: 'mono' }, '#' + p.pedido), h('td', null, ESTADOS[p.estado] || p.estado), h('td', { class: 'num mono' }, fmtCop(p.monto_cop)), h('td', null, cuando(p.confirmado_en || p.creado_en))))))
        : h('p', { class: 'vacio' }, 'Todavía no hay pagos en línea.'));
  }

  pintar();
  return { el, refrescar };
}
