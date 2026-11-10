import { h, vaciar } from '../../lib/dom.js';

// Ventana modal simple. Devuelve { el, cuerpo, cerrar }.
export function modal({ titulo, onCerrar } = {}) {
  const cuerpo = h('div', { class: 'modal-cuerpo' });
  const caja = h(
    'div',
    { class: 'modal-caja', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo || 'Ventana' },
    h('div', { class: 'modal-cabeza' }, h('h2', null, titulo || ''), h('button', { class: 'btn-icono', type: 'button', 'data-accion': 'cerrar-modal', 'aria-label': 'Cerrar', onclick: () => cerrar() }, '×')),
    cuerpo
  );
  const el = h('div', { class: 'modal-fondo' }, caja);
  el.addEventListener('click', (e) => {
    if (e.target === el) cerrar();
  });
  function tecla(e) {
    if (e.key === 'Escape') cerrar();
  }
  function cerrar() {
    document.removeEventListener('keydown', tecla);
    if (el.parentNode) el.parentNode.removeChild(el);
    if (onCerrar) onCerrar();
  }
  document.addEventListener('keydown', tecla);
  document.body.appendChild(el);
  return { el, cuerpo, cerrar };
}

// Pide un texto (motivo, número de pedido...). Resuelve con el texto o null si cancelan.
export function pedirTexto({ titulo, etiqueta, boton, tipo, inputmode, obligatorio }) {
  return new Promise((resolver) => {
    let hecho = false;
    const fin = (v) => {
      if (hecho) return;
      hecho = true;
      m.cerrar();
      resolver(v);
    };
    const m = modal({ titulo, onCerrar: () => { if (!hecho) { hecho = true; resolver(null); } } });
    const campo = h('input', { type: tipo || 'text', inputmode: inputmode || null, autocomplete: 'off', 'data-campo': 'texto', 'aria-label': etiqueta });
    const error = h('p', { class: 'error', role: 'alert' });
    const enviar = () => {
      const v = campo.value.trim();
      if (obligatorio !== false && !v) {
        error.textContent = 'Escribe algo para continuar.';
        return;
      }
      fin(v);
    };
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
    vaciar(m.cuerpo).append(
      h('label', null, etiqueta, campo),
      error,
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: 'btn', 'data-accion': 'cancelar-texto', onclick: () => fin(null) }, 'Cancelar'),
        h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'aceptar-texto', onclick: enviar }, boton || 'Aceptar'))
    );
    campo.focus();
  });
}

export const pedirPin = (titulo) =>
  pedirTexto({ titulo: titulo || 'Confirma con tu PIN', etiqueta: 'PIN del dueño', boton: 'Confirmar', tipo: 'password', inputmode: 'numeric' });

export function confirmar({ titulo, mensaje, boton }) {
  return new Promise((resolver) => {
    let hecho = false;
    const fin = (v) => {
      if (hecho) return;
      hecho = true;
      m.cerrar();
      resolver(v);
    };
    const m = modal({ titulo, onCerrar: () => { if (!hecho) { hecho = true; resolver(false); } } });
    vaciar(m.cuerpo).append(
      h('p', null, mensaje),
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: 'btn', 'data-accion': 'no-confirmar', onclick: () => fin(false) }, 'No'),
        h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'si-confirmar', onclick: () => fin(true) }, boton || 'Sí'))
    );
  });
}
