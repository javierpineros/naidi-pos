import { h, vaciar } from '../lib/dom.js';
import { fmtCop } from '../lib/format.js';

// Pago de una compra del POS desde el QR del iPad. El código llega en el # (QR) o en ?c= (al volver de Bold).
// Esta página solo muestra el botón de Bold con los datos que firmó el servidor; quien confirma el pago es el servidor
// cuando Bold se lo dice, y aquí solo se pregunta cómo quedó la compra.

const FORMA_CODIGO = /^[0-9a-f]{32}$/;

export function crearPagar(o) {
  const raiz = o.raiz;
  const api = o.api;
  const leerHash = o.leerHash || (() => window.location.hash);
  const leerBusqueda = o.leerBusqueda || (() => window.location.search);
  const programar = o.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
  const cada = o.intervaloMs || 4000;
  const maxVerificaciones = o.maxVerificaciones || 45;   // unos 3 minutos a 4 s

  let codigo = '';
  let boton = null;          // nodo del botón de Bold: se conserva entre repintados para no reiniciarlo
  let detenida = false;
  let consultas = 0;
  let firma = '';

  function leerCodigo() {
    const hash = String(leerHash() || '').replace(/^#/, '').trim().toLowerCase();
    if (FORMA_CODIGO.test(hash)) return hash;
    const m = /[?&]c=([0-9a-fA-F]{32})(?:&|$)/.exec(String(leerBusqueda() || ''));
    return m ? m[1].toLowerCase() : '';
  }
  // Bold devuelve a la persona con ?bold-order-id=...&bold-tx-status=...; si el pago se rechazó o se canceló no hay nada que esperar.
  const vuelveDeBold = () => {
    const b = String(leerBusqueda() || '');
    return /[?&]bold-order-id=/.test(b) && !/[?&]bold-tx-status=(rejected|failed|cancelled|canceled|void)/i.test(b);
  };

  function marco(...hijos) {
    return h('main', { class: 'pagar' }, h('div', { class: 'marca' }, 'Naidí'), ...hijos);
  }
  // El nodo se arma solo si la vista cambió: armarlo antes sacaría el botón de Bold de la página sin volver a ponerlo.
  function pintar(clave, fabricar) {
    if (clave === firma) return;
    firma = clave;
    vaciar(raiz).append(fabricar());
  }
  const mensaje = (clave, titulo, texto, extra) => pintar(clave, () => marco(h('h1', {}, titulo), texto ? h('p', {}, texto) : null, extra || null));

  function ponerBoton(d) {
    const contenedor = h('div', { class: 'boton-bold', 'data-campo': 'boton-bold' });
    const s = document.createElement('script');
    s.setAttribute('data-bold-button', 'light-L');
    s.setAttribute('data-api-key', d.apiKey);
    s.setAttribute('data-order-id', d.orderId);
    s.setAttribute('data-currency', d.currency);
    s.setAttribute('data-amount', String(d.amount));
    s.setAttribute('data-integrity-signature', d.integritySignature);
    if (d.redirectionUrl) s.setAttribute('data-redirection-url', d.redirectionUrl);
    s.src = 'https://checkout.bold.co/library/boldPaymentButton.js';
    contenedor.append(s);
    return contenedor;
  }

  // Bold devolvió a la persona con el pago rechazado o cancelado: se le dice, en vez de mostrar la misma pantalla de antes de pagar.
  const retornoFallido = () => {
    const b = String(leerBusqueda() || '');
    return /[?&]bold-order-id=/.test(b) && /[?&]bold-tx-status=(rejected|failed|cancelled|canceled|void)/i.test(b);
  };

  const etiquetaPedido = (numero) => (numero ? h('p', { class: 'pedido-numero', 'data-campo': 'numero' }, 'Pedido #' + numero) : null);

  function vistaAbierta(total, numero) {
    const fallido = retornoFallido();
    pintar('abierta|' + total + '|' + fallido + '|' + numero, () => marco(
      fallido ? h('p', { class: 'aviso-pago', role: 'alert', 'data-campo': 'pago-no-aprobado' }, 'Tu pago no fue aprobado, así que no se te cobró nada. Puedes intentarlo de nuevo o pagar con el vendedor.') : null,
      h('h1', {}, 'Paga tu compra'),
      etiquetaPedido(numero),
      h('div', { class: 'total-rotulo' }, 'Total a pagar'),
      h('div', { class: 'total', 'data-campo': 'total' }, fmtCop(total)),
      boton,
      h('p', { class: 'pequeno' }, 'Pagas con tarjeta, PSE, Nequi o Bancolombia. Cuando termines, esta pantalla se actualiza sola.')));
  }

  function vistaPagada(r) {
    const total = r.total_cop;
    pintar('pagada|' + (r.puntos_reclamables ? 'p' : ''), () => marco(
      h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
      h('h1', {}, '¡Pago recibido! Gracias'),
      etiquetaPedido(r.numero),
      total ? h('p', { class: 'total', 'data-campo': 'total' }, fmtCop(total)) : null,
      h('p', {}, 'Ya puedes mostrarle al vendedor que tu compra quedó pagada.'),
      // Compra sin cuenta: se puede sumar a su cuenta ahora, mientras dura el plazo (el mismo del QR que entrega el vendedor).
      r.puntos_reclamables ? h('div', { class: 'puntos', 'data-zona': 'reclamar-puntos' },
        h('p', null, '¿Quieres los puntos de esta compra? Entra o crea tu cuenta y quedan sumados. Solo se puede por unos minutos.'),
        h('a', { class: 'btn', href: '/cuenta/#venta=' + codigo, 'data-accion': 'reclamar-puntos' }, 'Reclamar mis puntos')) : null,
      // Qué hacer después de pagar: son enlaces a las otras páginas del sitio (misma dirección que esta).
      h('div', { class: 'siguientes', 'data-zona': 'siguientes' },
        h('a', { class: 'btn', href: '/tienda/', 'data-accion': 'ir-al-menu' }, 'Ver el menú'),
        h('a', { class: 'btn btn-claro', href: '/cuenta/', 'data-accion': 'ir-a-mi-cuenta' }, 'Mi cuenta y mis puntos')),
      h('p', { class: 'pequeno' }, 'Con tu cuenta ves tus puntos y haces tus próximos pedidos para recoger sin filas.')));
  }

  function reintentar(clave, titulo, texto) {
    mensaje(clave, titulo, texto, h('button', { type: 'button', class: 'btn', 'data-accion': 'reintentar', onclick: () => { consultas = 0; detenida = false; revisar(); } }, 'Revisar de nuevo'));
  }

  // Una consulta al servidor y, según cómo quedó la compra, qué mostrar y si se sigue preguntando.
  async function revisar() {
    if (detenida) return;
    consultas++;
    let r;
    try {
      r = await api.estado(codigo);
    } catch (e) {
      if (consultas < maxVerificaciones) { programar(revisar, cada); return; }
      reintentar('red', 'No pudimos revisar tu pago', 'Revisa tu conexión. Si ya pagaste, no pagues de nuevo: toca "Revisar de nuevo".');
      return;
    }
    if (r.estado === 'pagada') { detenida = true; vistaPagada(r); return; }
    if (r.estado === 'invalido') { detenida = true; mensaje('invalido', 'Este código de pago no es válido', 'Pídele al vendedor que te muestre el código otra vez en la pantalla.'); return; }
    if (r.estado === 'cerrada') { detenida = true; mensaje('cerrada', 'Esta compra ya no está abierta', 'Habla con el vendedor para saber cómo seguir.'); return; }
    if (r.estado === 'actualizando') {
      boton = null;
      if (consultas < maxVerificaciones) {
        mensaje('actualizando', 'Estamos actualizando tu pedido', 'El vendedor lo está modificando. Cuando lo confirme, esta pantalla sigue sola.');
        programar(revisar, cada);
      } else {
        reintentar('act-fin', 'Seguimos actualizando tu pedido', 'Cuando el vendedor lo confirme, toca "Revisar de nuevo".');
      }
      return;
    }
    // Abierta. Si acaba de volver de Bold se espera un poco a que el pago se confirme; si no, se muestra el botón.
    if (vuelveDeBold() && !boton) {
      if (consultas < maxVerificaciones) {
        mensaje('confirmando', 'Estamos confirmando tu pago…', 'Puede tardar unos segundos. No cierres esta página.');
        programar(revisar, cada);
      } else {
        reintentar('conf-fin', 'Todavía no vemos tu pago', 'Si ya pagaste, espera un momento y toca "Revisar de nuevo". Si no, puedes intentar otra vez.');
      }
      return;
    }
    if (!boton) {
      try {
        boton = ponerBoton(await api.iniciarPago(codigo));
      } catch (e) {
        if (e && e.name === 'ErrorServidor') { detenida = true; mensaje('error-pago', 'No pudimos iniciar el pago', e.message); return; }
        programar(revisar, cada);
        return;
      }
    }
    vistaAbierta(r.total_cop, r.numero);
    if (consultas < maxVerificaciones) programar(revisar, cada);
  }

  function iniciar() {
    codigo = leerCodigo();
    if (!codigo) { detenida = true; mensaje('sin-codigo', 'Escanea el código del iPad', 'Este enlace no trae un código de pago válido.'); return; }
    mensaje('cargando', 'Un momento…', '');
    revisar();
  }

  return { iniciar, revisar };
}
