// Panel de productos: atajos (un toque agrega el tamaño), selector completo (toppings, presentación, base)
// y precio en vivo. La vista previa de precio usa lib/precio.js; el servidor recalcula siempre.
import { h, vaciar } from '../../lib/dom.js';
import { fmtCop } from '../../lib/format.js';
import { precioLinea } from '../../lib/precio.js';
import { modal } from './modal.js';

export function resumenLinea(cat, l) {
  const pr = cat.productos.get(l.producto);
  const partes = [];
  if (l.tamano && cat.tamanos.get(l.tamano)) partes.push(cat.tamanos.get(l.tamano).nombre);
  if (l.presentacion && l.presentacion !== 'bowl' && cat.presentaciones.get(l.presentacion)) partes.push(cat.presentaciones.get(l.presentacion).nombre);
  if (l.base && cat.bases.get(l.base)) partes.push(cat.bases.get(l.base).nombre);
  if (l.toppings && l.toppings.length) partes.push(l.toppings.map((t) => (cat.toppings.get(t) ? cat.toppings.get(t).nombre : t)).join(', '));
  return { nombre: pr ? pr.nombre : l.producto, detalle: partes.join(' · ') };
}

// Abre el selector completo para un producto con tamaños. Resuelve con la línea o null.
export function abrirSelector(ctx, producto) {
  const cat = ctx.cat;
  return new Promise((resolver) => {
    let hecho = false;
    const m = modal({ titulo: producto.nombre, onCerrar: () => { if (!hecho) { hecho = true; resolver(null); } } });
    const tamanos = cat.lista.tamanos.filter((t) => t.activo);
    const estado = {
      producto: producto.clave,
      tamano: (tamanos.find((t) => t.clave === 'pequeno') || tamanos[0]).clave,
      presentacion: 'bowl',
      base: null,
      toppings: [],
      cantidad: 1,
    };
    const zona = h('div', { class: 'selector' });
    m.cuerpo.append(zona);

    const chip = (texto, activo, onclick, extra) =>
      h('button', { type: 'button', class: 'chip' + (activo ? ' activo' : ''), onclick, ...(extra || {}) }, texto);

    function pintar() {
      let precio = null;
      let problema = '';
      try {
        precio = precioLinea(cat, estado);
      } catch (e) {
        problema = e.message;
      }
      const tm = cat.tamanos.get(estado.tamano);
      vaciar(zona);
      if (producto.tipo === 'personalizado') {
        zona.append(
          h('h3', null, 'Base'),
          h('div', { class: 'chips' }, cat.lista.bases.filter((b) => b.activo).map((b) =>
            chip(b.nombre, estado.base === b.clave, () => { estado.base = b.clave; pintar(); }, { 'data-base': b.clave })))
        );
      }
      zona.append(
        h('h3', null, 'Tamaño'),
        h('div', { class: 'chips' }, tamanos.map((t) =>
          chip(t.nombre + ' · ' + fmtCop(t.precio_cop), estado.tamano === t.clave, () => { estado.tamano = t.clave; pintar(); }, { 'data-tamano': t.clave }))),
        h('h3', null, 'Presentación'),
        h('div', { class: 'chips' }, cat.lista.presentaciones.map((p) =>
          chip(p.nombre, estado.presentacion === p.clave, () => { estado.presentacion = p.clave; pintar(); }, { 'data-presentacion': p.clave }))),
        h('h3', null, 'Toppings ' + (producto.tipo === 'personalizado' ? '(' + tm.toppings_incluidos + ' incluidos; los demás suman)' : '(cada uno suma)')),
        h('div', { class: 'chips toppings' }, cat.lista.toppings.filter((t) => t.activo).map((t) => {
          const pos = estado.toppings.indexOf(t.clave);
          const marcado = pos >= 0;
          const extra = marcado && (producto.tipo === 'menu' || pos + 1 > tm.toppings_incluidos);
          const etiqueta = t.nombre + (marcado ? (extra ? ' · +' + fmtCop(t.precio_cop) : ' · incluido') : ' · ' + fmtCop(t.precio_cop));
          return chip(etiqueta, marcado, () => {
            if (marcado) estado.toppings.splice(pos, 1); else estado.toppings.push(t.clave);
            pintar();
          }, { 'data-topping': t.clave });
        })),
        h('div', { class: 'cantidad' },
          h('button', { type: 'button', class: 'btn', 'data-accion': 'menos', onclick: () => { estado.cantidad = Math.max(1, estado.cantidad - 1); pintar(); } }, '−'),
          h('span', { class: 'mono', 'data-campo': 'cantidad' }, String(estado.cantidad)),
          h('button', { type: 'button', class: 'btn', 'data-accion': 'mas', onclick: () => { estado.cantidad = Math.min(20, estado.cantidad + 1); pintar(); } }, '+')),
        h('p', { class: 'error', role: 'alert' }, producto.tipo === 'personalizado' && !estado.base ? 'Elige una base para continuar.' : problema),
        h('button', {
          type: 'button', class: 'btn btn-primario grande', 'data-accion': 'agregar-seleccion', disabled: !precio || (producto.tipo === 'personalizado' && !estado.base),
          onclick: () => { hecho = true; m.cerrar(); resolver({ ...estado, toppings: estado.toppings.slice() }); },
        }, 'Agregar · ' + (precio ? fmtCop(precio.subtotal) : ''))
      );
    }
    pintar();
  });
}

// onAgregar(linea) puede devolver una promesa; el panel espera a que termine antes de aceptar otro toque.
export function crearPanelCatalogo(ctx, onAgregar) {
  const el = h('div', { class: 'catalogo' });
  let ocupado = false;

  async function agregar(linea) {
    if (ocupado) return;
    ocupado = true;
    try {
      await onAgregar(linea);
    } finally {
      ocupado = false;
    }
  }

  async function conSelector(p) {
    const linea = await abrirSelector(ctx, p);
    if (linea) await agregar(linea);
  }

  function pintar() {
    const cat = ctx.cat;
    vaciar(el);
    if (!cat) return;
    const activos = cat.lista.productos.filter((p) => p.activo);
    const tamanos = cat.lista.tamanos.filter((t) => t.activo);
    const menu = activos.filter((p) => p.tipo === 'menu');
    el.append(
      h('h3', null, 'Bowls del menú (atajo: toca el tamaño)'),
      h('div', { class: 'tarjetas' }, menu.map((p) =>
        h('div', { class: 'tarjeta', 'data-producto': p.clave },
          h('strong', null, p.nombre),
          h('small', null, p.sabor || ''),
          h('div', { class: 'chips' },
            tamanos.map((t) => h('button', { type: 'button', class: 'chip', 'data-atajo': p.clave + ':' + t.clave,
              onclick: () => agregar({ producto: p.clave, tamano: t.clave, presentacion: 'bowl', toppings: [], cantidad: 1 }) },
              t.nombre + ' ' + fmtCop(t.precio_cop))),
            h('button', { type: 'button', class: 'chip', 'data-accion': 'mas-opciones', onclick: () => conSelector(p) }, 'Más…'))))),
      ...activos.filter((p) => p.tipo === 'personalizado').map((p) =>
        h('button', { type: 'button', class: 'btn btn-primario grande', 'data-producto': p.clave, onclick: () => conSelector(p) }, 'Arma el tuyo')),
      h('h3', null, 'Cafés y litro'),
      h('div', { class: 'tarjetas' }, activos.filter((p) => p.tipo === 'cafe' || p.tipo === 'litro').map((p) =>
        h('button', { type: 'button', class: 'tarjeta boton', 'data-producto': p.clave, onclick: () => agregar({ producto: p.clave, cantidad: 1 }) },
          h('strong', null, p.nombre), h('span', { class: 'mono' }, fmtCop(p.precio_fijo_cop)))))
    );
  }

  pintar();
  return { el, pintar };
}
