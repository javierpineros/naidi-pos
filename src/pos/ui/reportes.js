// Reportes del dueño: ventas por sabor, tamaño y hora; canjes y costo de premios.
import { h, vaciar } from '../../lib/dom.js';
import { fmtCop, hoyBogota } from '../../lib/format.js';

function tabla(titulo, columnas, filas, id) {
  return h('div', { class: 'reporte' }, h('h3', null, titulo),
    h('table', { class: 'tabla', 'data-tabla': id },
      h('thead', null, h('tr', null, columnas.map((c) => h('th', { class: c.num ? 'num' : null }, c.titulo)))),
      h('tbody', null, filas.length
        ? filas.map((f) => h('tr', null, columnas.map((c) => h('td', { class: c.num ? 'num mono' : null }, c.valor(f)))))
        : h('tr', null, h('td', { colspan: String(columnas.length) }, 'Sin datos en este rango.')))));
}

export function crearVistaReportes(ctx) {
  const el = h('section', { class: 'vista vista-reportes', 'data-vista': 'reportes' });
  const hoy = hoyBogota(ctx.ahora());
  let desde = hoy;
  let hasta = hoy;
  let datos = null;

  async function ver() {
    try {
      const [ventas, canjes] = await Promise.all([ctx.api.reporteVentas(desde, hasta), ctx.api.reporteCanjes(desde, hasta)]);
      datos = { ventas, canjes };
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar los reportes.' : e.message, 'error');
      return;
    }
    pintar();
  }

  function pintar() {
    vaciar(el);
    const d = h('input', { type: 'date', value: desde, 'data-campo': 'desde', 'aria-label': 'Desde' });
    const hh = h('input', { type: 'date', value: hasta, 'data-campo': 'hasta', 'aria-label': 'Hasta' });
    d.addEventListener('change', () => { desde = d.value; });
    hh.addEventListener('change', () => { hasta = hh.value; });
    el.append(h('div', { class: 'barra-vista' }, h('h2', null, 'Reportes'), h('label', null, 'Desde', d), h('label', null, 'Hasta', hh),
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'ver-reportes', onclick: ver }, 'Ver')));
    if (!datos) { el.append(h('p', { class: 'vacio' }, 'Elige el rango y toca Ver.')); return; }
    const v = datos.ventas;
    const c = datos.canjes;
    el.append(
      h('p', { 'data-campo': 'resumen' }, v.totales.ventas + ' ventas · ' + fmtCop(v.totales.total_cop) + ' · ticket promedio ' + fmtCop(v.totales.ticket_promedio_cop)),
      tabla('Por sabor', [{ titulo: 'Sabor', valor: (f) => f.sabor }, { titulo: 'Unidades', num: true, valor: (f) => String(f.unidades) }, { titulo: 'Ingresos', num: true, valor: (f) => fmtCop(f.ingresos_cop) }], v.por_sabor, 'por-sabor'),
      tabla('Por tamaño', [{ titulo: 'Tamaño', valor: (f) => f.tamano }, { titulo: 'Unidades', num: true, valor: (f) => String(f.unidades) }, { titulo: 'Ingresos', num: true, valor: (f) => fmtCop(f.ingresos_cop) }], v.por_tamano, 'por-tamano'),
      tabla('Por hora (Bogotá)', [{ titulo: 'Hora', valor: (f) => String(f.hora).padStart(2, '0') + ':00' }, { titulo: 'Ventas', num: true, valor: (f) => String(f.ventas) }, { titulo: 'Total', num: true, valor: (f) => fmtCop(f.total_cop) }], v.por_hora, 'por-hora'),
      h('div', { class: 'reporte' }, h('h3', null, 'Canjes y costo de premios'),
        h('p', { 'data-campo': 'canjes' }, c.canjes.cantidad + ' canjes · ' + c.canjes.puntos + ' puntos canjeados · ' + c.puntos_acreditados + ' puntos acreditados'),
        h('p', { 'data-campo': 'costo' }, 'Costo de premios: ' + fmtCop(c.costo_total_cop) + ' (' + c.costo_sobre_ventas_pct + '% de las ventas)')),
      tabla('Costo por tipo de premio', [{ titulo: 'Tipo', valor: (f) => (f.tipo === 'bienvenida' ? 'Regalo de bienvenida' : 'Premio canjeado') + ' · ' + f.modalidad }, { titulo: 'Usos', num: true, valor: (f) => String(f.usos) }, { titulo: 'Costo', num: true, valor: (f) => fmtCop(f.costo_cop) }], c.costo_premios, 'costo-premios')
    );
  }

  pintar();
  return { el, refrescar: () => {} };
}
