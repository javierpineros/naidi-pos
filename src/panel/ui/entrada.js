// QR de entrada de la tienda: es el que escanea el cliente para anunciar su llegada (check-in). Se puede imprimir; si se filtra
// o se quiere cambiar, se rota (con PIN): el QR viejo deja de servir y el iPad toma el nuevo solo.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fechaCorta, horaBogota } from '../../lib/format.js';
import { qrSvg } from '../../lib/qr.js';
import { pedirPin, confirmar } from '../../pos/ui/modal.js';
import { mensajePin } from '../../pos/ui/caja.js';

export function crearVistaEntrada(ctx) {
  const el = h('section', { class: 'vista vista-entrada', 'data-vista': 'entrada' });
  let punto = null;
  let cargado = false;

  async function refrescar() {
    try {
      punto = await ctx.api.puntoDeVenta();
      cargado = true;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar el QR de entrada.' : e.message, 'error');
      return;
    }
    pintar();
  }

  async function rotar() {
    const ok = await confirmar({ titulo: 'Cambiar el QR de entrada', mensaje: 'El QR actual dejará de funcionar. Si lo tienes impreso, tendrás que imprimir el nuevo. El iPad se actualiza solo. ¿Seguimos?', boton: 'Cambiar QR' });
    if (!ok) return;
    const pin = await pedirPin('Confirma con tu PIN: cambiar el QR de entrada');
    if (!pin) return;
    let r;
    try { r = await ctx.api.rotarTokenEntrada(pin); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    if (r && r.ok === false) { ctx.avisar(mensajePin(r), 'error'); return; }
    ctx.avisar('QR de entrada cambiado. El anterior ya no sirve.', 'ok');
    await refrescar();
  }

  function pintar() {
    vaciar(el);
    const url = punto && punto.token ? String(ctx.origen()).replace(/\/+$/, '') + '/cuenta/#entrada=' + punto.token : '';
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'QR de entrada'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-entrada', onclick: refrescar }, 'Actualizar'),
        h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'rotar-entrada', onclick: rotar, disabled: !cargado }, 'Cambiar el QR')),
      h('p', { class: 'pequeno' }, 'Es el código que escanea el cliente al llegar para que el vendedor lo vea en la lista de espera. El iPad lo muestra en reposo.'),
      !cargado ? h('p', { class: 'vacio' }, 'Cargando…')
        : h('div', { class: 'tarjeta' },
            h('div', { 'data-campo': 'qr-entrada', 'data-url': url }, url ? qrSvg(url, 6) : null),
            h('p', { class: 'pequeno', 'data-campo': 'rotado' }, punto && punto.rotado_en ? 'Último cambio: ' + fechaCorta(punto.rotado_en, ctx.ahora()) + ' ' + horaBogota(punto.rotado_en) : 'Nunca se ha cambiado.')));
  }

  pintar();
  return { el, refrescar };
}
