import { crearPos } from '../../src/pos/app.js';
import { crearCola, almacenMemoria } from '../../src/pos/cola.js';
import { crearSonido } from '../../src/pos/sonido.js';

export const esperar = async (n) => {
  for (let i = 0; i < (n || 8); i++) await new Promise((r) => setTimeout(r, 0));
};

// Contexto de audio falso: cuenta cuántas veces "sonó".
export function audioFalso() {
  const reg = { osciladores: 0 };
  const ctx = {
    state: 'running', currentTime: 0, destination: {}, resume() {},
    createOscillator() { reg.osciladores++; return { frequency: {}, connect() {}, start() {}, stop() {} }; },
    createGain() { return { gain: {}, connect() {} }; },
  };
  return { reg, ctx };
}

export async function montarPos(api, opciones) {
  const o = opciones || {};
  document.body.innerHTML = '<div id="app"></div>';
  const raiz = document.getElementById('app');
  const audio = audioFalso();
  let t = 0;
  const sonido = crearSonido({ crearContexto: () => audio.ctx, ahora: () => t, minIntervaloMs: 20000, maxPorMinuto: 3 });
  const cola = crearCola({ almacen: almacenMemoria(), ahora: () => '2026-11-10T15:00:00.000Z' });
  const cache = { v: null, leer() { return this.v; }, escribir(x) { this.v = x; } };
  const pos = crearPos({
    raiz, api, cola, sonido, cacheCatalogo: cache,
    ahora: () => new Date('2026-11-10T15:00:00Z'),
    enLinea: o.enLinea || (() => true),
    origen: () => 'https://pos.naidi.test',
    setInterval: () => 0, setTimeout: () => 0, sinEventosDeRed: true,
  });
  pos.iniciar();
  await esperar();
  return { pos, raiz, cola, sonido, audio, avanzar: (ms) => { t += ms; } };
}

export const $ = (sel, raiz) => (raiz || document).querySelector(sel);
export const $$ = (sel, raiz) => [...(raiz || document).querySelectorAll(sel)];
export async function click(sel, raiz) {
  const el = typeof sel === 'string' ? $(sel, raiz) : sel;
  if (!el) throw new Error('No existe: ' + sel);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await esperar();
}
export async function escribir(sel, valor, raiz) {
  const el = typeof sel === 'string' ? $(sel, raiz) : sel;
  if (!el) throw new Error('No existe: ' + sel);
  el.value = valor;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  await esperar(2);
}
export const fila = (tr) => [...tr.children].map((c) => c.textContent.trim()).join(' ');
export const texto = (sel, raiz) => { const e = $(sel, raiz); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };

// Entra como cajero (correo + código) y deja el POS listo.
export async function entrarComoPersonal(api, opciones) {
  const m = await montarPos(api, opciones);
  await escribir('[data-campo="correo"]', 'cajero@naidi.test');
  await click('[data-accion="enviar-codigo"]');
  await escribir('[data-campo="codigo"]', '123456');
  await click('[data-accion="verificar-codigo"]');
  await esperar(12);
  return m;
}
