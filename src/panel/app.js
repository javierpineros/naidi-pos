// Armazón del panel del dueño: acceso (correo + código + segundo factor, solo rol dueño), pestañas y renovación periódica.
import { h, vaciar, agregar } from '../lib/dom.js';
import { montarAcceso } from '../pos/ui/acceso.js';
import { pedirTexto, pedirPin } from '../pos/ui/modal.js';
import { mensajePin } from '../pos/ui/caja.js';
import { crearVistaAlertas } from './ui/alertas.js';
import { crearVistaCuentas } from './ui/cuentas.js';
import { crearVistaPantallas } from './ui/pantallas.js';
import { crearVistaPagos } from './ui/pagos.js';

const ROTULOS = { alertas: 'Alertas', cuentas: 'Cuentas', pantallas: 'Pantallas', pagos: 'Pagos Bold' };

export function crearPanel(cfg) {
  const { raiz, api } = cfg;
  const ahora = cfg.ahora || (() => new Date());
  const cadaTanto = cfg.setInterval || ((fn, ms) => setInterval(fn, ms));
  const luego = cfg.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const intervalo = cfg.intervalo || 30000;

  const estado = { correo: '', temporizadores: [], conteos: {} };
  const vistas = {};
  const pestanas = [];
  const avisos = h('div', { class: 'avisos', role: 'status', 'aria-live': 'polite' });
  const cabecera = h('header', { class: 'cabecera' });
  const nav = h('nav', { class: 'pestanas', 'aria-label': 'Secciones del panel' });
  const principal = h('main', { class: 'principal' });

  const ctx = {
    api,
    ahora,
    origen: cfg.origen || (() => (typeof location === 'undefined' ? '' : location.origin)),
    avisar(mensaje, tipo) {
      const a = h('p', { class: 'aviso-flotante ' + (tipo || 'ok') }, mensaje);
      avisos.append(a);
      luego(() => { if (a.parentNode) a.parentNode.removeChild(a); }, tipo === 'error' ? 8000 : 4000);
    },
    // Número de pendientes junto al rótulo de la pestaña.
    marcarConteo(nombre, n) {
      estado.conteos[nombre] = n;
      const p = pestanas.find((x) => x.nombre === nombre);
      if (p) p.boton.textContent = ROTULOS[nombre] + (n ? ' (' + n + ')' : '');
    },
    irA(nombre) {
      if (!vistas[nombre]) return;
      for (const [n, v] of Object.entries(vistas)) v.el.hidden = n !== nombre;
      for (const p of pestanas) p.boton.classList.toggle('activa', p.nombre === nombre);
      vistas[nombre].refrescar();
    },
    // Una decisión en una vista puede cambiar lo que muestran las demás (por ejemplo, restringir resuelve una alerta).
    refrescarTodo: () => Promise.all(Object.values(vistas).map((v) => v.refrescar())),
  };

  function pintarCabecera() {
    agregar(vaciar(cabecera),
      h('strong', { class: 'marca-pos' }, 'Panel del dueño'),
      h('span', { class: 'relleno' }),
      h('span', { class: 'pequeno' }, estado.correo),
      h('button', { type: 'button', class: 'btn', 'data-accion': 'mi-pin', onclick: () => fijarPin() }, 'Mi PIN'),
      h('button', { type: 'button', class: 'btn', 'data-accion': 'salir', onclick: salir }, 'Salir'));
  }

  // Crear o cambiar el PIN. Si ya hay uno, se pide el actual; el servidor cuenta los intentos fallidos.
  async function fijarPin() {
    let tiene;
    try { tiene = await api.tengoPin(); } catch (e) { ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo revisar tu PIN.' : e.message, 'error'); return; }
    let actual = null;
    if (tiene) {
      actual = await pedirPin('PIN actual');
      if (!actual) return;
    }
    const pedirNuevo = (titulo, etiqueta) => pedirTexto({ titulo, etiqueta, boton: 'Seguir', tipo: 'password', inputmode: 'numeric' });
    const nuevo = await pedirNuevo(tiene ? 'Nuevo PIN' : 'Crea tu PIN', 'PIN nuevo (4 a 8 dígitos)');
    if (!nuevo) return;
    if (!/^[0-9]{4,8}$/.test(nuevo)) { ctx.avisar('El PIN debe tener entre 4 y 8 dígitos, solo números.', 'error'); return; }
    const repetido = await pedirNuevo('Repite el PIN', 'Escríbelo otra vez');
    if (!repetido) return;
    if (repetido !== nuevo) { ctx.avisar('Los dos PIN no coinciden. No se cambió nada.', 'error'); return; }
    let r;
    try { r = await api.fijarPin(nuevo, actual); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    if (r && r.ok === false) { ctx.avisar(mensajePin(r), 'error'); return; }
    avisoSinPin.hidden = true;
    ctx.avisar(tiene ? 'PIN cambiado.' : 'PIN creado. Ya puedes usarlo en las decisiones sensibles.', 'ok');
  }

  // Sin PIN el panel no deja decidir nada sensible: se avisa de entrada, con el botón a mano.
  const avisoSinPin = h('div', { class: 'tarjeta', 'data-zona': 'sin-pin' },
    h('p', { class: 'alerta-texto' }, 'Aún no tienes un PIN.'),
    h('p', { class: 'pequeno' }, 'Lo pide el panel para restringir cuentas y emitir o revocar pantallas.'),
    h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'crear-pin', onclick: () => fijarPin() }, 'Crear mi PIN'));
  async function revisarPin() {
    try { avisoSinPin.hidden = await api.tengoPin(); } catch (e) { avisoSinPin.hidden = true; }
  }

  async function salir() {
    for (const t of estado.temporizadores) clearInterval(t);
    estado.temporizadores = [];
    await api.salir();
    iniciar();
  }

  async function iniciarSesion({ ses }) {
    estado.correo = ses ? ses.email : '';
    for (const k of Object.keys(vistas)) delete vistas[k];
    pestanas.length = 0;
    vistas.alertas = crearVistaAlertas(ctx);
    vistas.cuentas = crearVistaCuentas(ctx);
    vistas.pantallas = crearVistaPantallas(ctx);
    vistas.pagos = crearVistaPagos(ctx);
    vaciar(nav);
    for (const nombre of Object.keys(vistas)) {
      const boton = h('button', { type: 'button', class: 'pestana', 'data-pestana': nombre, onclick: () => ctx.irA(nombre) }, ROTULOS[nombre]);
      pestanas.push({ nombre, boton });
      nav.append(boton);
    }
    vaciar(principal);
    for (const v of Object.values(vistas)) principal.append(v.el);
    pintarCabecera();
    vaciar(raiz).append(cabecera, nav, avisos, avisoSinPin, principal);
    avisoSinPin.hidden = true;
    revisarPin();
    ctx.irA('alertas');
    // Las demás vistas cargan al abrirlas; aquí se trae lo que lleva número en su pestaña.
    await Promise.all([vistas.pagos.refrescar()]);
    estado.temporizadores.push(cadaTanto(() => { vistas.alertas.refrescar(); vistas.pagos.refrescar(); }, intervalo));
  }

  function iniciar() {
    vaciar(raiz);
    montarAcceso({ api, contenedor: raiz, alListo: iniciarSesion, titulo: 'Panel Naidi', soloDueno: true });
  }

  return { iniciar, ctx, estado, vistas };
}
