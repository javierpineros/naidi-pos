// Auditoría: lo último que se hizo con permisos sensibles (reglas, banderas, anulaciones, pantallas, PIN...). Solo lectura.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fechaCorta, horaBogota } from '../../lib/format.js';

const ACCIONES = {
  cambiar_regla: 'Cambió una regla',
  cambiar_bandera: 'Cambió una bandera',
  rotar_token_entrada: 'Cambió el QR de entrada',
  anular_venta: 'Anuló una venta',
  reabrir_venta: 'Reabrió una venta',
  mostrar_en_ipad: 'Reenvió una venta al iPad',
  reclamar_qr_posventa: 'Reclamó puntos con el QR',
  reclamar_puntos_venta: 'Reclamó puntos de una compra',
  restablecer_pin: 'Restableció su PIN',
  restablecer_pin_rechazado: 'Intento rechazado de restablecer el PIN',
  emitir_llave_dispositivo: 'Emitió una pantalla',
  revocar_dispositivo: 'Revocó una pantalla',
  aplicar_voucher: 'Aplicó un premio',
};

function resumen(detalle) {
  if (!detalle || typeof detalle !== 'object') return '';
  const t = JSON.stringify(detalle);
  return t === '{}' ? '' : (t.length > 140 ? t.slice(0, 137) + '…' : t);
}

export function crearVistaAuditoria(ctx) {
  const el = h('section', { class: 'vista vista-auditoria', 'data-vista': 'auditoria' });
  let filas = [];
  let cargado = false;
  let filtro = '';

  async function refrescar() {
    try {
      filas = (await ctx.api.auditoria(200)) || [];
      cargado = true;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar la auditoría.' : e.message, 'error');
      return;
    }
    pintar();
  }

  function pintar() {
    const busca = filtro.trim().toLowerCase();
    const texto = (f) => [f.accion, ACCIONES[f.accion] || '', f.entidad, f.entidad_id || '', f.actor || '', resumen(f.detalle)].join(' ').toLowerCase();
    const visibles = filas.filter((f) => !busca || texto(f).indexOf(busca) >= 0);
    const buscador = h('input', { type: 'search', value: filtro, placeholder: 'Buscar (acción, quién, venta…)', 'data-campo': 'buscar-auditoria', 'aria-label': 'Buscar en la auditoría' });
    buscador.addEventListener('input', () => { filtro = buscador.value; pintar(); const n = el.querySelector('[data-campo="buscar-auditoria"]'); if (n) { n.focus(); n.setSelectionRange(filtro.length, filtro.length); } });
    vaciar(el);
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Auditoría'), buscador,
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-auditoria', onclick: refrescar }, 'Actualizar')),
      h('p', { class: 'pequeno' }, 'Los últimos 200 movimientos. No se pueden editar ni borrar.'),
      !cargado ? h('p', { class: 'vacio' }, 'Cargando la auditoría…')
        : visibles.length
          ? h('table', { class: 'tabla', 'data-tabla': 'auditoria' },
              h('thead', null, h('tr', null, h('th', null, 'Cuándo'), h('th', null, 'Quién'), h('th', null, 'Qué'), h('th', null, 'Detalle'))),
              h('tbody', null, visibles.map((f) =>
                h('tr', { 'data-auditoria': f.id },
                  h('td', { class: 'pequeno' }, fechaCorta(f.en, ctx.ahora()) + ' ' + horaBogota(f.en)),
                  h('td', null, f.actor || 'Sistema'),
                  h('td', null, h('strong', null, ACCIONES[f.accion] || f.accion), h('div', { class: 'pequeno mono' }, f.entidad + (f.entidad_id ? ' · ' + f.entidad_id : ''))),
                  h('td', { class: 'pequeno mono' }, resumen(f.detalle))))))
          : h('p', { class: 'vacio', 'data-campo': 'sin-auditoria' }, 'No hay movimientos que coincidan.'));
  }

  pintar();
  return { el, refrescar };
}
