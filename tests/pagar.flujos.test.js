import { describe, it, expect, afterEach } from 'vitest';
import { crearPagar } from '../src/pagar/app.js';
import { ErrorRed, ErrorServidor } from '../src/lib/errores.js';

const CODIGO = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const esperar = async (n) => { for (let i = 0; i < (n || 8); i++) await new Promise((r) => setTimeout(r, 0)); };
const texto = () => document.body.textContent;

const DATOS_BOTON = { apiKey: 'llave-id', orderId: 'V57-abcdef0123', amount: 21500, currency: 'COP', integritySignature: 'f'.repeat(64), redirectionUrl: 'https://naidi.test/pagar/?c=' + CODIGO };

// Reloj falso: guarda lo programado y lo corre a mano.
function montar(o) {
  const op = o || {};
  document.body.innerHTML = '<div id="app"></div>';
  const programados = [];
  const llamadas = [];
  const estados = (op.estados || [{ estado: 'abierta', total_cop: 21500 }]).slice();
  const api = {
    iniciarPago: async (c) => { llamadas.push(['iniciarPago', c]); if (op.errorInicio) throw op.errorInicio; return DATOS_BOTON; },
    estado: async (c) => {
      llamadas.push(['estado', c]);
      const r = estados.length > 1 ? estados.shift() : estados[0];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const pagar = crearPagar({
    raiz: document.getElementById('app'), api,
    leerHash: () => op.hash === undefined ? '#' + CODIGO : op.hash,
    leerBusqueda: () => op.busqueda || '',
    setTimeout: (fn) => { programados.push(fn); return programados.length; },
    maxVerificaciones: op.max || 45,
  });
  const correr = async () => { const fn = programados.shift(); if (fn) { fn(); await esperar(); } return !!fn; };
  return { pagar, llamadas, programados, correr };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('/pagar: pago con QR de una venta del POS', () => {
  it('con el código del QR muestra el total y el botón de Bold con lo que firmó el servidor', async () => {
    const m = montar();
    m.pagar.iniciar();
    await esperar();
    expect(texto()).toContain('Paga tu compra');
    expect(document.querySelector('[data-campo="total"]').textContent).toMatch(/21\.500/);
    const s = document.querySelector('[data-campo="boton-bold"] script');
    expect(s.getAttribute('data-api-key')).toBe('llave-id');
    expect(s.getAttribute('data-order-id')).toBe('V57-abcdef0123');
    expect(s.getAttribute('data-amount')).toBe('21500');
    expect(s.getAttribute('data-integrity-signature')).toBe('f'.repeat(64));
    expect(s.getAttribute('data-redirection-url')).toBe('https://naidi.test/pagar/?c=' + CODIGO);
    expect(m.llamadas).toEqual([['estado', CODIGO], ['iniciarPago', CODIGO]]);
  });

  it('sin código válido no llama a nadie', async () => {
    for (const hash of ['', '#corto', '#' + CODIGO + 'x']) {
      const m = montar({ hash });
      m.pagar.iniciar();
      await esperar();
      expect(texto()).toContain('Escanea el código del iPad');
      expect(m.llamadas).toEqual([]);
    }
  });

  it('al volver de Bold toma el código de ?c= y espera la confirmación sin mostrar otro botón de pago', async () => {
    const m = montar({ hash: '', busqueda: '?c=' + CODIGO + '&bold-order-id=V57-abc&bold-tx-status=approved' });
    m.pagar.iniciar();
    await esperar();
    expect(texto()).toContain('Estamos confirmando tu pago');
    expect(document.querySelector('[data-campo="boton-bold"]')).toBeNull();
    expect(m.llamadas.some((l) => l[0] === 'iniciarPago')).toBe(false);
  });

  it('cuando el servidor dice que ya está pagada, la página lo celebra y deja de preguntar', async () => {
    const m = montar({ estados: [{ estado: 'abierta', total_cop: 21500 }, { estado: 'pagada', total_cop: 21500 }] });
    m.pagar.iniciar();
    await esperar();
    expect(document.querySelector('[data-campo="boton-bold"]')).not.toBeNull();
    await m.correr();
    expect(texto()).toContain('Pago recibido');
    expect(m.programados.length).toBe(0);
  });

  it('el botón no se reinicia mientras se sigue preguntando', async () => {
    const m = montar();
    m.pagar.iniciar();
    await esperar();
    const antes = document.querySelector('[data-campo="boton-bold"]');
    await m.correr();
    await m.correr();
    expect(document.querySelector('[data-campo="boton-bold"]')).toBe(antes);
    expect(m.llamadas.filter((l) => l[0] === 'iniciarPago').length).toBe(1);
  });

  it('si el vendedor está modificando el pedido no ofrece pagar y sigue sola cuando lo confirma', async () => {
    const m = montar({ estados: [{ estado: 'actualizando', total_cop: null }, { estado: 'abierta', total_cop: 31500 }] });
    m.pagar.iniciar();
    await esperar();
    expect(texto()).toContain('Estamos actualizando tu pedido');
    expect(document.querySelector('[data-campo="boton-bold"]')).toBeNull();
    await m.correr();
    expect(texto()).toContain('Paga tu compra');
    expect(document.querySelector('[data-campo="total"]').textContent).toMatch(/31\.500/);
  });

  it('un código inválido o una compra cerrada se explican y no se vuelve a preguntar', async () => {
    for (const [estado, frase] of [['invalido', 'no es válido'], ['cerrada', 'ya no está abierta']]) {
      const m = montar({ estados: [{ estado }] });
      m.pagar.iniciar();
      await esperar();
      expect(texto()).toContain(frase);
      expect(m.programados.length).toBe(0);
    }
  });

  it('si el servidor rechaza iniciar el pago, muestra su mensaje y no deja un botón roto', async () => {
    const m = montar({ errorInicio: new ErrorServidor('El pago en línea todavía no está disponible.') });
    m.pagar.iniciar();
    await esperar();
    expect(texto()).toContain('No pudimos iniciar el pago');
    expect(texto()).toContain('todavía no está disponible');
    expect(document.querySelector('[data-campo="boton-bold"]')).toBeNull();
  });

  it('sin conexión reintenta solo; si se agota, ofrece revisar de nuevo y no pide pagar otra vez', async () => {
    const m = montar({ estados: [new ErrorRed()], max: 3 });
    m.pagar.iniciar();
    await esperar();
    await m.correr();
    await m.correr();
    expect(texto()).toContain('No pudimos revisar tu pago');
    expect(texto()).toContain('no pagues de nuevo');
    expect(document.querySelector('[data-accion="reintentar"]')).not.toBeNull();
    expect(m.llamadas.some((l) => l[0] === 'iniciarPago')).toBe(false);
  });

  it('si Bold devolvió el pago rechazado, ofrece intentar de nuevo con el botón y no se queda esperando', async () => {
    const m = montar({ hash: '', busqueda: '?c=' + CODIGO + '&bold-order-id=V57-abc&bold-tx-status=rejected' });
    m.pagar.iniciar();
    await esperar();
    expect(document.querySelector('[data-campo="boton-bold"]')).not.toBeNull();
    expect(texto()).not.toContain('Estamos confirmando');
  });
});
