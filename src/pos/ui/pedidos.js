// Bandeja de pedidos web (para recoger en tienda). Llegan en tiempo real con sonido y se consultan cada 25 s como respaldo.
// El vendedor los pasa a Preparando y Listo; al entregar, el cliente dice su código de 4 caracteres, el vendedor lo digita
// y registra el pago: ahí se crea la venta y se acreditan los puntos (todo en el servidor).
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fmtCop, horaBogota, MEDIOS, TAMANOS } from '../../lib/format.js';
import { modal, pedirTexto } from './modal.js';

const ESTADOS = { recibido: 'Recibido', preparando: 'Preparando', listo: 'Listo', entregado: 'Entregado', no_llego: 'No llegó', cancelado: 'Cancelado' };
const ABIERTOS = ['recibido', 'preparando', 'listo'];

function textoLinea(l) {
  const partes = [];
  if (l.tamano) partes.push(TAMANOS[l.tamano] || l.tamano);
  if (l.toppings && l.toppings.length) partes.push(l.toppings.map((t) => t.nombre).join(', '));
  return { nombre: (l.cantidad > 1 ? l.cantidad + ' × ' : '') + l.producto_nombre, detalle: partes.join(' · ') };
}

export function crearVistaPedidos(ctx) {
  const el = h('section', { class: 'vista vista-pedidos', 'data-vista': 'pedidos' });
  const lista = h('div', { class: 'pedidos-lista', 'aria-live': 'polite' });
  const vistos = new Set();
  let primera = true;
  let items = [];

  el.append(h('div', { class: 'barra-vista' }, h('h2', null, 'Pedidos web')), lista);

  function pagoTexto(p) {
    if (p.metodo_pago === 'en_linea') return p.pago_en_linea_estado === 'pagado' ? 'Pagado en línea' : 'Pago en línea pendiente';
    return 'Paga al recoger';
  }

  function boton(texto, clave, fn, primario) {
    return h('button', { type: 'button', class: 'btn' + (primario ? ' btn-primario' : ''), 'data-accion': clave, onclick: fn }, texto);
  }

  function listaLineas(p) {
    return h('ul', { class: 'lineas' }, p.lineas.map((l) => {
      const t = textoLinea(l);
      return h('li', null, h('strong', null, t.nombre), t.detalle ? h('small', null, t.detalle) : null);
    }));
  }

  function tarjeta(p) {
    const abierto = ABIERTOS.includes(p.estado);
    const vencida = abierto && ctx.ahora() >= new Date(p.ventana_fin);
    const acciones = [];
    if (p.estado === 'recibido') acciones.push(boton('Preparando', 'preparando', () => cambiar(p, 'preparando')));
    if (p.estado === 'recibido' || p.estado === 'preparando') acciones.push(boton('Listo', 'listo', () => cambiar(p, 'listo')));
    if (abierto) acciones.push(boton('Entregar', 'entregar', () => entregar(p), true));
    if (vencida) acciones.push(boton('No llegó', 'no-llego', () => noLlego(p)));
    if (abierto && p.pago_en_linea_estado !== 'pagado') acciones.push(boton('Cancelar', 'cancelar', () => cancelar(p)));
    return h('article', { class: 'pedido-item estado-' + p.estado + (p.en_camino_en && abierto ? ' en-camino' : ''), 'data-pedido': p.id, 'data-numero': p.numero },
      h('header', null,
        h('strong', null, '#' + p.numero + ' · ' + p.nombre_pila + (p.inicial ? ' ' + p.inicial + '.' : '')),
        h('span', { class: 'marca estado', 'data-campo': 'estado' }, ESTADOS[p.estado] || p.estado),
        p.en_camino_en && abierto ? h('span', { class: 'marca camino', 'data-campo': 'en-camino' }, 'Va en camino') : null),
      h('p', { class: 'ventana' }, 'Recoge entre las ' + horaBogota(p.ventana_inicio) + ' y las ' + horaBogota(p.ventana_fin) + (vencida ? ' · ventana vencida' : '')),
      listaLineas(p),
      p.cortesia_toppings && p.cortesia_toppings.length
        ? h('p', { class: 'cortesia', 'data-campo': 'cortesia' }, 'Cortesía sin costo: ' + p.cortesia_toppings.map((t) => t.nombre).join(', ')) : null,
      p.nota ? h('p', { class: 'nota' }, 'Nota: ' + p.nota) : null,
      h('p', { class: 'total' }, h('span', { class: 'mono' }, fmtCop(p.total_cop)), ' · ', pagoTexto(p)),
      acciones.length ? h('div', { class: 'acciones' }, acciones) : null);
  }

  function pintar() {
    vaciar(lista);
    const abiertos = items.filter((p) => ABIERTOS.includes(p.estado));
    const cerrados = items.filter((p) => !ABIERTOS.includes(p.estado));
    ctx.marcarPedidosAbiertos(abiertos.length);
    if (!items.length) { lista.append(h('p', { class: 'vacio', 'data-campo': 'pedidos-vacio' }, 'No hay pedidos web por ahora.')); return; }
    agregar(lista,
      abiertos.length ? abiertos.map(tarjeta) : h('p', { class: 'vacio', 'data-campo': 'pedidos-vacio' }, 'No hay pedidos web abiertos.'),
      cerrados.length ? h('h3', null, 'Cerrados hoy') : null,
      cerrados.map(tarjeta));
  }

  async function accion(fn, exito) {
    try {
      const r = await fn();
      if (exito) ctx.avisar(typeof exito === 'function' ? exito(r) : exito, 'ok');
      await refrescar();
      return r;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión. Inténtalo de nuevo.' : e.message, 'error');
      return null;
    }
  }

  const cambiar = (p, estado) => accion(() => ctx.api.cambiarEstadoPedidoWeb(p.id, estado));

  const noLlego = (p) => accion(() => ctx.api.marcarNoLlego(p.id),
    (x) => (x.cuenta_senalada ? 'Marcado. Esta cuenta ya tiene varios "No llegó": el dueño la revisará.' : 'Marcado como "No llegó".'));

  async function cancelar(p) {
    const motivo = await pedirTexto({ titulo: 'Cancelar pedido #' + p.numero, etiqueta: 'Motivo', boton: 'Cancelar pedido' });
    if (!motivo) return;
    await accion(() => ctx.api.cancelarPedidoWeb(p.id, motivo), 'Pedido cancelado.');
  }

  function entregar(p) {
    const m = modal({ titulo: 'Entregar pedido #' + p.numero });
    const enLinea = p.metodo_pago === 'en_linea';
    let medio = 'efectivo';
    const codigo = h('input', { type: 'text', maxlength: '4', autocomplete: 'off', autocapitalize: 'characters', 'data-campo': 'codigo-pedido', 'aria-label': 'Código del cliente' });
    const recibido = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', 'data-campo': 'efectivo-pedido', 'aria-label': 'Efectivo recibido' });
    const error = h('p', { class: 'error', role: 'alert' });
    const zonaPago = h('div', { class: 'pago-pedido' });
    const confirmarBtn = h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'confirmar-entrega' }, 'Entregar y cobrar');
    let ocupado = false;

    function pintarPago() {
      vaciar(zonaPago);
      if (enLinea) { zonaPago.append(h('p', null, 'Ya está pagado en línea: solo verifica el nombre, el contenido y el código.')); return; }
      agregar(zonaPago,
        h('p', null, 'Total a cobrar ', h('strong', { class: 'mono' }, fmtCop(p.total_cop))),
        h('div', { class: 'medios' }, ['efectivo', 'datafono_bold', 'transferencia'].map((k) =>
          h('button', { type: 'button', class: 'chip' + (medio === k ? ' activo' : ''), 'data-medio': k, onclick: () => { medio = k; pintarPago(); } }, MEDIOS[k]))),
        medio === 'efectivo' ? h('label', null, 'Efectivo recibido', recibido) : null);
    }

    async function enviar() {
      if (ocupado) return;
      error.textContent = '';
      const cod = codigo.value.trim();
      if (cod.length !== 4) { error.textContent = 'Digita el código de 4 caracteres que te muestra el cliente.'; return; }
      let efectivo;
      if (!enLinea && medio === 'efectivo') {
        efectivo = Number(String(recibido.value).replace(/\D/g, ''));
        if (!efectivo || efectivo < p.total_cop) { error.textContent = 'El efectivo recibido no alcanza para el total.'; return; }
      }
      ocupado = true;
      confirmarBtn.disabled = true;
      try {
        const r = await ctx.api.entregarPedidoWeb(p.id, cod, enLinea ? null : medio, efectivo);
        m.cerrar();
        const extra = r.cambio_cop ? ' Cambio: ' + fmtCop(r.cambio_cop) + '.' : '';
        ctx.avisar('Pedido #' + p.numero + ' entregado.' + extra + (r.puntos_acreditados ? ' Puntos: ' + r.puntos_acreditados + '.' : ''), 'ok');
        await refrescar();
      } catch (e) {
        error.textContent = e.name === 'ErrorRed' ? 'Sin conexión. Inténtalo de nuevo (no se duplica).' : e.message;
        ocupado = false;
        confirmarBtn.disabled = false;
      }
    }
    confirmarBtn.addEventListener('click', enviar);
    codigo.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
    pintarPago();
    m.cuerpo.append(
      h('p', null, '#' + p.numero + ' · ' + p.nombre_pila + (p.inicial ? ' ' + p.inicial + '.' : '') + '. Verifica el nombre y el contenido.'),
      listaLineas(p),
      h('label', null, 'Código del cliente', codigo),
      zonaPago, error,
      h('div', { class: 'acciones' }, h('button', { type: 'button', class: 'btn', 'data-accion': 'cancelar-entrega', onclick: () => m.cerrar() }, 'Volver'), confirmarBtn));
    codigo.focus();
  }

  async function refrescar() {
    let nuevos;
    try {
      nuevos = (await ctx.api.pedidosWebAbiertos()) || [];
      ctx.marcarConexion(true);
    } catch (e) {
      if (e.name === 'ErrorRed') ctx.marcarConexion(false);
      else ctx.avisar(e.message, 'error');
      return;
    }
    items = nuevos;
    // Sonido solo para pedidos nuevos (no al abrir el turno); la alerta visual queda en la lista.
    let hayNuevo = false;
    for (const p of items) {
      if (!vistos.has(p.id)) {
        vistos.add(p.id);
        if (!primera && p.estado === 'recibido') hayNuevo = true;
      }
    }
    primera = false;
    if (hayNuevo) ctx.sonido.alertar();
    pintar();
  }

  pintar();
  return { el, refrescar, items: () => items };
}
