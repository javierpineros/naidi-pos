// Tienda web de Naidí: catálogo, carrito y pedido para recoger en tienda. Sin framework; todo texto entra como nodo de texto.
// El servidor manda: reprecia el pedido, valida la ventana y la cortesía, y decide si la tienda está abierta (bandera pedidos_web).
import { h, vaciar, agregar } from '../lib/dom.js';
import { fmtCop, horaBogota, hoyBogota, TAMANOS } from '../lib/format.js';
import { crearCatalogo, precioLinea } from '../lib/precio.js';
import { qrSvg } from '../lib/qr.js';

const CLAVE_CARRITO = 'tienda.carrito';
const DURACION_VENTANA_MIN = 30;
const PASO_MIN = 15;
const ESTADOS = {
  recibido: ['Recibido', 'Recibimos tu pedido. En un momento empezamos a prepararlo.'],
  preparando: ['Preparando', 'Estamos preparando tu pedido.'],
  listo: ['Listo', 'Tu pedido está listo. ¡Te esperamos!'],
  entregado: ['Entregado', 'Gracias por pedir en Naidí.'],
  no_llego: ['No llegó', 'No recogiste este pedido en su ventana.'],
  cancelado: ['Cancelado', 'Este pedido se canceló.'],
};
const ABIERTOS = ['recibido', 'preparando', 'listo'];

const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

const mensajeError = (x) => (x && x.name === 'ErrorRed' ? 'No hay conexión. Revisa tu internet e inténtalo de nuevo.' : (x && x.message) || 'Algo salió mal.');

export function crearTienda(cfg) {
  const { raiz, api } = cfg;
  const almacen = cfg.almacen || { leer: () => null, escribir: () => {}, borrar: () => {} };
  const ahora = cfg.ahora || (() => new Date());
  const cadaTanto = cfg.setInterval || ((fn, ms) => setInterval(fn, ms));
  const parar = cfg.clearInterval || ((t) => clearInterval(t));
  const googleActivo = !!cfg.googleActivo;
  const intervaloMs = cfg.intervaloMs || 5000;

  const e = {
    pantalla: 'cargando', cat: null, estado: null, sesion: null, perfil: null, mia: null,
    carrito: [], hoja: null, pedidos: [], idem: uuid(), error: '', aviso: '', ocupado: false,
    paso: 'correo', correo: '', volverA: 'menu', temporizador: null,
    form: { slot: '', pago: '', cortesia: [], nota: '' }, nuevo: null,
    pagos: {}, volviendoDePago: false, estadoRetorno: '', pedidoRetorno: '', ultimaVerificacion: {}, revisados: {},
  };
  const leerBusqueda = cfg.leerBusqueda || (() => (typeof window === 'undefined' ? '' : window.location.search));

  // ------------------------------------------------------------------ Almacenamiento (solo comodidad del carrito)
  function guardarCarrito() { try { almacen.escribir(CLAVE_CARRITO, JSON.stringify(e.carrito)); } catch (x) { /* ok */ } }
  function leerCarrito() {
    try {
      const v = JSON.parse(almacen.leer(CLAVE_CARRITO) || '[]');
      return Array.isArray(v) ? v.filter((l) => l && e.cat.productos.get(l.producto)) : [];
    } catch (x) { return []; }
  }

  // ------------------------------------------------------------------ Utilidades de precio y texto
  const abierta = () => !!(e.estado && e.estado.abierta);
  function precio(l) { try { return precioLinea(e.cat, l); } catch (x) { return { unitario: 0, subtotal: 0, toppings: [] }; } }
  const totalCarrito = () => e.carrito.reduce((a, l) => a + precio(l).subtotal, 0);
  const cuantos = () => e.carrito.reduce((a, l) => a + (l.cantidad || 1), 0);
  const hayBowl = () => e.carrito.some((l) => l.tamano);
  function nombreTopping(clave) { const t = e.cat.toppings.get(clave); return t ? t.nombre : clave; }
  function resumen(l) {
    const pr = e.cat.productos.get(l.producto);
    const partes = [];
    if (l.tamano) partes.push((TAMANOS[l.tamano] || l.tamano));
    if (l.base && e.cat.bases.get(l.base)) partes.push(e.cat.bases.get(l.base).nombre);
    if (l.toppings && l.toppings.length) partes.push(l.toppings.map(nombreTopping).join(', '));
    return { nombre: (l.cantidad > 1 ? l.cantidad + ' × ' : '') + (pr ? pr.nombre : l.producto), detalle: partes.join(' · ') };
  }
  function desde(pr) {
    if (!pr.usa_tamanos) return pr.precio_fijo_cop;
    const precios = e.cat.lista.tamanos.map((t) => t.precio_cop);
    return precios.length ? Math.min.apply(null, precios) : 0;
  }

  // ------------------------------------------------------------------ Ventanas de recogida (hora de Bogotá, UTC-5 todo el año)
  function ventanasDisponibles() {
    const est = e.estado || {};
    const vent = est.ventana || { min_anticipacion_min: 20, max_anticipacion_horas: 24 };
    const t0 = ahora().getTime();
    const minimo = t0 + (vent.min_anticipacion_min + 1) * 60000;
    const maximo = t0 + vent.max_anticipacion_horas * 3600000 - 5 * 60000;   // margen por si el reloj del celular se adelanta
    const dias = [hoyBogota(ahora()), hoyBogota(new Date(t0 + 86400000))];
    const lista = [];
    dias.forEach((dia, i) => {
      for (let m = 0; m < 24 * 60; m += PASO_MIN) {   // sin horario fijo: lo acota la anticipación máxima y el interruptor del personal
        const fmt = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
        const ini = new Date(dia + 'T' + fmt(m) + ':00-05:00');
        if (ini.getTime() < minimo || ini.getTime() > maximo) continue;
        const fin = new Date(ini.getTime() + DURACION_VENTANA_MIN * 60000);
        lista.push({ clave: ini.toISOString(), inicio: ini.toISOString(), fin: fin.toISOString(),
          etiqueta: (i === 0 ? 'Hoy ' : 'Mañana ') + horaBogota(ini.toISOString()) + ' – ' + horaBogota(fin.toISOString()) });
      }
    });
    return lista;
  }

  // ------------------------------------------------------------------ Piezas comunes
  const marca = () => h('img', { class: 'logo', src: '/img/logo-nombre.png', alt: 'Naidí' });

  function cabecera() {
    return h('header', { class: 'cabecera' },
      marca(),
      h('nav', null,
        h('button', { type: 'button', class: 'btn-texto', 'data-accion': 'ver-menu', onclick: () => { e.pantalla = 'menu'; pintar(); } }, 'Menú'),
        e.sesion
          ? h('button', { type: 'button', class: 'btn-texto', 'data-accion': 'mis-pedidos', onclick: () => abrirPedidos() }, 'Mis pedidos')
          : h('button', { type: 'button', class: 'btn-texto', 'data-accion': 'entrar', onclick: () => { e.volverA = 'menu'; e.pantalla = 'acceso'; pintar(); } }, 'Entrar')));
  }

  function bannerCerrada() {
    if (abierta()) return null;
    return h('p', { class: 'aviso', role: 'status', 'data-campo': 'tienda-cerrada' },
      'Por ahora no estamos recibiendo pedidos en línea. Mira el menú y pide directamente en la tienda.');
  }

  async function accion(fn, errorEl, despues) {
    if (e.ocupado) return;
    e.ocupado = true;
    try {
      await fn();
      e.ocupado = false;
      if (despues) await despues();
    } catch (x) {
      e.ocupado = false;
      if (errorEl) errorEl.textContent = mensajeError(x);
    }
  }

  // ------------------------------------------------------------------ Foto ampliada
  // Hay versión grande para los bowls y el litro; los cafés se amplían desde su miniatura. Va fuera de la raíz para que
  // repintar la pantalla no la cierre, y se cierra con la X, tocando el fondo o con Esc.
  const FOTOS_GRANDES = ['amazonas', 'carioca', 'selva', 'cacao', 'fit', 'manaos', 'tucano', 'frutal', 'litro'];
  function cerrarFoto() {
    const f = e.foto;
    if (!f) return;
    e.foto = null;
    document.removeEventListener('keydown', f.tecla);
    if (f.fondo.parentNode) f.fondo.parentNode.removeChild(f.fondo);
    document.body.style.overflow = f.desplazamientoPrevio;
    if (f.disparador && f.disparador.isConnected && f.disparador.focus) f.disparador.focus();   // devuelve el foco a la miniatura
  }
  function abrirFoto(pr, disparador) {
    cerrarFoto();
    const miniatura = '/img/productos/' + pr.foto + '.webp';
    const grande = FOTOS_GRANDES.indexOf(pr.foto) > -1 ? '/img/productos/zoom/' + pr.foto + '.webp' : miniatura;
    const cerrar = h('button', { type: 'button', class: 'foto-cerrar', 'data-accion': 'cerrar-foto', 'aria-label': 'Cerrar foto', onclick: cerrarFoto }, '×');
    const fondo = h('div', { class: 'foto-fondo', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Foto de ' + pr.nombre, 'data-campo': 'foto-ampliada',
      onclick: (ev) => { if (ev.target === fondo) cerrarFoto(); } },
      h('figure', { class: 'foto-caja' },
        h('img', { class: 'foto-grande', src: grande, alt: pr.nombre,
          onerror: (ev) => { if (ev.target.getAttribute('src') !== miniatura) ev.target.setAttribute('src', miniatura); } }),
        h('figcaption', null, pr.nombre)),
      cerrar);
    const tecla = (ev) => { if (ev.key === 'Escape' || ev.key === 'Esc') cerrarFoto(); };
    document.addEventListener('keydown', tecla);
    e.foto = { fondo, tecla, disparador, desplazamientoPrevio: document.body.style.overflow };
    document.body.style.overflow = 'hidden';   // el fondo no se desplaza mientras se ve la foto
    document.body.appendChild(fondo);
    cerrar.focus();
  }

  // ------------------------------------------------------------------ Menú
  function tarjetaProducto(pr) {
    return h('li', { class: 'producto', 'data-producto': pr.clave },
      // La miniatura es decorativa (el nombre va al lado) y abre la foto ampliada. Si no carga, se quita y la tarjeta queda como antes.
      pr.foto ? h('button', { type: 'button', class: 'producto-foto-btn', 'data-accion': 'ver-foto', 'aria-label': 'Ver foto de ' + pr.nombre,
        onclick: (ev) => abrirFoto(pr, ev.currentTarget) },
        h('img', { class: 'producto-foto', src: '/img/productos/' + pr.foto + '.webp', alt: '', width: '72', height: '72', loading: 'lazy', decoding: 'async',
          onerror: (ev) => { const b = ev.target && ev.target.parentNode; if (b && b.parentNode) b.parentNode.removeChild(b); } })) : null,
      h('div', { class: 'producto-texto' },
        h('h3', null, pr.nombre),
        pr.descripcion ? h('p', { class: 'pequeno' }, pr.descripcion) : null,
        h('p', { class: 'mono precio' }, (pr.usa_tamanos ? 'Desde ' : '') + fmtCop(desde(pr)))),
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'elegir', disabled: !abierta(), onclick: () => abrirHoja(pr) }, pr.usa_tamanos || pr.tipo === 'personalizado' ? 'Elegir' : 'Agregar'));
  }

  function pantallaMenu() {
    const porCategoria = new Map();
    for (const pr of e.cat.lista.productos) {
      if (!porCategoria.has(pr.categoria)) porCategoria.set(pr.categoria, []);
      porCategoria.get(pr.categoria).push(pr);
    }
    const nombres = { bowls: 'Bowls y smoothies', cafes: 'Cafés', litro: 'Litro' };
    return h('div', { class: 'pagina' },
      cabecera(),
      h('main', { class: 'contenido' },
        h('h1', null, 'Pide en Naidí'),
        h('p', null, 'Elige, escoge la hora y recógelo en la tienda. Pagas al recoger.'),
        bannerCerrada(),
        [...porCategoria.entries()].map(([cat, lista]) =>
          h('section', { class: 'categoria', 'data-categoria': cat }, h('h2', null, nombres[cat] || cat), h('ul', { class: 'productos' }, lista.map(tarjetaProducto))))),
      pastilla());
  }

  function pastilla() {
    if (!e.carrito.length) return null;
    return h('div', { class: 'pastilla-carrito' },
      h('span', null, cuantos() + (cuantos() === 1 ? ' producto' : ' productos') + ' · ', h('strong', { class: 'mono', 'data-campo': 'total-pastilla' }, fmtCop(totalCarrito()))),
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'ver-carrito', onclick: () => {
        e.pantalla = 'carrito'; prepararFormulario(); pintar();
        // Los pedidos abiertos pudieron cerrarse (entregados) desde que se cargó la página: se consulta de nuevo.
        refrescarMia().then((cambio) => { if (cambio && e.pantalla === 'carrito') pintar(); });
      } }, 'Ver pedido'));
  }

  // ------------------------------------------------------------------ Hoja de producto
  function abrirHoja(pr) {
    if (!abierta()) return;
    if (!pr.usa_tamanos) {
      e.carrito.push({ producto: pr.clave, cantidad: 1 });
      guardarCarrito();
      pintar();
      return;
    }
    const tm = e.cat.lista.tamanos[0];
    e.hoja = {
      producto: pr.clave, tamano: tm ? tm.clave : null,
      presentacion: (e.cat.lista.presentaciones[0] || {}).clave || 'bowl',
      base: pr.tipo === 'personalizado' ? (e.cat.lista.bases[0] || {}).clave : null,
      toppings: [], cantidad: 1,
    };
    pintar();
  }

  function lineaDeHoja() {
    const x = e.hoja;
    const l = { producto: x.producto, tamano: x.tamano, presentacion: x.presentacion, toppings: x.toppings.slice(), cantidad: x.cantidad };
    if (x.base) l.base = x.base;
    return l;
  }

  function hoja() {
    const x = e.hoja;
    const pr = e.cat.productos.get(x.producto);
    const tm = e.cat.tamanos.get(x.tamano);
    const p = precio(lineaDeHoja());
    const incluidos = pr.tipo === 'personalizado' && tm ? tm.toppings_incluidos : 0;
    const repintar = () => pintar();
    return h('div', { class: 'hoja-fondo', 'data-campo': 'hoja' },
      h('div', { class: 'hoja', role: 'dialog', 'aria-label': pr.nombre },
        h('div', { class: 'hoja-cabeza' }, h('h2', null, pr.nombre), h('button', { type: 'button', class: 'btn-icono', 'data-accion': 'cerrar-hoja', 'aria-label': 'Cerrar', onclick: () => { e.hoja = null; pintar(); } }, '×')),
        pr.descripcion ? h('p', { class: 'pequeno' }, pr.descripcion) : null,
        h('h3', null, 'Tamaño'),
        h('div', { class: 'chips' }, e.cat.lista.tamanos.map((t) =>
          h('button', { type: 'button', class: 'chip' + (x.tamano === t.clave ? ' activo' : ''), 'data-tamano': t.clave, onclick: () => { x.tamano = t.clave; repintar(); } },
            t.nombre + ' · ' + fmtCop(t.precio_cop)))),
        e.cat.lista.presentaciones.length > 1
          ? [h('h3', null, 'Presentación'), h('div', { class: 'chips' }, e.cat.lista.presentaciones.map((q) =>
              h('button', { type: 'button', class: 'chip' + (x.presentacion === q.clave ? ' activo' : ''), 'data-presentacion': q.clave, onclick: () => { x.presentacion = q.clave; repintar(); } }, q.nombre)))]
          : null,
        pr.tipo === 'personalizado'
          ? [h('h3', null, 'Base'), h('div', { class: 'chips' }, e.cat.lista.bases.map((b) =>
              h('button', { type: 'button', class: 'chip' + (x.base === b.clave ? ' activo' : ''), 'data-base': b.clave, onclick: () => { x.base = b.clave; repintar(); } }, b.nombre)))]
          : null,
        // Solo "Arma tu bowl" deja elegir toppings; los bowls del menú ya traen los suyos definidos.
        pr.tipo === 'personalizado'
          ? [h('h3', null, 'Toppings (' + incluidos + ' incluidos)'),
              h('div', { class: 'chips' }, e.cat.lista.toppings.map((t) => {
                const idx = x.toppings.indexOf(t.clave);
                return h('button', { type: 'button', class: 'chip' + (idx > -1 ? ' activo' : ''), 'data-topping': t.clave, 'aria-pressed': idx > -1 ? 'true' : 'false',
                  onclick: () => { if (idx > -1) x.toppings.splice(idx, 1); else x.toppings.push(t.clave); repintar(); } },
                t.nombre + ' +' + fmtCop(t.precio_cop));
              }))]
          : null,
        h('div', { class: 'cantidad' },
          h('button', { type: 'button', class: 'btn', 'data-accion': 'menos', 'aria-label': 'Menos', disabled: x.cantidad <= 1, onclick: () => { x.cantidad -= 1; repintar(); } }, '−'),
          h('strong', { class: 'mono', 'data-campo': 'cantidad' }, String(x.cantidad)),
          h('button', { type: 'button', class: 'btn', 'data-accion': 'mas', 'aria-label': 'Más', disabled: x.cantidad >= 10, onclick: () => { x.cantidad += 1; repintar(); } }, '+')),
        h('button', { type: 'button', class: 'btn btn-primario grande', 'data-accion': 'agregar',
          onclick: () => { e.carrito.push(lineaDeHoja()); e.hoja = null; guardarCarrito(); pintar(); } },
        'Agregar · ', h('span', { class: 'mono', 'data-campo': 'precio-hoja' }, fmtCop(p.subtotal)))));
  }

  // ------------------------------------------------------------------ Carrito y pedido
  function prepararFormulario() {
    const slots = ventanasDisponibles();
    if (!slots.some((s) => s.clave === e.form.slot)) e.form.slot = '';
    const pagos = (e.estado && e.estado.pagos) || {};
    if (e.mia && e.mia.restriccion === 'prepago') e.form.pago = pagos.en_linea ? 'en_linea' : '';
    else if (!e.form.pago || !pagos[e.form.pago]) e.form.pago = pagos.al_recoger ? 'al_recoger' : (pagos.en_linea ? 'en_linea' : '');
    if (!hayBowl() || !cortesiaDisponible()) e.form.cortesia = [];
    e.error = '';
  }

  function cortesiaDisponible() {
    const c = e.estado && e.estado.cortesia;
    return !!(c && c.activo && c.cantidad > 0 && e.mia && e.mia.cortesia_disponible);
  }

  function pantallaCarrito() {
    const errorEl = h('p', { class: 'error', role: 'alert', 'data-campo': 'error' }, e.error);
    const slots = ventanasDisponibles();
    const pagos = (e.estado && e.estado.pagos) || {};
    const cortesia = e.estado && e.estado.cortesia;
    const lineas = e.carrito.map((l, i) => {
      const r = resumen(l);
      return h('li', { class: 'linea', 'data-linea': i },
        h('div', null, h('strong', null, r.nombre), r.detalle ? h('small', null, r.detalle) : null),
        h('span', { class: 'mono' }, fmtCop(precio(l).subtotal)),
        h('button', { type: 'button', class: 'btn-icono', 'data-accion': 'quitar', 'aria-label': 'Quitar', onclick: () => { e.carrito.splice(i, 1); guardarCarrito(); if (!e.carrito.length) e.pantalla = 'menu'; pintar(); } }, '×'));
    });

    const selector = h('select', { 'data-campo': 'ventana', 'aria-label': 'Hora de recogida', onchange: (ev) => { e.form.slot = ev.target.value; } },
      h('option', { value: '' }, slots.length ? 'Elige la hora' : 'Hoy ya no hay horas disponibles'),
      slots.map((s) => h('option', { value: s.clave, selected: e.form.slot === s.clave ? true : null }, s.etiqueta)));

    // Opciones excluyentes: se ven como opciones con círculo (radio), no como botones.
    const opcionPago = (clave, titulo, detalle, deshabilitada) =>
      h('label', { class: 'opcion-pago' + (e.form.pago === clave ? ' elegida' : '') + (deshabilitada ? ' desactivada' : '') },
        h('input', { type: 'radio', name: 'pago', value: clave, 'data-pago': clave, checked: e.form.pago === clave ? true : null, disabled: deshabilitada ? true : null,
          onchange: () => { e.form.pago = clave; pintar(); } }),
        h('span', null, h('strong', null, titulo), h('small', null, detalle)));
    const formaPago = h('div', { class: 'opciones-pago', role: 'radiogroup', 'aria-label': 'Forma de pago' },
      pagos.al_recoger ? opcionPago('al_recoger', 'Pagar al recoger', 'Pagas en la tienda: efectivo, datáfono o transferencia.', e.mia && e.mia.restriccion === 'prepago') : null,
      pagos.en_linea ? opcionPago('en_linea', 'Pagar en línea', 'Tarjeta, PSE, Nequi o Bancolombia, con Bold.', false) : null);

    const bloque = e.mia && e.mia.restriccion === 'bloqueo';
    const lleno = e.mia && e.mia.abiertos >= e.mia.max_abiertos;
    const nota = h('textarea', { rows: '2', maxlength: '200', 'data-campo': 'nota', 'aria-label': 'Nota para el pedido', placeholder: 'Ej.: sin canela' });
    nota.value = e.form.nota;
    nota.addEventListener('input', () => { e.form.nota = nota.value; });

    return h('div', { class: 'pagina' },
      cabecera(),
      h('main', { class: 'contenido' },
        h('h1', null, 'Tu pedido'),
        bannerCerrada(),
        bloque ? h('p', { class: 'aviso error', role: 'alert' }, 'Por ahora no podemos recibir pedidos web de esta cuenta. Habla con el personal en la tienda.') : null,
        lleno ? h('p', { class: 'aviso', role: 'status' }, 'Ya tienes ' + e.mia.abiertos + ' pedido(s) abierto(s). Cuando recojas alguno podrás pedir de nuevo.') : null,
        h('ul', { class: 'lineas' }, lineas),
        h('p', { class: 'total' }, 'Total ', h('strong', { class: 'mono', 'data-campo': 'total' }, fmtCop(totalCarrito()))),
        cortesia && cortesia.activo && cortesiaDisponible() && hayBowl()
          ? h('section', { class: 'cortesia', 'data-campo': 'cortesia' },
              h('h2', null, 'Un topping de cortesía'),
              h('p', { class: 'pequeno' }, 'Por pedir en línea, te regalamos ' + cortesia.cantidad + (cortesia.cantidad === 1 ? ' topping' : ' toppings') + ' sin costo cuando recojas y pagues tu pedido.'),
              h('div', { class: 'chips' }, e.cat.lista.toppings.map((t) => {
                const idx = e.form.cortesia.indexOf(t.clave);
                return h('button', { type: 'button', class: 'chip' + (idx > -1 ? ' activo' : ''), 'data-cortesia': t.clave, 'aria-pressed': idx > -1 ? 'true' : 'false',
                  onclick: () => {
                    if (idx > -1) e.form.cortesia.splice(idx, 1);
                    else if (e.form.cortesia.length < cortesia.cantidad) e.form.cortesia.push(t.clave);
                    else if (cortesia.cantidad === 1) e.form.cortesia = [t.clave];
                    pintar();
                  } }, t.nombre);
              })))
          : null,
        h('section', null, h('h2', null, '¿Cuándo lo recoges?'), selector,
          h('p', { class: 'pequeno' }, 'Tienes ' + DURACION_VENTANA_MIN + ' minutos para recogerlo. El bowl se derrite: cuando salgas, toca "Voy en camino".')),
        h('section', null, h('h2', null, 'Pago'), formaPago),
        h('label', null, 'Nota (opcional)', nota),
        errorEl,
        e.sesion ? null : h('p', { class: 'pequeno' }, 'Para confirmar el pedido te pediremos que entres con tu correo.'),
        h('button', { type: 'button', class: 'btn btn-primario grande', 'data-accion': 'pedir', disabled: !abierta() || bloque || lleno ? true : null,
          onclick: () => confirmarPedido(errorEl) }, e.sesion ? 'Confirmar pedido' : 'Entrar y confirmar')));
  }

  async function confirmarPedido(errorEl) {
    errorEl.textContent = '';
    if (!e.carrito.length) { errorEl.textContent = 'Tu pedido está vacío.'; return; }
    if (!e.form.slot) { errorEl.textContent = 'Elige la hora en que vas a recogerlo.'; return; }
    if (!e.form.pago) { errorEl.textContent = 'Elige cómo vas a pagar.'; return; }
    if (!e.sesion) { e.volverA = 'carrito'; e.pantalla = 'acceso'; pintar(); return; }
    if (!e.perfil || !e.perfil.acepta_datos || !e.mia) { e.volverA = 'carrito'; await continuarConSesion(); return; }
    const s = ventanasDisponibles().find((x) => x.clave === e.form.slot);
    if (!s) { errorEl.textContent = 'Esa hora ya no está disponible. Elige otra.'; return; }
    await accion(async () => {
      const r = await api.crearPedido({
        idem: e.idem,
        lineas: e.carrito.map((l) => ({ producto: l.producto, tamano: l.tamano || null, presentacion: l.presentacion || null, base: l.base || null, toppings: l.toppings || [], cantidad: l.cantidad || 1 })),
        ventanaInicio: s.inicio, ventanaFin: s.fin, pago: e.form.pago, cortesia: e.form.cortesia, nota: e.form.nota,
      });
      e.nuevo = r.numero;
      e.nuevoEnLinea = r.metodo_pago === 'en_linea' ? r.id : null;
      e.carrito = [];
      guardarCarrito();
      e.idem = uuid();
      e.form = { slot: '', pago: '', cortesia: [], nota: '' };
    }, errorEl, async () => {
      await abrirPedidos();
      const nuevo = e.nuevoEnLinea && e.pedidos.find((x) => x.id === e.nuevoEnLinea);
      e.nuevoEnLinea = null;
      if (nuevo && nuevo.pago_en_linea_estado === 'pendiente') await iniciarPago(nuevo, null);
    });
  }

  // ------------------------------------------------------------------ Mis pedidos
  // Botón de pagos de Bold: la página solo pone los datos que firmó el servidor; el pago lo confirma el webhook, no este navegador.
  async function iniciarPago(p, errorEl) {
    if (e.pagos[p.id]) return;
    try {
      const d = await api.iniciarPagoBold(p.id);
      const contenedor = h('div', { class: 'boton-bold', 'data-campo': 'boton-bold' });
      const s = document.createElement('script');
      s.setAttribute('data-bold-button', 'light-L');
      s.setAttribute('data-api-key', d.apiKey);
      s.setAttribute('data-order-id', d.orderId);
      s.setAttribute('data-currency', d.currency);
      s.setAttribute('data-amount', String(d.amount));
      s.setAttribute('data-integrity-signature', d.integritySignature);
      if (d.redirectionUrl) s.setAttribute('data-redirection-url', d.redirectionUrl);   // solo https: Bold rechaza http://localhost
      // Sin data-description: el botón que ya funcionó en our-memories no lo enviaba y Bold puede rechazar caracteres como # o tildes.
      if (e.sesion && e.sesion.email) s.setAttribute('data-customer-data', JSON.stringify({ email: e.sesion.email }));
      s.src = 'https://checkout.bold.co/library/boldPaymentButton.js';
      // Ayuda para depurar el botón: deja en la consola lo que se le pasa a Bold (sin la firma, solo su largo).
      try { console.info('[Bold] datos del botón', { apiKey: d.apiKey, orderId: d.orderId, amount: d.amount, currency: d.currency, redirectionUrl: d.redirectionUrl, firmaLargo: String(d.integritySignature).length }); } catch (x) { /* ok */ }
      contenedor.append(s);
      e.pagos[p.id] = contenedor;   // se conserva el mismo nodo entre repintados para no reiniciar el botón
      pintar();
    } catch (x) {
      if (errorEl) errorEl.textContent = mensajeError(x);
    }
  }

  function tarjetaPedido(p) {
    const abiertoP = ABIERTOS.includes(p.estado);
    const [titulo, textoBase] = ESTADOS[p.estado] || [p.estado, ''];
    const enLinea = p.metodo_pago === 'en_linea';
    const porPagar = enLinea && abiertoP && p.pago_en_linea_estado === 'pendiente';
    const pagado = enLinea && p.pago_en_linea_estado === 'pagado';
    if (pagado) delete e.pagos[p.id];
    const texto = porPagar ? '' : textoBase;
    const errorEl = h('p', { class: 'error', role: 'alert' });
    const acciones = [];
    // Pago pendiente: lo primero de la tarjeta es el botón de Bold (no el código ni el QR, que solo sirven una vez pagado).
    // El retorno de Bold (?bold-order-id=NW<número>-…) solo habla del pedido que se acaba de pagar, no de los demás pendientes.
    const vuelveEste = e.volviendoDePago && (!e.pedidoRetorno || e.pedidoRetorno === String(p.numero));
    const aprobadoEnBold = vuelveEste && /^approved$/i.test(e.estadoRetorno);
    const bloquePago = porPagar ? h('section', { class: 'pago-pendiente', 'data-campo': 'pago-pendiente' },
      h('h3', null, 'Falta pagar ', h('span', { class: 'mono' }, fmtCop(p.total_cop))),
      aprobadoEnBold
        ? h('p', { class: 'aviso', role: 'status', 'data-campo': 'pago-confirmando' }, 'Recibimos tu pago y lo estamos confirmando. No lo vuelvas a pagar; esta página se actualiza sola.')
        : vuelveEste
          ? h('p', { class: 'aviso error', role: 'status', 'data-campo': 'pago-no-completado' }, 'Todavía no vemos un pago aprobado para este pedido. Si ya pagaste, espera un momento y no vuelvas a pagar; si no, toca "Pagar ahora".')
          : h('p', { class: 'pequeno' }, 'Toca el botón para pagar con tarjeta, PSE, Nequi o Bancolombia. Empezamos a preparar tu pedido cuando se confirme el pago. Si ya pagaste, espera un momento y no vuelvas a pagar.'),
      e.pagos[p.id] || null,
      !e.pagos[p.id] ? h('button', { type: 'button', class: aprobadoEnBold ? 'btn btn-texto' : 'btn btn-primario', 'data-accion': 'pagar-ahora', onclick: () => iniciarPago(p, errorEl) },
        aprobadoEnBold ? '¿No terminaste de pagar? Intentar de nuevo' : 'Pagar ahora') : null) : null;
    if (abiertoP && !p.en_camino_en) {
      acciones.push(h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'en-camino', onclick: () => accion(() => api.voyEnCamino(p.id), errorEl, refrescarPedidos) }, 'Voy en camino'));
    }
    if (p.estado === 'recibido') {
      acciones.push(h('button', { type: 'button', class: 'btn', 'data-accion': 'cancelar-pedido', onclick: () => accion(() => api.cancelarPedido(p.id), errorEl, refrescarPedidos) }, 'Cancelar pedido'));
    }
    return h('article', { class: 'pedido estado-' + p.estado, 'data-pedido': p.id, 'data-numero': p.numero },
      h('header', null, h('strong', null, 'Pedido #' + p.numero), h('span', { class: 'marca', 'data-campo': 'estado' }, titulo)),
      bloquePago,
      texto ? h('p', null, texto) : null,
      pagado ? h('p', { class: 'ok', 'data-campo': 'pago-confirmado' }, 'Pago confirmado. ¡Gracias!') : null,
      h('p', { class: 'ventana' }, 'Recógelo entre las ' + horaBogota(p.ventana_inicio) + ' y las ' + horaBogota(p.ventana_fin)),
      p.en_camino_en && abiertoP ? h('p', { class: 'ok', 'data-campo': 'en-camino' }, 'Avisaste que vas en camino.') : null,
      abiertoP && !porPagar
        ? h('div', { class: 'reclamo' },
            h('p', { class: 'pequeno' }, 'Muestra este código al recoger'),
            h('p', { class: 'codigo mono', 'data-campo': 'codigo' }, p.codigo),
            h('div', { class: 'qr', 'data-campo': 'qr' }, qrSvg('NAIDI-PW-' + p.numero + '-' + p.codigo, 5)))
        : null,
      h('ul', { class: 'lineas' }, p.lineas.map((l) => {
        const partes = [];
        if (l.tamano) partes.push(TAMANOS[l.tamano] || l.tamano);
        if (l.toppings && l.toppings.length) partes.push(l.toppings.map((t) => t.nombre).join(', '));
        return h('li', { class: 'linea' }, h('div', null, h('strong', null, (l.cantidad > 1 ? l.cantidad + ' × ' : '') + l.producto_nombre), partes.length ? h('small', null, partes.join(' · ')) : null),
          h('span', { class: 'mono' }, fmtCop(l.precio_unitario_cop * l.cantidad)));
      })),
      p.cortesia_toppings && p.cortesia_toppings.length ? h('p', { class: 'cortesia-linea' }, 'Cortesía: ' + p.cortesia_toppings.map((t) => t.nombre).join(', ')) : null,
      h('p', { class: 'total' }, 'Total ', h('strong', { class: 'mono' }, fmtCop(p.total_cop)), p.metodo_pago === 'en_linea' ? ' · pago en línea' : ' · pagas al recoger'),
      acciones.length ? h('div', { class: 'fila-botones' }, acciones) : null,
      errorEl);
  }

  function pantallaPedidos() {
    // Lo que falta pagar va primero: es lo único que la persona debe hacer ahora.
    const porPagar = (p) => p.metodo_pago === 'en_linea' && p.pago_en_linea_estado === 'pendiente';
    const abiertos = e.pedidos.filter((p) => ABIERTOS.includes(p.estado)).sort((a, b) => (porPagar(b) ? 1 : 0) - (porPagar(a) ? 1 : 0));
    const cerrados = e.pedidos.filter((p) => !ABIERTOS.includes(p.estado));
    return h('div', { class: 'pagina' },
      cabecera(),
      h('main', { class: 'contenido' },
        h('h1', null, 'Mis pedidos'),
        e.nuevo ? h('p', { class: 'ok', role: 'status', 'data-campo': 'pedido-creado' }, '¡Listo! Recibimos tu pedido #' + e.nuevo + '.') : null,
        e.error ? h('p', { class: 'error', role: 'alert', 'data-campo': 'error' }, e.error) : null,
        !e.pedidos.length ? h('p', { class: 'vacio' }, 'Todavía no has pedido. ¡Mira el menú!') : null,
        abiertos.map(tarjetaPedido),
        cerrados.length ? h('h2', null, 'Anteriores') : null,
        cerrados.map(tarjetaPedido),
        h('button', { type: 'button', class: 'btn btn-texto', 'data-accion': 'salir', onclick: salir }, 'Salir')));
  }

  // Lo propio de la cuenta para pedir (pedidos abiertos, cortesía, restricción). Devuelve true si cambió algo.
  async function refrescarMia() {
    if (!e.sesion || !e.perfil || !e.perfil.acepta_datos) return false;
    try {
      const antes = JSON.stringify(e.mia);
      e.mia = await api.miTienda();
      return antes !== JSON.stringify(e.mia);
    } catch (x) { return false; }   // sin conexión: se conserva lo último que se sabía
  }

  async function refrescarPedidos() {
    try {
      e.pedidos = (await api.misPedidos()) || [];
      e.error = '';
    } catch (x) {
      e.error = mensajeError(x);
    }
    await refrescarMia();
    if (e.pantalla === 'pedidos') pintar();
  }

  async function abrirPedidos() {
    e.pantalla = 'pedidos';
    try { if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0); } catch (x) { /* jsdom */ }
    await refrescarPedidos();
    iniciarSondeo();
    pintar();
    if (!e.volviendoDePago) verificarPagos().then(refrescarPedidos);   // al volver de Bold ya se verifica aparte
  }

  // Si la persona ya intentó pagar (o volvió de Bold) y el pago sigue pendiente, se le pregunta a Bold por el estado real
  // (cada 8 s como máximo por pedido). Sirve cuando el webhook tarda o no llega; el servidor decide si lo acredita.
  async function verificarPagos() {
    const t = ahora().getTime();
    for (const p of e.pedidos) {
      const pend = p.metodo_pago === 'en_linea' && p.pago_en_linea_estado === 'pendiente' && ABIERTOS.includes(p.estado);
      if (!pend) continue;
      // Cada pedido pendiente se revisa al menos una vez al abrir "Mis pedidos": la persona pudo pagar en Bold y cerrar la
      // pestaña sin volver (ese intento no se ve desde aquí). Sin intento de pago el servidor no consulta a Bold.
      const intentoEnSesion = e.volviendoDePago || e.pagos[p.id];
      if (!intentoEnSesion && e.revisados[p.id]) continue;
      e.revisados[p.id] = true;
      if (t - (e.ultimaVerificacion[p.id] || 0) < 8000) continue;
      e.ultimaVerificacion[p.id] = t;
      try { await api.verificarPagoBold(p.id); } catch (x) { /* el sondeo normal sigue */ }
    }
  }

  function iniciarSondeo() {
    if (e.temporizador) return;
    e.temporizador = cadaTanto(() => {
      if (e.pantalla !== 'pedidos') { detenerSondeo(); return; }
      verificarPagos().then(refrescarPedidos);
    }, intervaloMs);
  }
  function detenerSondeo() { if (e.temporizador) { parar(e.temporizador); e.temporizador = null; } }

  // ------------------------------------------------------------------ Acceso y consentimiento (la misma cuenta que /cuenta)
  function pantallaAcceso() {
    const errorEl = h('p', { class: 'error', role: 'alert', 'data-campo': 'error' }, e.error);
    const formCorreo = h('form', { class: 'form-acceso', 'data-form': 'correo', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      const correo = String(new FormData(ev.target).get('correo') || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) { errorEl.textContent = 'Revisa tu correo: parece que le falta algo.'; return; }
      await accion(async () => { await api.enviarCodigo(correo); e.correo = correo; e.paso = 'codigo'; e.error = ''; }, errorEl, pintar);
    } },
      h('label', null, 'Tu correo', h('input', { type: 'email', name: 'correo', autocomplete: 'email', inputmode: 'email', value: e.correo, 'data-campo': 'correo' })),
      h('button', { type: 'submit', class: 'btn btn-primario', 'data-accion': 'enviar-codigo' }, 'Enviarme un código'));
    const formCodigo = h('form', { class: 'form-acceso', 'data-form': 'codigo', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      const codigo = String(new FormData(ev.target).get('codigo') || '').replace(/\s+/g, '');
      if (!/^\d{6}$/.test(codigo)) { errorEl.textContent = 'El código tiene 6 números.'; return; }
      await accion(async () => { await api.verificarCodigo(e.correo, codigo); e.sesion = await api.sesion(); e.error = ''; }, errorEl, continuarConSesion);
    } },
      h('p', null, 'Te enviamos un código de 6 números a ', h('strong', null, e.correo), '. Puede tardar un minuto; revisa también el spam.'),
      h('label', null, 'Código', h('input', { type: 'text', name: 'codigo', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, 'data-campo': 'codigo' })),
      h('button', { type: 'submit', class: 'btn btn-primario', 'data-accion': 'verificar-codigo' }, 'Entrar'),
      h('button', { type: 'button', class: 'btn btn-texto', 'data-accion': 'cambiar-correo', onclick: () => { e.paso = 'correo'; e.error = ''; pintar(); } }, 'Cambiar correo'));
    return h('div', { class: 'pagina' }, cabecera(),
      h('main', { class: 'contenido acceso' },
        h('h1', null, 'Entra para pedir'),
        h('p', null, 'Usamos tu cuenta Naidí para guardar tu pedido y sumar tus puntos.'),
        e.paso === 'correo' ? formCorreo : formCodigo,
        errorEl,
        googleActivo && e.paso === 'correo'
          ? h('button', { type: 'button', class: 'btn btn-google', 'data-accion': 'google', onclick: () => accion(() => api.entrarConGoogle(), errorEl) }, 'Continuar con Google') : null,
        h('button', { type: 'button', class: 'btn btn-texto', 'data-accion': 'volver', onclick: () => { e.pantalla = e.carrito.length ? 'carrito' : 'menu'; pintar(); } }, 'Volver')));
  }

  function pantallaConsentimiento() {
    const errorEl = h('p', { class: 'error', role: 'alert', 'data-campo': 'error' });
    const datos = h('input', { type: 'checkbox', name: 'datos', 'data-campo': 'acepta-datos' });
    const boton = h('button', { type: 'submit', class: 'btn btn-primario', disabled: true, 'data-accion': 'aceptar' }, 'Continuar');
    datos.addEventListener('change', () => { boton.disabled = !datos.checked; });
    return h('div', { class: 'pagina' }, cabecera(),
      h('main', { class: 'contenido acceso' },
        h('h1', null, 'Antes de pedir'),
        h('p', null, 'Necesitamos tu autorización para tratar tus datos personales (Ley 1581 de 2012).'),
        h('form', { class: 'form-acceso', 'data-form': 'consentimiento', onsubmit: async (ev) => {
          ev.preventDefault();
          if (!datos.checked) return;
          await accion(async () => { await api.consentir('datos', e.perfil.privacidad_version, true); }, errorEl, continuarConSesion);
        } },
          h('label', { class: 'casilla' }, datos,
            h('span', null, 'Autorizo a Naidi a tratar mis datos (nombre, correo, pedidos y puntos), según la ',
              h('a', { href: '/privacidad/', target: '_blank', rel: 'noopener' }, 'política de privacidad'), '.')),
          boton),
        errorEl));
  }

  // ------------------------------------------------------------------ Armado
  function pintar() {
    // Repintar reconstruye todo el DOM: se guarda y se restaura el desplazamiento para que, al elegir un topping,
    // la hoja y la página no salten al inicio.
    const hojaPrevia = raiz.querySelector ? raiz.querySelector('.hoja') : null;
    const desplazaHoja = hojaPrevia ? hojaPrevia.scrollTop : 0;
    const desplazaPagina = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
    const mismaPantalla = e.pantallaPintada === e.pantalla;
    vaciar(raiz);
    let pantalla;
    if (e.pantalla === 'cargando') pantalla = h('p', { class: 'cargando', role: 'status' }, 'Cargando…');
    else if (e.pantalla === 'error') pantalla = h('main', { class: 'contenido' }, marca(), h('p', { class: 'error', role: 'alert', 'data-campo': 'error' }, e.error),
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'reintentar', onclick: () => iniciar() }, 'Reintentar'));
    else if (e.pantalla === 'acceso') pantalla = pantallaAcceso();
    else if (e.pantalla === 'consentimiento') pantalla = pantallaConsentimiento();
    else if (e.pantalla === 'carrito') pantalla = pantallaCarrito();
    else if (e.pantalla === 'pedidos') pantalla = pantallaPedidos();
    else pantalla = pantallaMenu();
    agregar(raiz, pantalla, e.hoja ? hoja() : null);
    e.pantallaPintada = e.pantalla;
    const hojaNueva = e.hoja && raiz.querySelector('.hoja');
    if (hojaNueva && hojaPrevia) hojaNueva.scrollTop = desplazaHoja;
    try {
      if (typeof window !== 'undefined' && window.scrollTo) {
        if (mismaPantalla) { if (desplazaPagina) window.scrollTo(0, desplazaPagina); }
        else window.scrollTo(0, 0);   // pantalla nueva: se empieza arriba; si no, el navegador conserva el desplazamiento de la anterior y tapa los títulos
      }
    } catch (x) { /* jsdom */ }
  }

  async function continuarConSesion() {
    try {
      e.perfil = await api.perfil();
      if (!e.perfil.acepta_datos) { e.pantalla = 'consentimiento'; pintar(); return; }
      e.mia = await api.miTienda();
    } catch (x) {
      e.pantalla = 'error';
      e.error = mensajeError(x);
      pintar();
      return;
    }
    e.pantalla = e.volverA === 'carrito' && e.carrito.length ? 'carrito' : 'menu';
    if (e.pantalla === 'carrito') prepararFormulario();
    pintar();
  }

  async function salir() {
    detenerSondeo();
    try { await api.salir(); } catch (x) { /* ok */ }
    Object.assign(e, { sesion: null, perfil: null, mia: null, pedidos: [], nuevo: null, paso: 'correo', correo: '', error: '', pantalla: 'menu' });
    pintar();
  }

  async function iniciar() {
    e.pantalla = 'cargando';
    pintar();
    try {
      const [datos, estado] = await Promise.all([api.catalogo(), api.estado()]);
      e.cat = crearCatalogo(datos);
      e.estado = estado;
    } catch (x) {
      e.pantalla = 'error';
      e.error = mensajeError(x);
      pintar();
      return;
    }
    e.carrito = leerCarrito();
    try { e.sesion = await api.sesion(); } catch (x) { e.sesion = null; }
    if (e.sesion) {
      try { e.perfil = await api.perfil(); if (e.perfil.acepta_datos) e.mia = await api.miTienda(); } catch (x) { /* se reintenta al pedir */ }
    }
    e.pantalla = 'menu';
    // Si vuelve de Bold, la redirección solo indica que pasó por la pasarela: el pago lo confirma el servidor.
    if (e.sesion && /[?&]bold-order-id=/.test(leerBusqueda())) {
      e.volviendoDePago = true;
      const m = /[?&]bold-tx-status=([^&]*)/.exec(leerBusqueda());
      e.estadoRetorno = m ? decodeURIComponent(m[1]) : '';
      const n = /[?&]bold-order-id=NW(\d+)-/.exec(leerBusqueda());
      e.pedidoRetorno = n ? n[1] : '';
      await abrirPedidos();
      await verificarPagos();
      await refrescarPedidos();
      return;
    }
    pintar();
  }

  return { iniciar, estado: e, refrescarPedidos, ventanasDisponibles };
}
