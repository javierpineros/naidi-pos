import { describe, it, expect, beforeEach } from 'vitest';
import { crearPantalla } from '../src/pantalla/app.js';
import { crearApiPantalla } from '../src/pantalla/api.js';

const LLAVE = 'nd_' + 'ab'.repeat(32);
const TOKEN = 'tok' + '0'.repeat(45);

const esperar = async (n) => { for (let i = 0; i < (n || 8); i++) await new Promise((r) => setTimeout(r, 0)); };

const reposo = (extra) => Object.assign({
  ok: true, entrada_token: TOKEN, venta: null,
  formas_pago: ['efectivo', 'datafono_bold', 'transferencia'],
  transferencia: { tipo: 'bre-b', valor: '@naidi' }, servidor_en: '2026-11-10T15:00:00Z',
}, extra || {});

const ventaConfirmada = () => reposo({
  venta: {
    numero: 41, estado: 'confirmada', subtotal_cop: 31000, descuento_cop: 3100, total_cop: 27900,
    lineas: [
      { nombre: 'Amazonas', tamano: 'Pequeño', cantidad: 1, toppings: ['Miel', 'Granola'], precio_unitario_cop: 24000, descuento_cop: 3100, total_cop: 20900 },
      { nombre: 'Espresso', tamano: null, cantidad: 2, toppings: [], precio_unitario_cop: 3500, descuento_cop: 0, total_cop: 7000 },
    ],
  },
});

// Reloj falso: guarda lo programado y lo corre a mano.
function relojFalso() {
  const pendientes = [];
  return {
    pendientes,
    setTimeout: (fn, ms) => { const t = { fn, ms, vivo: true }; pendientes.push(t); return t; },
    clearTimeout: (t) => { if (t) t.vivo = false; },
    vivos: () => pendientes.filter((t) => t.vivo),
    async correr() {
      const t = pendientes.filter((x) => x.vivo).pop();
      if (!t) return false;
      t.vivo = false;
      t.fn();
      await esperar();
      return true;
    },
  };
}

function montar(opciones) {
  const o = opciones || {};
  document.body.innerHTML = '<div id="app"></div>';
  const raiz = document.getElementById('app');
  const reloj = relojFalso();
  const guardado = { v: o.llave === undefined ? null : o.llave };
  const almacen = { leer: () => guardado.v, guardar: (v) => { guardado.v = v; }, borrar: () => { guardado.v = null; } };
  const llamadas = [];
  const respuestas = o.respuestas || [];
  const api = {
    estado: (llave) => {
      llamadas.push(llave);
      const r = respuestas.length > 1 ? respuestas.shift() : respuestas[0];
      return typeof r === 'function' ? r() : Promise.resolve(r);
    },
  };
  const hash = { v: o.hash || '' };
  const pantalla = crearPantalla({
    raiz, api, almacen, sinEventos: true,
    origen: () => 'https://naidi.test',
    leerHash: () => hash.v, limpiarHash: () => { hash.v = ''; },
    qr: (url) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('data-url', url); return s; },
    setTimeout: reloj.setTimeout, clearTimeout: reloj.clearTimeout,
  });
  return { pantalla, raiz, reloj, guardado, llamadas, respuestas, hash };
}

describe('pantalla del iPad: activación con la llave del dispositivo', () => {
  it('sin llave no consulta y pide activar la pantalla', async () => {
    const m = montar({ respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.textContent).toContain('Pantalla sin activar');
    expect(m.llamadas).toHaveLength(0);
    expect(m.reloj.vivos()).toHaveLength(0);
  });

  it('el enlace #llave= activa la pantalla, guarda la llave y la quita de la barra de direcciones', async () => {
    const m = montar({ hash: '#llave=' + LLAVE, respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.guardado.v).toBe(LLAVE);
    expect(m.hash.v).toBe('');
    expect(m.llamadas).toEqual([LLAVE]);
  });

  it('un enlace con una llave mal formada no consulta ni guarda nada', async () => {
    const m = montar({ hash: '#llave=nd_corta', respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.textContent).toContain('no es válido');
    expect(m.guardado.v).toBeNull();
    expect(m.llamadas).toHaveLength(0);
  });

  it('usa la llave guardada al reabrir la pantalla', async () => {
    const m = montar({ llave: LLAVE, respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.llamadas).toEqual([LLAVE]);
  });

  it('una llave guardada con formato raro se ignora', async () => {
    const m = montar({ llave: 'cualquier-cosa', respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.llamadas).toHaveLength(0);
    expect(m.raiz.textContent).toContain('Pantalla sin activar');
  });
});

describe('pantalla del iPad: qué muestra', () => {
  let m;
  beforeEach(() => { m = null; });

  it('en reposo muestra el QR de entrada con el token del servidor', async () => {
    m = montar({ llave: LLAVE, respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.textContent).toContain('Bienvenido a Naidí');
    const svg = m.raiz.querySelector('svg');
    expect(svg.getAttribute('data-url')).toBe('https://naidi.test/cuenta/#entrada=' + TOKEN);
  });

  it('al confirmar la venta muestra las líneas, el total y las formas de pago', async () => {
    m = montar({ llave: LLAVE, respuestas: [ventaConfirmada()] });
    m.pantalla.iniciar();
    await esperar();
    const t = m.raiz.textContent;
    expect(t).toContain('Tu pedido');
    expect(t).toContain('Amazonas Pequeño');
    expect(t).toContain('Miel, Granola');
    expect(t).toContain('2 × Espresso');
    expect(t).toContain('$20.900');
    expect(t).toContain('$27.900');
    expect(t).toContain('Efectivo');
    expect(t).toContain('Datáfono Bold');
    expect(t).toContain('Transferencia a Llave Bre-B');
    expect(t).toContain('@naidi');
    expect(m.raiz.querySelector('svg')).toBeNull();
  });

  it('un pedido largo avisa que se desliza y un total de seis cifras no se parte', async () => {
    const datos = ventaConfirmada();
    datos.venta.lineas = Array.from({ length: 10 }, (_, i) => ({ nombre: 'Bowl ' + (i + 1), tamano: 'Grande', cantidad: 1, toppings: [], precio_unitario_cop: 20000, descuento_cop: 0, total_cop: 20000 }));
    datos.venta.total_cop = 206900;
    m = montar({ llave: LLAVE, respuestas: [datos] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.querySelectorAll('.linea')).toHaveLength(10);
    expect(m.raiz.querySelector('.pista').textContent).toContain('10 productos');
    expect(m.raiz.querySelector('.total').textContent).toBe('$206.900');
    expect(m.raiz.querySelector('.total').className).not.toContain('largo');
    datos.venta.total_cop = 1206900;
    m = montar({ llave: LLAVE, respuestas: [datos] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.querySelector('.total').className).toContain('largo');
  });

  it('un pedido corto no muestra la pista de deslizar', async () => {
    m = montar({ llave: LLAVE, respuestas: [ventaConfirmada()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.querySelector('.pista')).toBeNull();
  });

  it('si no hay destino de transferencia configurado no muestra una línea vacía', async () => {
    const datos = ventaConfirmada();
    datos.transferencia = { tipo: 'bre-b', valor: '' };
    m = montar({ llave: LLAVE, respuestas: [datos] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.textContent).not.toContain('Transferencia a');
    expect(m.raiz.textContent).toContain('Transferencia');
  });

  it('al pagarse muestra "Pagado" y vuelve al QR cuando el servidor deja de enviar la venta', async () => {
    const pagada = ventaConfirmada();
    pagada.venta.estado = 'pagada';
    m = montar({ llave: LLAVE, respuestas: [ventaConfirmada(), pagada, reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.textContent).toContain('Tu pedido');
    await m.reloj.correr();
    expect(m.raiz.textContent).toContain('¡Pagado! Gracias');
    expect(m.raiz.textContent).toContain('$27.900');
    await m.reloj.correr();
    expect(m.raiz.textContent).toContain('Bienvenido a Naidí');
  });

  it('no repinta si nada cambió (sin parpadeos)', async () => {
    m = montar({ llave: LLAVE, respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    const antes = m.raiz.querySelector('.qr-caja');
    await m.reloj.correr();
    await m.reloj.correr();
    expect(m.raiz.querySelector('.qr-caja')).toBe(antes);
    expect(m.llamadas.length).toBe(3);
  });

  it('si el dueño rota el QR, la pantalla lo cambia sola', async () => {
    const nuevo = reposo({ entrada_token: 'nuevo' + '1'.repeat(40) });
    m = montar({ llave: LLAVE, respuestas: [reposo(), nuevo] });
    m.pantalla.iniciar();
    await esperar();
    await m.reloj.correr();
    expect(m.raiz.querySelector('svg').getAttribute('data-url')).toContain('#entrada=nuevo');
  });

  it('nunca pinta HTML que venga en los datos (todo entra como texto)', async () => {
    const datos = ventaConfirmada();
    datos.venta.lineas[0].nombre = '<img src=x onerror=alert(1)>';
    m = montar({ llave: LLAVE, respuestas: [datos] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.raiz.querySelector('img[src="x"]')).toBeNull();
    expect(m.raiz.textContent).toContain('<img src=x');
  });
});

describe('pantalla del iPad: consulta cada 2 o 3 segundos y se recupera sola', () => {
  it('programa la siguiente consulta a los 2,5 s', async () => {
    const m = montar({ llave: LLAVE, respuestas: [reposo()] });
    m.pantalla.iniciar();
    await esperar();
    const vivos = m.reloj.vivos();
    expect(vivos).toHaveLength(1);
    expect(vivos[0].ms).toBeGreaterThanOrEqual(2000);
    expect(vivos[0].ms).toBeLessThanOrEqual(3000);
  });

  it('sin internet conserva lo último que mostraba, avisa si se prolonga y se recupera', async () => {
    const falla = () => Promise.reject(new Error('Sin conexión.'));
    const m = montar({ llave: LLAVE, respuestas: [ventaConfirmada(), falla, falla, falla, ventaConfirmada()] });
    m.pantalla.iniciar();
    await esperar();
    await m.reloj.correr();
    expect(m.raiz.textContent).toContain('Tu pedido');
    expect(m.raiz.textContent).not.toContain('Reconectando');
    await m.reloj.correr();
    await m.reloj.correr();
    expect(m.raiz.textContent).toContain('Tu pedido');
    expect(m.raiz.textContent).toContain('Reconectando');
    await m.reloj.correr();
    expect(m.raiz.textContent).not.toContain('Reconectando');
    expect(m.raiz.textContent).toContain('Tu pedido');
  });

  it('con fallas seguidas espera más, pero nunca más de 10 s', async () => {
    const falla = () => Promise.reject(new Error('x'));
    const m = montar({ llave: LLAVE, respuestas: [falla] });
    m.pantalla.iniciar();
    await esperar();
    let max = 0;
    for (let i = 0; i < 12; i++) {
      const v = m.reloj.vivos();
      if (v.length) max = Math.max(max, v[v.length - 1].ms);
      await m.reloj.correr();
    }
    expect(max).toBeLessThanOrEqual(10000);
    expect(max).toBeGreaterThan(2500);
  });

  it('una llave revocada apaga la pantalla, borra la llave y deja de consultar', async () => {
    const m = montar({ llave: LLAVE, respuestas: [reposo(), { ok: false, error: 'llave_invalida' }] });
    m.pantalla.iniciar();
    await esperar();
    await m.reloj.correr();
    expect(m.raiz.textContent).toContain('Esta pantalla está desactivada');
    expect(m.guardado.v).toBeNull();
    expect(m.reloj.vivos()).toHaveLength(0);
    const n = m.llamadas.length;
    await m.reloj.correr();
    expect(m.llamadas.length).toBe(n);
  });

  it('una respuesta rara del servidor no apaga la pantalla: reintenta', async () => {
    const m = montar({ llave: LLAVE, respuestas: [{ ok: false, error: 'otra' }, reposo()] });
    m.pantalla.iniciar();
    await esperar();
    expect(m.guardado.v).toBe(LLAVE);
    expect(m.reloj.vivos()).toHaveLength(1);
    await m.reloj.correr();
    expect(m.raiz.textContent).toContain('Bienvenido');
  });
});

describe('cliente de la API de la pantalla', () => {
  it('llama a la función pantalla_estado con la llave del dispositivo y la anon (nunca otra)', async () => {
    const pedidos = [];
    const api = crearApiPantalla({
      url: 'https://x.supabase.co/', anon: 'ANON',
      fetch: (u, init) => { pedidos.push([u, init]); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); },
    });
    const r = await api.estado(LLAVE);
    expect(r.ok).toBe(true);
    const [u, init] = pedidos[0];
    expect(u).toBe('https://x.supabase.co/rest/v1/rpc/pantalla_estado');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('ANON');
    expect(JSON.parse(init.body)).toEqual({ p_llave: LLAVE });
  });

  it('un error HTTP se reporta como error del servidor y una red caída como error de red', async () => {
    const http = crearApiPantalla({ url: 'https://x.test', anon: 'A', fetch: () => Promise.resolve({ ok: false, status: 503 }) });
    await expect(http.estado(LLAVE)).rejects.toMatchObject({ tipo: 'servidor' });
    const red = crearApiPantalla({ url: 'https://x.test', anon: 'A', fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(red.estado(LLAVE)).rejects.toMatchObject({ tipo: 'red' });
  });

  it('si el servidor no contesta a tiempo aborta la consulta', async () => {
    let abortada = false;
    const api = crearApiPantalla({
      url: 'https://x.test', anon: 'A', limiteMs: 20,
      fetch: (u, init) => new Promise((_, rechazar) => { init.signal.addEventListener('abort', () => { abortada = true; rechazar(new Error('abortado')); }); }),
    });
    await expect(api.estado(LLAVE)).rejects.toMatchObject({ tipo: 'red' });
    expect(abortada).toBe(true);
  });
});
