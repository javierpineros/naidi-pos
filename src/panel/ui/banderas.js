// Banderas: encienden o apagan funciones (tienda web, pago en línea...). Cambiar una pide el PIN y queda en la auditoría.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fechaCorta, horaBogota } from '../../lib/format.js';
import { pedirPin, confirmar } from '../../pos/ui/modal.js';
import { mensajePin } from '../../pos/ui/caja.js';

// Las que afectan a clientes y dinero hoy piden una confirmación extra antes del PIN.
const SENSIBLES = {
  pago_en_linea_bold: 'Apagarla impide que los clientes paguen en línea (QR del iPad y tienda web).',
  pedidos_web: 'Apagarla cierra la tienda web: los clientes ya no pueden hacer pedidos para recoger.',
};

export function crearVistaBanderas(ctx) {
  const el = h('section', { class: 'vista vista-banderas', 'data-vista': 'banderas' });
  let lista = [];
  let cargado = false;

  async function refrescar() {
    try {
      lista = (await ctx.api.listarBanderas()) || [];
      cargado = true;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar las banderas.' : e.message, 'error');
      return;
    }
    pintar();
  }

  async function cambiar(b) {
    const nueva = !b.activa;
    if (SENSIBLES[b.clave] && !nueva) {
      const ok = await confirmar({ titulo: 'Apagar ' + b.clave, mensaje: SENSIBLES[b.clave] + ' ¿Seguimos?', boton: 'Apagar' });
      if (!ok) return;
    }
    const pin = await pedirPin('Confirma con tu PIN: ' + (nueva ? 'encender ' : 'apagar ') + b.clave);
    if (!pin) return;
    let r;
    try { r = await ctx.api.cambiarBandera(b.clave, nueva, b.desde || null, b.hasta || null, pin); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    if (r && r.ok === false) { ctx.avisar(mensajePin(r), 'error'); return; }
    ctx.avisar('Bandera ' + b.clave + (nueva ? ' encendida.' : ' apagada.'), 'ok');
    await refrescar();
  }

  function pintar() {
    const cuando = (iso) => fechaCorta(iso, ctx.ahora()) + ' ' + horaBogota(iso);
    vaciar(el);
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Banderas'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-banderas', onclick: refrescar }, 'Actualizar')),
      h('p', { class: 'pequeno' }, 'Cada bandera enciende o apaga una función. Las de "Fase 2/3" son ideas futuras: déjalas apagadas.'),
      !cargado ? h('p', { class: 'vacio' }, 'Cargando las banderas…')
        : h('table', { class: 'tabla', 'data-tabla': 'banderas' },
            h('thead', null, h('tr', null, h('th', null, 'Bandera'), h('th', null, 'Estado'), h('th', null, 'Ventana'), h('th', null, ''))),
            h('tbody', null, lista.map((b) =>
              h('tr', { 'data-bandera': b.clave },
                h('td', null, h('strong', { class: 'mono' }, b.clave), b.descripcion ? h('div', { class: 'pequeno' }, b.descripcion) : null),
                h('td', { 'data-campo': 'estado', 'data-activa': b.activa ? '1' : '0' }, b.activa ? 'Encendida' : 'Apagada'),
                h('td', { class: 'pequeno' }, (b.desde ? 'desde ' + cuando(b.desde) : '') + (b.hasta ? ' hasta ' + cuando(b.hasta) : '') || '—'),
                h('td', null, h('button', { type: 'button', class: 'btn' + (b.activa ? '' : ' btn-primario'), 'data-accion': 'cambiar-bandera', onclick: () => cambiar(b) }, b.activa ? 'Apagar' : 'Encender')))))));
  }

  pintar();
  return { el, refrescar };
}
