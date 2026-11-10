import { h, vaciar } from '../lib/dom.js';
import { fmtCop } from '../lib/format.js';

// Pantalla del cliente (iPad mini 2, Safari 12). Solo lee. Consulta el estado cada 2 o 3 segundos con la llave del dispositivo.
// Reglas de COMPATIBILIDAD_IPAD.md: sin ?. ni ??, sin gap/inset/aspect-ratio en el CSS, sin portapapeles ni ResizeObserver.

const FORMATO_LLAVE = /^nd_[0-9a-f]{64}$/;

const ETIQUETA_PAGO = {
  efectivo: 'Efectivo',
  datafono_bold: 'Datáfono Bold',
  transferencia: 'Transferencia',
  bold_online: 'Pago en línea',
};

export function crearPantalla(o) {
  const raiz = o.raiz;
  const api = o.api;
  const almacen = o.almacen;
  const origen = o.origen || (() => window.location.origin);
  const leerHash = o.leerHash || (() => window.location.hash);
  const limpiarHash = o.limpiarHash || (() => { try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* no pasa nada */ } });
  const qr = o.qr;
  const programar = o.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
  const cancelar = o.clearTimeout || function (t) { clearTimeout(t); };
  const intervaloMs = o.intervaloMs || 2500;
  const maxEsperaMs = o.maxEsperaMs || 10000;

  let llave = null;
  let reloj = null;
  let fallos = 0;
  let detenida = false;
  let firma = '';       // lo último que se pintó; si no cambia, no se vuelve a pintar (evita parpadeos)
  let consultando = false;

  // ---------- Llave del dispositivo ----------
  function leerLlaveGuardada() {
    try { return almacen.leer(); } catch (e) { return null; }
  }
  function guardarLlave(valor) {
    try { almacen.guardar(valor); } catch (e) { /* sin almacenamiento: la llave vive solo en esta sesión */ }
  }
  function borrarLlave() {
    try { almacen.borrar(); } catch (e) { /* ok */ }
  }

  // La llave llega una vez en el enlace de activación (#llave=...): se guarda y se quita de la barra de direcciones.
  function activarDesdeEnlace() {
    const hash = String(leerHash() || '');
    const m = /(?:^#|&)llave=([^&]*)/.exec(hash);
    if (!m) return null;
    limpiarHash();
    let valor = m[1];
    try { valor = decodeURIComponent(valor); } catch (e) { /* queda como vino */ }
    if (!FORMATO_LLAVE.test(valor)) return 'invalida';
    guardarLlave(valor);
    return valor;
  }

  // ---------- Vistas ----------
  function marco(clase, hijos) {
    return h('div', { class: 'pantalla est-' + clase },
      h('div', { class: 'cabecera' }, h('img', { class: 'logo', src: '/img/logo-nombre.png', alt: 'Naidí' })),
      h('div', { class: 'cuerpo' }, hijos));
  }

  function vistaMensaje(clase, titulo, texto) {
    return marco(clase, h('div', { class: 'mensaje' }, h('h1', {}, titulo), texto ? h('p', {}, texto) : null));
  }

  function vistaReposo(datos) {
    const url = String(origen()).replace(/\/+$/, '') + '/cuenta/#entrada=' + datos.entrada_token;
    return marco('reposo', h('div', { class: 'reposo' },
      h('div', { class: 'reposo-texto' },
        h('h1', {}, 'Bienvenido a Naidí'),
        h('p', {}, 'Escanea el código con la cámara de tu celular, regístrate y suma puntos con tu compra.')),
      h('div', { class: 'qr-caja', 'data-qr': url }, qr(url))));
  }

  function textoPago(datos) {
    const t = datos.transferencia || {};
    const valor = String(t.valor || '');
    return { valor, rotulo: t.tipo === 'bre-b' ? 'Llave Bre-B' : 'Celular' };
  }

  function lineaNode(l) {
    const nombre = l.nombre + (l.tamano ? ' ' + l.tamano : '');
    const tops = (l.toppings || []).join(', ');
    return h('li', { class: 'linea' },
      h('div', { class: 'linea-texto' },
        h('div', { class: 'linea-nombre' }, (l.cantidad > 1 ? l.cantidad + ' × ' : '') + nombre),
        tops ? h('div', { class: 'linea-detalle' }, tops) : null,
        l.descuento_cop > 0 ? h('div', { class: 'linea-detalle descuento' }, 'Descuento −' + fmtCop(l.descuento_cop)) : null),
      h('div', { class: 'linea-precio mono' }, fmtCop(l.total_cop)));
  }

  function vistaVenta(datos) {
    const v = datos.venta;
    const pago = textoPago(datos);
    const textoTotal = fmtCop(v.total_cop);
    const formas = (datos.formas_pago || []).map((f) => h('li', { class: 'forma' }, ETIQUETA_PAGO[f] || f));
    return marco('venta', h('div', { class: 'venta' },
      h('div', { class: 'venta-detalle' },
        h('h1', {}, 'Tu pedido'),
        (v.lineas || []).length > 6 ? h('p', { class: 'pista' }, (v.lineas || []).length + ' productos. Desliza para verlos todos.') : null,
        h('ul', { class: 'lineas' }, (v.lineas || []).map(lineaNode)),
        v.descuento_cop > 0 ? h('div', { class: 'ahorro' }, 'Descuento total −' + fmtCop(v.descuento_cop)) : null),
      h('div', { class: 'venta-pago' },
        h('div', { class: 'total-rotulo' }, 'Total a pagar'),
        h('div', { class: 'total mono' + (textoTotal.length > 9 ? ' largo' : '') }, textoTotal),
        h('div', { class: 'formas-rotulo' }, 'Puedes pagar con'),
        h('ul', { class: 'formas' }, formas),
        pago.valor ? h('div', { class: 'transferencia' }, h('span', {}, 'Transferencia a ' + pago.rotulo), h('strong', { class: 'mono' }, pago.valor)) : null)));
  }

  function vistaPagada(datos) {
    return marco('pagada', h('div', { class: 'mensaje' },
      h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
      h('h1', {}, '¡Pagado! Gracias'),
      h('p', { class: 'mono total-gracias' }, fmtCop(datos.venta.total_cop)),
      h('p', {}, 'Que disfrutes tu bowl.')));
  }

  function pintar(clave, nodo) {
    if (clave === firma) return;
    firma = clave;
    vaciar(raiz);
    raiz.append(nodo);
  }

  function pintarSinConexion(mostrar) {
    const previo = raiz.querySelector('.aviso-red');
    if (!mostrar) { if (previo) previo.remove(); return; }
    if (!previo) raiz.append(h('div', { class: 'aviso-red' }, 'Reconectando…'));
  }

  function pintarEstado(datos) {
    pintarSinConexion(false);
    const v = datos.venta;
    if (v && v.estado === 'pagada') {
      pintar('pagada|' + v.numero, vistaPagada(datos));
    } else if (v) {
      pintar('venta|' + JSON.stringify([v, datos.formas_pago, datos.transferencia]), vistaVenta(datos));
    } else {
      pintar('reposo|' + datos.entrada_token, vistaReposo(datos));
    }
  }

  // ---------- Consulta ----------
  function siguiente(ms) {
    if (detenida) return;
    if (reloj) cancelar(reloj);
    reloj = programar(consultar, ms);
  }

  function consultar() {
    if (detenida || consultando) return;
    consultando = true;
    let respuesta;
    try {
      respuesta = api.estado(llave);
    } catch (e) {
      respuesta = Promise.reject(e);
    }
    return respuesta.then(
      (datos) => {
        consultando = false;
        if (!datos || datos.ok !== true) {
          if (datos && datos.error === 'llave_invalida') {
            detenida = true;
            borrarLlave();
            pintar('desactivada', vistaMensaje('apagada', 'Esta pantalla está desactivada', 'Pide al dueño una llave nueva para volver a activarla.'));
            return;
          }
          fallos++;
          pintarSinConexion(fallos >= 3);
          siguiente(Math.min(intervaloMs * (1 + fallos), maxEsperaMs));
          return;
        }
        fallos = 0;
        pintarEstado(datos);
        siguiente(intervaloMs);
      },
      () => {
        consultando = false;
        fallos++;
        // Se conserva lo último que se pintó; solo se avisa si la falla se prolonga.
        pintarSinConexion(fallos >= 3);
        siguiente(Math.min(intervaloMs * (1 + fallos), maxEsperaMs));
      }
    );
  }

  // ---------- Arranque ----------
  function iniciar() {
    const desdeEnlace = activarDesdeEnlace();
    if (desdeEnlace === 'invalida') {
      detenida = true;
      pintar('enlace-invalido', vistaMensaje('apagada', 'El enlace de activación no es válido', 'Pide al dueño que genere una llave nueva.'));
      return;
    }
    llave = desdeEnlace || leerLlaveGuardada();
    if (!llave || !FORMATO_LLAVE.test(llave)) {
      detenida = true;
      pintar('sin-llave', vistaMensaje('apagada', 'Pantalla sin activar', 'Abre el enlace de activación que te dio el dueño en este iPad.'));
      return;
    }
    consultar();
  }

  // Al volver a encender la pantalla del iPad, se consulta de una vez.
  function alVolver() {
    if (!detenida && !document.hidden) { fallos = 0; siguiente(0); }
  }
  if (!o.sinEventos) document.addEventListener('visibilitychange', alVolver);

  function detener() { detenida = true; if (reloj) cancelar(reloj); }

  return { iniciar, detener, consultar, _alVolver: alVolver };
}
