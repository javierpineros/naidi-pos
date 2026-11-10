// Armazón del POS: acceso, pestañas, estado de conexión, cola sin internet, sonido y sondeo de la lista de espera.
import { h, vaciar, agregar } from '../lib/dom.js';
import { crearCatalogo } from '../lib/precio.js';
import { montarAcceso } from './ui/acceso.js';
import { crearVistaEspera } from './ui/espera.js';
import { crearVistaVenta } from './ui/venta.js';
import { crearVistaRappi } from './ui/rappi.js';
import { crearVistaCaja } from './ui/caja.js';
import { crearVistaReportes } from './ui/reportes.js';

export function crearPos(cfg) {
  const { raiz, api, cola, sonido } = cfg;
  const enLinea = cfg.enLinea || (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const ahora = cfg.ahora || (() => new Date());
  const cadaTanto = cfg.setInterval || ((fn, ms) => setInterval(fn, ms));
  const luego = cfg.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const intervalos = { espera: 5000, cola: 15000, ...(cfg.intervalos || {}) };
  const cacheCatalogo = cfg.cacheCatalogo || { leer: () => null, escribir: () => {} };

  const estado = { rol: null, correo: '', conectado: true, pendientes: 0, destino: null, espera: [], pestana: 'espera', temporizadores: [] };
  const vistas = {};
  const pestanas = [];
  const avisos = h('div', { class: 'avisos', role: 'status', 'aria-live': 'polite' });
  const cabecera = h('header', { class: 'cabecera' });
  const nav = h('nav', { class: 'pestanas', 'aria-label': 'Secciones' });
  const principal = h('main', { class: 'principal' });
  let cat = null;

  const ctx = {
    api, cola, sonido,
    get cat() { return cat; },
    esDueno: () => estado.rol === 'dueno',
    enLinea,
    ahora,
    origen: cfg.origen || (() => (typeof location === 'undefined' ? '' : location.origin)),
    destino: () => estado.destino,
    espera: () => estado.espera,
    setEspera(lista) { estado.espera = lista || []; },
    vista: (n) => vistas[n],
    irA(nombre) {
      if (!vistas[nombre]) return;
      estado.pestana = nombre;
      for (const [n, v] of Object.entries(vistas)) v.el.hidden = n !== nombre;
      for (const p of pestanas) p.boton.classList.toggle('activa', p.nombre === nombre);
      if (nombre === 'caja' || nombre === 'espera') vistas[nombre].refrescar();
    },
    avisar(mensaje, tipo) {
      const a = h('p', { class: 'aviso-flotante ' + (tipo || 'ok') }, mensaje);
      avisos.append(a);
      luego(() => { if (a.parentNode) a.parentNode.removeChild(a); }, tipo === 'error' ? 8000 : 4000);
    },
    marcarConexion(ok) {
      const antes = estado.conectado;
      estado.conectado = ok;
      pintarCabecera();
      if (ok && !antes) sincronizarCola();
    },
    avisarCola() { actualizarPendientes(); },
    refrescarEspera: () => (vistas.espera ? vistas.espera.refrescar() : Promise.resolve()),
  };

  // ---------------------------------------------------------------- Cabecera
  function pintarCabecera() {
    agregar(vaciar(cabecera),
      h('strong', { class: 'marca-pos' }, 'Naidi POS'),
      h('span', { class: 'pastilla ' + (estado.conectado && enLinea() ? 'en-linea' : 'sin-conexion'), 'data-campo': 'conexion' },
        estado.conectado && enLinea() ? 'En línea' : 'Sin conexión'),
      estado.pendientes
        ? h('span', { class: 'pastilla pendiente', 'data-campo': 'pendientes' }, estado.pendientes + (estado.pendientes === 1 ? ' venta por enviar' : ' ventas por enviar'))
        : null,
      h('span', { class: 'relleno' }),
      h('button', { type: 'button', class: 'btn' + (sonido.activo() ? '' : ' btn-primario'), 'data-accion': 'activar-sonido', disabled: sonido.activo(),
        onclick: () => { const ok = sonido.activar(); ctx.avisar(ok ? 'Sonido activado.' : 'Este navegador no permite el sonido.', ok ? 'ok' : 'error'); pintarCabecera(); } },
        sonido.activo() ? 'Sonido activo' : 'Activar sonido'),
      h('span', { class: 'pequeno' }, estado.correo),
      h('button', { type: 'button', class: 'btn', 'data-accion': 'salir', onclick: salir }, 'Salir'));
  }

  async function salir() {
    for (const t of estado.temporizadores) clearInterval(t);
    estado.temporizadores = [];
    if (estado.desuscribir) { try { estado.desuscribir(); } catch (e) { /* ok */ } }
    await api.salir();
    iniciar();
  }

  // ---------------------------------------------------------------- Cola sin internet
  async function actualizarPendientes() {
    estado.pendientes = (await cola.pendientes()).length;
    pintarCabecera();
  }

  async function sincronizarCola() {
    const pendientes = await cola.pendientes();
    if (!pendientes.length) { await actualizarPendientes(); return; }
    const r = await cola.sincronizar(api);
    if (r.enviadas || r.duplicadas) ctx.avisar((r.enviadas + r.duplicadas) + ' venta(s) hechas sin internet ya quedaron registradas.', 'ok');
    if (r.rechazadas) ctx.avisar(r.rechazadas + ' venta(s) sin internet fueron rechazadas por el servidor; el dueño debe revisarlas.', 'error');
    if (r.sinConexion) { estado.conectado = false; }
    await actualizarPendientes();
  }

  // ---------------------------------------------------------------- Turno
  async function cargarCatalogo() {
    try {
      const datos = await api.catalogo();
      cacheCatalogo.escribir(datos);
      return datos;
    } catch (e) {
      const guardado = cacheCatalogo.leer();
      if (e.name === 'ErrorRed' && guardado) { estado.conectado = false; return guardado; }
      throw e;
    }
  }

  async function iniciarTurno({ ses, perfil }) {
    estado.rol = perfil.rol;
    estado.correo = ses ? ses.email : '';
    vaciar(raiz);
    let datos;
    try {
      datos = await cargarCatalogo();
    } catch (e) {
      raiz.append(h('p', { class: 'error', role: 'alert' }, 'No pude cargar el catálogo: ' + e.message));
      return;
    }
    cat = crearCatalogo(datos);
    try { estado.destino = await api.destinoTransferencia(); } catch (e) { estado.destino = null; }

    for (const k of Object.keys(vistas)) delete vistas[k];
    pestanas.length = 0;
    vistas.espera = crearVistaEspera(ctx);
    vistas.venta = crearVistaVenta(ctx);
    vistas.rappi = crearVistaRappi(ctx);
    vistas.caja = crearVistaCaja(ctx);
    if (ctx.esDueno()) vistas.reportes = crearVistaReportes(ctx);

    const rotulos = { espera: 'Espera', venta: 'Venta', rappi: 'Rappi', caja: 'Caja', reportes: 'Reportes' };
    vaciar(nav);
    for (const nombre of Object.keys(vistas)) {
      const boton = h('button', { type: 'button', class: 'pestana', 'data-pestana': nombre, onclick: () => ctx.irA(nombre) }, rotulos[nombre]);
      pestanas.push({ nombre, boton });
      nav.append(boton);
    }
    vaciar(principal);
    for (const v of Object.values(vistas)) principal.append(v.el);
    // Al abrir el turno se pide activar el sonido: los navegadores lo bloquean hasta que alguien toca la pantalla.
    pintarCabecera();
    vaciar(raiz).append(cabecera, nav, avisos, principal);
    ctx.irA('espera');

    await Promise.all([vistas.espera.refrescar(), actualizarPendientes()]);
    try { estado.desuscribir = api.suscribirEspera(() => vistas.espera.refrescar()); } catch (e) { estado.desuscribir = null; }
    estado.temporizadores.push(cadaTanto(() => vistas.espera.refrescar(), intervalos.espera));
    estado.temporizadores.push(cadaTanto(() => sincronizarCola(), intervalos.cola));
    if (estado.pendientes && enLinea()) sincronizarCola();
  }

  // ---------------------------------------------------------------- Arranque
  function iniciar() {
    vaciar(raiz);
    pintarCabecera();
    montarAcceso({ api, contenedor: raiz, alListo: iniciarTurno });
  }

  if (typeof window !== 'undefined' && !cfg.sinEventosDeRed) {
    window.addEventListener('online', () => { estado.conectado = true; pintarCabecera(); sincronizarCola(); });
    window.addEventListener('offline', () => { estado.conectado = false; pintarCabecera(); });
  }

  return { iniciar, ctx, estado, sincronizarCola, vistas };
}
