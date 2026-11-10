// Caja del día: cierre separado por medio de pago, ventas del día (el dueño anula con PIN) y alertas para el dueño.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fmtCop, horaBogota, MEDIOS } from '../../lib/format.js';
import { pedirTexto, pedirPin, confirmar } from './modal.js';

const ESTADOS = { confirmada: 'Por pagar', pagada: 'Pagada', anulada: 'Anulada' };

export function mensajePin(r) {
  if (r.error === 'pin_bloqueado') return 'El PIN está bloqueado por varios intentos fallidos. Inténtalo más tarde.';
  if (r.error === 'sin_pin') return 'Aún no tienes un PIN configurado.';
  return 'PIN incorrecto.' + (r.intentos_restantes !== undefined ? ' Te quedan ' + r.intentos_restantes + ' intentos.' : '');
}

export function crearVistaCaja(ctx) {
  const el = h('section', { class: 'vista vista-caja', 'data-vista': 'caja' });
  let cierre = null;
  let ventas = [];
  let alertas = [];

  async function refrescar() {
    try {
      cierre = await ctx.api.cierreDeCaja();
      ventas = (await ctx.api.ventasDelDia()) || [];
      alertas = ctx.esDueno() ? (await ctx.api.listaAlertas()) || [] : [];
      ctx.marcarConexion(true);
    } catch (e) {
      if (e.name === 'ErrorRed') ctx.marcarConexion(false);
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar la caja.' : e.message, 'error');
      return;
    }
    pintar();
  }

  async function cerrar() {
    const sin = cierre.sin_pagar.length;
    const ok = await confirmar({
      titulo: 'Cerrar la caja de hoy',
      mensaje: sin ? 'Hay ' + sin + ' venta(s) confirmada(s) sin pagar; se marcarán para el dueño. ¿Cerrar la caja?' : '¿Cerrar la caja de hoy?',
      boton: 'Cerrar caja',
    });
    if (!ok) return;
    try {
      const r = await ctx.api.cerrarCaja();
      ctx.avisar(r.ya_estaba_cerrada ? 'La caja ya estaba cerrada.' : 'Caja cerrada.' + (r.alertas_creadas ? ' Se marcaron ' + r.alertas_creadas + ' venta(s) sin pagar para el dueño.' : ''), 'ok');
    } catch (e) { ctx.avisar(e.message, 'error'); }
    await refrescar();
  }

  async function anular(v) {
    const motivo = await pedirTexto({ titulo: 'Anular venta #' + v.numero, etiqueta: 'Motivo de la anulación', boton: 'Continuar' });
    if (!motivo) return;
    const pin = await pedirPin('Confirma la anulación con tu PIN');
    if (!pin) return;
    try {
      const r = await ctx.api.anularVenta(v.id, motivo, pin);
      if (r.ok === false) ctx.avisar(mensajePin(r), 'error');
      else ctx.avisar('Venta anulada.' + (r.puntos_revertidos ? ' Se revirtieron ' + r.puntos_revertidos + ' puntos.' : ''), 'ok');
    } catch (e) { ctx.avisar(e.message, 'error'); }
    await refrescar();
  }

  async function resolver(a) {
    const nota = await pedirTexto({ titulo: 'Resolver alerta', etiqueta: '¿Qué pasó con esto?', boton: 'Resolver' });
    if (!nota) return;
    try { await ctx.api.resolverAlerta(a.id, nota); } catch (e) { ctx.avisar(e.message, 'error'); }
    await refrescar();
  }

  function pintar() {
    vaciar(el);
    if (!cierre) { el.append(h('p', { class: 'vacio' }, 'Cargando la caja…')); return; }
    const dueno = ctx.esDueno();
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Caja de hoy' + (cierre.cerrado ? ' · cerrada' : '')),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-caja', onclick: refrescar }, 'Actualizar'),
        cierre.cerrado ? null : h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'cerrar-caja', onclick: cerrar }, 'Cerrar caja')),
      h('table', { class: 'tabla', 'data-tabla': 'por-medio' },
        h('thead', null, h('tr', null, h('th', null, 'Medio de pago'), h('th', { class: 'num' }, 'Ventas'), h('th', { class: 'num' }, 'Total'))),
        h('tbody', null, cierre.por_medio.length
          ? cierre.por_medio.map((m) => h('tr', { 'data-medio': m.medio }, h('td', null, MEDIOS[m.medio] || m.medio), h('td', { class: 'num mono' }, String(m.ventas)), h('td', { class: 'num mono' }, fmtCop(m.total_cop))))
          : h('tr', null, h('td', { colspan: '3' }, 'Todavía no hay ventas cobradas hoy.'))),
        h('tfoot', null, h('tr', null, h('th', null, 'Total del día'), h('th', { class: 'num mono' }, String(cierre.ventas)), h('th', { class: 'num mono', 'data-campo': 'total-dia' }, fmtCop(cierre.total_cop))))),
      h('p', { class: 'pequeno' }, 'Anuladas: ' + cierre.anuladas.ventas + ' (' + fmtCop(cierre.anuladas.total_cop) + ', no suman al total) · Canceladas: ' + cierre.canceladas),
      cierre.sin_pagar.length
        ? h('div', { class: 'aviso', 'data-campo': 'sin-pagar' }, h('strong', null, 'Confirmadas sin pagar'),
            cierre.sin_pagar.map((s) => h('p', null, '#' + s.numero + ' · ' + fmtCop(s.total_cop) + (s.cliente ? ' · ' + s.cliente : '') + ' · ' + horaBogota(s.confirmada_en))))
        : null,
      h('h3', null, 'Ventas del día'),
      h('table', { class: 'tabla', 'data-tabla': 'ventas' },
        h('tbody', null, ventas.map((v) =>
          h('tr', { 'data-venta': v.id },
            h('td', { class: 'mono' }, '#' + v.numero), h('td', null, horaBogota(v.pagada_en || v.confirmada_en)), h('td', null, v.cliente || (v.canal === 'rappi' ? 'Rappi' : '—')),
            h('td', null, v.medio_pago ? MEDIOS[v.medio_pago] : '—'), h('td', { class: 'num mono' }, fmtCop(v.total_cop)), h('td', null, ESTADOS[v.estado] || v.estado),
            h('td', null,
              v.estado === 'confirmada' ? h('button', { type: 'button', class: 'btn', 'data-accion': 'abrir-venta', onclick: () => ctx.vista('venta').reanudar(v.id) }, 'Abrir') : null,
              dueno && v.estado === 'pagada' ? h('button', { type: 'button', class: 'btn', 'data-accion': 'anular-venta', onclick: () => anular(v) }, 'Anular') : null))))),
      dueno && alertas.length
        ? h('div', { class: 'aviso', 'data-campo': 'alertas' }, h('strong', null, 'Alertas para el dueño'),
            alertas.map((a) => h('p', { 'data-alerta': a.id },
              (a.tipo === 'venta_sin_pagar' ? 'Venta #' + (a.detalle.numero || '') + ' sin pagar al cierre · ' + fmtCop(a.detalle.total_cop) : a.tipo) + ' ',
              h('button', { type: 'button', class: 'btn', 'data-accion': 'resolver-alerta', onclick: () => resolver(a) }, 'Resolver'))))
        : null
    );
  }

  pintar();
  return { el, refrescar };
}
