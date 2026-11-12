// Alertas para el dueño: texto legible por tipo, y decisiones desde aquí (resolver; prepago o bloqueo si "No llegó").
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fmtCop, fechaCorta, horaBogota } from '../../lib/format.js';
import { pedirTexto, pedirPin } from '../../pos/ui/modal.js';
import { mensajePin } from '../../pos/ui/caja.js';

const ESTADO_PEDIDO = { cancelado: 'cancelado', no_llego: 'marcado como "No llegó"', entregado: 'entregado', recibido: 'recibido', preparando: 'en preparación', listo: 'listo' };

export function quienEs(a) {
  const c = a.cliente;
  if (!c) return 'Una cuenta';
  return (c.nombre || 'Sin nombre') + (c.correo ? ' (' + c.correo + ')' : '');
}

// Frase en español colombiano, con tuteo, para cada tipo de alerta.
export function textoAlerta(a) {
  const d = a.detalle || {};
  switch (a.tipo) {
    case 'venta_sin_pagar':
      return 'La venta #' + (d.numero || '?') + ' (' + fmtCop(d.total_cop) + ') quedó sin pagar al cierre del ' + (d.cierre || 'día') + '.';
    case 'no_llego':
      return quienEs(a) + ' no recogió ' + (d.pedidos_no_llego || 'varios') + ' pedidos web' + (d.ultimo_numero ? ' (el último, #' + d.ultimo_numero + ')' : '') + '. Decide si le exiges prepago o bloqueas sus pedidos web.';
    case 'compras_inusuales':
      return quienEs(a) + ' tiene más compras de lo normal en un día.';
    case 'reclamos_tope':
      return quienEs(a) + ' llegó al tope diario de reclamos de QR.';
    case 'cliente_reporta':
      return quienEs(a) + ' reporta que su pedido no es lo que pidió' + (d.nota ? ': «' + d.nota + '»' : '') + '.';
    case 'pago_bold':
      switch (d.motivo) {
        case 'monto_distinto':
          return 'Bold recibió ' + fmtCop(d.recibido) + ' por el pedido #' + d.pedido + ' y se esperaban ' + fmtCop(d.esperado) + '. No se acreditó: revisa en Bold y, si cobraron de más, devuélvelo.';
        case 'pago_duplicado':
          return 'Hay un pago repetido de ' + fmtCop(d.monto) + ' para el pedido #' + d.pedido + '. Hay que devolver uno en Bold.';
        case 'pedido_cerrado':
          return 'Bold cobró ' + fmtCop(d.monto) + ' por el pedido #' + d.pedido + ', que ya estaba ' + (ESTADO_PEDIDO[d.estado_pedido] || d.estado_pedido) + '. Hay que devolverlo en Bold.';
        case 'anulado_pedido_cerrado':
          return 'Bold anuló un pago del pedido #' + d.pedido + ' (ya ' + (ESTADO_PEDIDO[d.estado_pedido] || d.estado_pedido) + '). Revisa que la devolución quedó hecha.';
        default:
          return 'Alerta de un pago en línea para revisar en Bold.';
      }
    default:
      return 'Alerta: ' + a.tipo;
  }
}

export function crearVistaAlertas(ctx) {
  const el = h('section', { class: 'vista vista-alertas', 'data-vista': 'alertas' });
  let abiertas = [];
  let resueltas = [];
  let verResueltas = false;
  let cargado = false;

  async function refrescar() {
    try {
      abiertas = (await ctx.api.listaAlertas(false)) || [];
      resueltas = verResueltas ? (await ctx.api.listaAlertas(true)) || [] : [];
      cargado = true;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar las alertas.' : e.message, 'error');
      return;
    }
    ctx.marcarConteo('alertas', abiertas.length);
    pintar();
  }

  async function resolver(a) {
    const nota = await pedirTexto({
      titulo: 'Resolver alerta',
      etiqueta: a.tipo === 'pago_bold' ? '¿Qué hiciste? (por ejemplo: devolución hecha en Bold)' : '¿Qué pasó con esto?',
      boton: 'Resolver',
    });
    if (!nota) return;
    try { await ctx.api.resolverAlerta(a.id, nota); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    ctx.avisar('Alerta resuelta.', 'ok');
    await ctx.refrescarTodo();
  }

  async function restringir(a, modo) {
    const etiquetaModo = modo === 'prepago' ? 'prepago' : 'bloqueo';
    const motivo = await pedirTexto({
      titulo: modo === 'prepago' ? 'Exigir prepago' : 'Bloquear pedidos web',
      etiqueta: 'Motivo (opcional)', boton: 'Seguir', obligatorio: false,
    });
    if (motivo === null) return;
    const pin = await pedirPin('Confirma con tu PIN: ' + etiquetaModo);
    if (!pin) return;
    let r;
    try { r = await ctx.api.restringirCuenta(a.cliente_id, modo, motivo, pin); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    if (r && r.ok === false) { ctx.avisar(mensajePin(r), 'error'); return; }
    ctx.avisar(modo === 'prepago' ? 'Listo: esa cuenta solo podrá pedir pagando en línea.' : 'Listo: esa cuenta ya no puede hacer pedidos web.', 'ok');
    await ctx.refrescarTodo();
  }

  function tarjeta(a, esResuelta) {
    return h('article', { class: 'tarjeta alerta alerta-' + a.tipo, 'data-alerta': a.id, 'data-tipo': a.tipo },
      h('p', { class: 'alerta-texto' }, textoAlerta(a)),
      h('p', { class: 'pequeno' }, fechaCorta(a.creada_en, ctx.ahora()) + ' · ' + horaBogota(a.creada_en)
        + (esResuelta ? ' · resuelta el ' + fechaCorta(a.resuelta_en, ctx.ahora()) + (a.nota ? ': ' + a.nota : '') : '')),
      esResuelta ? null : h('div', { class: 'acciones' },
        a.tipo === 'no_llego' && a.cliente_id
          ? [
              h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'exigir-prepago', onclick: () => restringir(a, 'prepago') }, 'Exigir prepago'),
              h('button', { type: 'button', class: 'btn', 'data-accion': 'bloquear', onclick: () => restringir(a, 'bloqueo') }, 'Bloquear pedidos web'),
            ]
          : null,
        h('button', { type: 'button', class: 'btn', 'data-accion': 'resolver-alerta', onclick: () => resolver(a) }, a.tipo === 'no_llego' ? 'Resolver sin restringir' : 'Resolver')));
  }

  function pintar() {
    vaciar(el);
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Alertas'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-alertas', onclick: refrescar }, 'Actualizar'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'ver-resueltas', 'aria-pressed': verResueltas ? 'true' : 'false',
          onclick: () => { verResueltas = !verResueltas; refrescar(); } }, verResueltas ? 'Ocultar resueltas' : 'Ver resueltas')),
      !cargado ? h('p', { class: 'vacio' }, 'Cargando las alertas…')
        : abiertas.length ? h('div', { class: 'tarjetas', 'data-lista': 'abiertas' }, abiertas.map((a) => tarjeta(a, false)))
        : h('p', { class: 'vacio', 'data-campo': 'sin-alertas' }, 'No hay alertas abiertas. Todo en orden.'),
      verResueltas ? h('h3', null, 'Resueltas (las últimas 50)') : null,
      verResueltas ? (resueltas.length ? h('div', { class: 'tarjetas', 'data-lista': 'resueltas' }, resueltas.map((a) => tarjeta(a, true))) : h('p', { class: 'vacio' }, 'Todavía no hay alertas resueltas.')) : null);
  }

  pintar();
  return { el, refrescar };
}
