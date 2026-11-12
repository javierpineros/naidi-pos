// Pantallas del iPad: emitir (la llave se muestra una sola vez, como enlace de activación), listar y revocar.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fechaCorta, horaBogota } from '../../lib/format.js';
import { pedirTexto, pedirPin, confirmar, modal } from '../../pos/ui/modal.js';
import { mensajePin } from '../../pos/ui/caja.js';

export function crearVistaPantallas(ctx) {
  const el = h('section', { class: 'vista vista-pantallas', 'data-vista': 'pantallas' });
  let lista = [];
  let cargado = false;

  async function refrescar() {
    try {
      lista = (await ctx.api.listarPantallas()) || [];
      cargado = true;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar las pantallas.' : e.message, 'error');
      return;
    }
    pintar();
  }

  // El enlace lleva la llave en el fragmento (#), que el navegador no envía al servidor.
  function mostrarEnlace(nombre, llave) {
    const enlace = ctx.origen() + '/pantalla/#llave=' + llave;
    const m = modal({ titulo: 'Pantalla "' + nombre + '" lista' });
    const campo = h('input', { type: 'text', readonly: true, value: enlace, 'data-campo': 'enlace-activacion', 'aria-label': 'Enlace de activación', class: 'mono' });
    const copiado = h('p', { class: 'pequeno', role: 'status' });
    vaciar(m.cuerpo).append(
      h('p', null, 'Abre este enlace en el iPad para activar la pantalla. ', h('strong', null, 'Se muestra una sola vez: no se puede volver a ver.')),
      campo,
      copiado,
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: 'btn', 'data-accion': 'copiar-enlace', onclick: async () => {
          try { await navigator.clipboard.writeText(enlace); copiado.textContent = 'Enlace copiado.'; } catch (e) { campo.select(); copiado.textContent = 'Selecciona y copia el enlace a mano.'; }
        } }, 'Copiar enlace'),
        h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'cerrar-enlace', onclick: () => m.cerrar() }, 'Ya lo copié')));
    campo.addEventListener('focus', () => campo.select());
  }

  async function emitir() {
    const nombre = await pedirTexto({ titulo: 'Nueva pantalla', etiqueta: 'Nombre (por ejemplo: iPad del mostrador)', boton: 'Seguir' });
    if (!nombre) return;
    const pin = await pedirPin('Confirma con tu PIN: nueva pantalla');
    if (!pin) return;
    let r;
    try { r = await ctx.api.emitirPantalla(nombre, pin); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    if (r && r.ok === false) { ctx.avisar(mensajePin(r), 'error'); return; }
    await refrescar();
    mostrarEnlace(nombre, r.llave);
  }

  async function revocar(p) {
    const ok = await confirmar({ titulo: 'Revocar pantalla', mensaje: 'La pantalla "' + p.nombre + '" dejará de funcionar en cuanto se actualice. ¿Seguimos?', boton: 'Revocar' });
    if (!ok) return;
    const pin = await pedirPin('Confirma con tu PIN: revocar pantalla');
    if (!pin) return;
    let r;
    try { r = await ctx.api.revocarPantalla(p.id, pin); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    if (r && r.ok === false) { ctx.avisar(mensajePin(r), 'error'); return; }
    ctx.avisar('Pantalla revocada.', 'ok');
    await refrescar();
  }

  function pintar() {
    const cuando = (iso) => (iso ? fechaCorta(iso, ctx.ahora()) + ' ' + horaBogota(iso) : 'Nunca');
    vaciar(el);
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Pantallas del iPad'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-pantallas', onclick: refrescar }, 'Actualizar'),
        h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'emitir-pantalla', onclick: emitir }, 'Emitir pantalla nueva')),
      !cargado ? h('p', { class: 'vacio' }, 'Cargando las pantallas…')
        : lista.length
          ? h('table', { class: 'tabla', 'data-tabla': 'pantallas' },
              h('thead', null, h('tr', null, h('th', null, 'Nombre'), h('th', null, 'Estado'), h('th', null, 'Creada'), h('th', null, 'Último uso'), h('th', null, ''))),
              h('tbody', null, lista.map((p) =>
                h('tr', { 'data-pantalla': p.id },
                  h('td', null, p.nombre),
                  h('td', { 'data-campo': 'estado' }, p.activo ? 'Activa' : 'Revocada'),
                  h('td', null, cuando(p.creado_en)),
                  h('td', null, cuando(p.ultimo_uso)),
                  h('td', null, p.activo ? h('button', { type: 'button', class: 'btn', 'data-accion': 'revocar-pantalla', onclick: () => revocar(p) }, 'Revocar') : null)))))
          : h('p', { class: 'vacio', 'data-campo': 'sin-pantallas' }, 'Todavía no has emitido ninguna pantalla.'));
  }

  pintar();
  return { el, refrescar };
}
