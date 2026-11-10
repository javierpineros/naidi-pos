// Lista de clientes en espera: nombre de pila e inicial, foto y hora de llegada, por orden de llegada.
// Un cliente nuevo (con regalo de bienvenida) se resalta y la marca queda hasta que alguien la vea.
import { h, vaciar } from '../../lib/dom.js';
import { horaBogota } from '../../lib/format.js';

export function crearVistaEspera(ctx) {
  const el = h('section', { class: 'vista vista-espera', 'data-vista': 'espera' });
  const lista = h('div', { class: 'espera-lista', 'aria-live': 'polite' });
  const avisados = new Set();
  let items = [];

  el.append(
    h('div', { class: 'barra-vista' },
      h('h2', null, 'Clientes en espera'),
      h('button', { type: 'button', class: 'btn', 'data-accion': 'venta-sin-cliente-espera', onclick: () => ctx.vista('venta').iniciarSinCliente() }, 'Venta sin cliente')),
    lista
  );

  function pintar() {
    vaciar(lista);
    if (!items.length) {
      lista.append(h('p', { class: 'vacio', 'data-campo': 'espera-vacia' }, 'Nadie en espera por ahora.'));
      return;
    }
    for (const it of items) {
      const foto = it.foto_url
        ? h('img', { class: 'foto', src: it.foto_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : h('span', { class: 'foto inicial', 'aria-hidden': 'true' }, (it.nombre_pila || '?').slice(0, 1).toUpperCase());
      const marcas = [];
      if (it.cliente_nuevo) marcas.push(h('span', { class: 'marca nuevo' }, 'Cliente nuevo'));
      if (it.regalo_bienvenida) marcas.push(h('span', { class: 'marca regalo' }, 'Regalo de bienvenida'));
      if (it.premio_listo) marcas.push(h('span', { class: 'marca premio' }, 'Premio listo'));
      if (it.pedido_web_listo) marcas.push(h('span', { class: 'marca web' }, 'Pedido web listo'));
      lista.append(h('article', { class: 'espera-item' + (it.alerta_pendiente ? ' alerta' : ''), 'data-checkin': it.checkin_id },
        foto,
        h('div', { class: 'espera-datos' },
          h('strong', null, it.nombre_pila + (it.inicial ? ' ' + it.inicial + '.' : '')),
          h('small', null, 'Llegó a las ' + horaBogota(it.llegada_en)),
          h('div', { class: 'marcas' }, marcas)),
        h('div', { class: 'espera-acciones' },
          it.alerta_pendiente ? h('button', { type: 'button', class: 'btn', 'data-accion': 'alerta-vista', onclick: () => visto(it) }, 'Visto') : null,
          h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'atender', onclick: () => ctx.vista('venta').iniciarConCliente(it) }, 'Atender'),
          h('button', { type: 'button', class: 'btn', 'data-accion': 'se-fue', onclick: () => seFue(it) }, 'Ya se fue'))));
    }
  }

  async function visto(it) {
    try { await ctx.api.marcarAlertaVista(it.checkin_id); } catch (e) { ctx.avisar(e.message, 'error'); }
    await refrescar();
  }

  async function seFue(it) {
    try { await ctx.api.marcarSeFue(it.checkin_id); } catch (e) { ctx.avisar(e.message, 'error'); }
    await refrescar();
  }

  async function refrescar() {
    let nuevos;
    try {
      nuevos = (await ctx.api.listaEspera()) || [];
      ctx.marcarConexion(true);
    } catch (e) {
      if (e.name === 'ErrorRed') ctx.marcarConexion(false);
      else ctx.avisar(e.message, 'error');
      return;
    }
    items = nuevos;
    ctx.setEspera(items);
    // Sonido solo una vez por cliente nuevo; la marca visual se queda en la lista hasta que la vean.
    let hayNuevoSinAviso = false;
    for (const it of items) {
      if (it.alerta_pendiente && !avisados.has(it.checkin_id)) {
        avisados.add(it.checkin_id);
        hayNuevoSinAviso = true;
      }
    }
    if (hayNuevoSinAviso) ctx.sonido.alertar();
    pintar();
  }

  pintar();
  return { el, refrescar, items: () => items };
}
