import { describe, it, expect, vi } from 'vitest';
import { crearCatalogo, precioLinea } from '../src/lib/precio.js';
import { fmtCop, horaBogota } from '../src/lib/format.js';
import { traducirError, ErrorRed, ErrorServidor } from '../src/lib/errores.js';
import { crearSonido } from '../src/pos/sonido.js';
import { crearCola, almacenMemoria, almacenLocal } from '../src/pos/cola.js';
import { cobrarSinCliente, nuevaClave } from '../src/pos/vender.js';
import { catalogoReal, crearFakeApi } from './ayudas/fake-api.js';
import { audioFalso } from './ayudas/montar.js';

const cat = crearCatalogo(catalogoReal());

describe('precio de una línea (vista previa; el servidor es quien manda)', () => {
  it('coincide con los valores que calcula el servidor en las pruebas SQL', () => {
    // supabase/tests/03: Mediano personalizado con 6 toppings = 19.700; menú Pequeño + miel = 17.800; café = 2.500
    expect(precioLinea(cat, { producto: 'bowl-personalizado', tamano: 'mediano', base: 'mango', toppings: ['banano', 'fresa', 'mango', 'kiwi', 'avena', 'chia'] }).unitario).toBe(19700);
    expect(precioLinea(cat, { producto: 'amazonas', tamano: 'pequeno', toppings: ['miel'] }).unitario).toBe(17800);
    expect(precioLinea(cat, { producto: 'espresso' }).unitario).toBe(2500);
  });

  it('el Mini incluye 3 toppings; el cuarto cuesta', () => {
    const base = precioLinea(cat, { producto: 'bowl-personalizado', tamano: 'mini', base: 'mango', toppings: ['banano', 'fresa', 'mango'] }).unitario;
    const con4 = precioLinea(cat, { producto: 'bowl-personalizado', tamano: 'mini', base: 'mango', toppings: ['banano', 'fresa', 'mango', 'miel'] }).unitario;
    expect(base).toBe(7000);
    expect(con4).toBe(8500);
  });

  it('multiplica por la cantidad y rechaza combinaciones inválidas', () => {
    expect(precioLinea(cat, { producto: 'latte', cantidad: 3 }).subtotal).toBe(12000);
    expect(() => precioLinea(cat, { producto: 'latte', tamano: 'grande' })).toThrow();
    expect(() => precioLinea(cat, { producto: 'amazonas' })).toThrow(/tamaño/);
    expect(() => precioLinea(cat, { producto: 'bowl-personalizado', tamano: 'grande' })).toThrow(/base/);
    expect(() => precioLinea(cat, { producto: 'no-existe' })).toThrow();
  });
});

describe('formato', () => {
  it('pesos con punto de miles', () => {
    expect(fmtCop(19700)).toBe('$19.700');
    expect(fmtCop(0)).toBe('$0');
    expect(fmtCop(1234567)).toBe('$1.234.567');
  });
  it('hora de Bogotá en 24 h', () => {
    expect(horaBogota('2026-11-10T19:05:00Z')).toBe('14:05');
  });
});

describe('errores', () => {
  it('distingue falta de red de un rechazo del servidor', () => {
    expect(traducirError({ message: 'TypeError: Failed to fetch' })).toBeInstanceOf(ErrorRed);
    expect(traducirError({ message: 'Solo el personal puede hacer esto.', code: '42501' })).toBeInstanceOf(ErrorServidor);
  });
});

describe('sonido', () => {
  it('no suena hasta que se activa (los navegadores bloquean el audio)', () => {
    const a = audioFalso();
    const s = crearSonido({ crearContexto: () => a.ctx, ahora: () => 0 });
    expect(s.alertar()).toBe(false);
    expect(s.activar()).toBe(true);
    expect(s.alertar()).toBe(true);
  });

  it('tiene límite de frecuencia: intervalo mínimo y tope por minuto', () => {
    const a = audioFalso();
    let t = 0;
    const s = crearSonido({ crearContexto: () => a.ctx, ahora: () => t, minIntervaloMs: 20000, maxPorMinuto: 2 });
    s.activar();
    expect(s.alertar()).toBe(true);   // t = 0
    t = 5000;
    expect(s.alertar()).toBe(false);  // demasiado pronto
    t = 21000;
    expect(s.alertar()).toBe(true);
    t = 42000;
    expect(s.alertar()).toBe(false);  // ya van 2 en el último minuto
    t = 90000;
    expect(s.alertar()).toBe(true);   // la ventana se vació
  });
});

const venta = (extra) => ({ idem: nuevaClave(), lineas: [{ producto: 'espresso', cantidad: 1 }], medio: 'transferencia', total_estimado: 2500, ...(extra || {}) });

describe('cola de ventas sin internet', () => {
  it('guarda en orden y no duplica la misma venta', async () => {
    const cola = crearCola({ almacen: almacenMemoria(), ahora: () => 'T' });
    const v = venta();
    await cola.encolar(v);
    await cola.encolar(v);
    expect((await cola.pendientes()).length).toBe(1);
  });

  it('sincroniza al volver el internet y reenviar no duplica', async () => {
    const api = crearFakeApi();
    const cola = crearCola({ almacen: almacenMemoria() });
    const v = venta();
    await cola.encolar(v);
    api._s.red = false;
    const r1 = await cola.sincronizar(api);
    expect(r1.sinConexion).toBe(true);
    expect((await cola.pendientes()).length).toBe(1);   // sigue guardada

    api._s.red = true;
    const r2 = await cola.sincronizar(api);
    expect(r2).toMatchObject({ enviadas: 1, duplicadas: 0, sinConexion: false });
    expect((await cola.pendientes()).length).toBe(0);
    expect(api._s.offline.size).toBe(1);

    // el servidor ya la tenía (la respuesta se perdió antes de borrarla): se cuenta como duplicada, no se repite
    await cola.encolar(v);
    const r3 = await cola.sincronizar(api);
    expect(r3).toMatchObject({ enviadas: 0, duplicadas: 1 });
    expect(api._s.offline.size).toBe(1);
  });

  it('un rechazo del servidor no se pierde ni se reintenta en bucle', async () => {
    const api = crearFakeApi();
    api._s.rechazarOffline = 'El producto "espresso" no está disponible.';
    const cola = crearCola({ almacen: almacenMemoria() });
    await cola.encolar(venta());
    const r = await cola.sincronizar(api);
    expect(r.rechazadas).toBe(1);
    const p = await cola.pendientes();
    expect(p.length).toBe(1);
    expect(p[0].error).toMatch(/no está disponible/);
    const antes = api._s.llamadas.length;
    await cola.sincronizar(api);
    expect(api._s.llamadas.length).toBe(antes);          // no vuelve a intentarlo
  });

  it('se detiene en el primer fallo de red y conserva el resto en orden', async () => {
    const api = crearFakeApi();
    const cola = crearCola({ almacen: almacenMemoria() });
    const a = venta(); const b = venta(); const c = venta();
    await cola.encolar(a); await cola.encolar(b); await cola.encolar(c);
    let n = 0;
    const original = api.registrarVentaOffline;
    api.registrarVentaOffline = async (v) => { if (++n === 2) throw new ErrorRed(); return original(v); };
    const r = await cola.sincronizar(api);
    expect(r).toMatchObject({ enviadas: 1, sinConexion: true });
    expect((await cola.pendientes()).map((x) => x.idem)).toEqual([b.idem, c.idem]);
  });

  it('dos sincronizaciones simultáneas no envían la venta dos veces', async () => {
    const api = crearFakeApi();
    const cola = crearCola({ almacen: almacenMemoria() });
    await cola.encolar(venta());
    const [x, y] = await Promise.all([cola.sincronizar(api), cola.sincronizar(api)]);
    expect(x).toEqual(y);
    expect(api._s.llamadas.filter((l) => l[0] === 'registrarVentaOffline').length).toBe(1);
  });

  it('el almacén local sobrevive a una recarga (usa localStorage)', async () => {
    const guardado = {};
    const storage = { getItem: (k) => guardado[k] ?? null, setItem: (k, v) => { guardado[k] = v; } };
    const c1 = crearCola({ almacen: almacenLocal(storage, 'cola') });
    await c1.encolar(venta());
    const c2 = crearCola({ almacen: almacenLocal(storage, 'cola') });
    expect((await c2.pendientes()).length).toBe(1);
  });
});

describe('cobro de una venta sin cliente', () => {
  it('con internet pasa por el servidor y entrega el QR posterior', async () => {
    const api = crearFakeApi();
    const cola = crearCola({ almacen: almacenMemoria() });
    const r = await cobrarSinCliente({ api, cola, venta: venta(), enLinea: () => true });
    expect(r.modo).toBe('servidor');
    expect(r.resultado.qr_token).toHaveLength(64);
    expect((await cola.pendientes()).length).toBe(0);
  });

  it('sin internet la deja en la cola, sin tocar el servidor', async () => {
    const api = crearFakeApi();
    const cola = crearCola({ almacen: almacenMemoria() });
    const r = await cobrarSinCliente({ api, cola, venta: venta(), enLinea: () => false });
    expect(r.modo).toBe('cola');
    expect(api._s.llamadas.length).toBe(0);
    expect((await cola.pendientes()).length).toBe(1);
  });

  it('si la red cae justo en el primer contacto, también va a la cola', async () => {
    const api = crearFakeApi();
    api._s.red = false;
    const cola = crearCola({ almacen: almacenMemoria() });
    const r = await cobrarSinCliente({ api, cola, venta: venta(), enLinea: () => true });
    expect(r.modo).toBe('cola');
  });

  it('si la red cae a mitad de camino NO se duplica: se reanuda por el servidor', async () => {
    const api = crearFakeApi();
    const cola = crearCola({ almacen: almacenMemoria() });
    const v = venta({ lineas: [{ producto: 'espresso', cantidad: 1 }, { producto: 'latte', cantidad: 1 }], total_estimado: 6500 });
    // se cae después de crear la venta y de agregar la primera línea
    const original = api.agregarLinea;
    let n = 0;
    api.agregarLinea = async (id, l) => { if (++n === 2) throw new ErrorRed(); return original(id, l); };
    await expect(cobrarSinCliente({ api, cola, venta: v, enLinea: () => true })).rejects.toBeInstanceOf(ErrorRed);
    expect((await cola.pendientes()).length).toBe(0);        // no se mandó a la cola: ya existe en el servidor

    api.agregarLinea = original;                             // vuelve el internet; se reintenta con el mismo objeto
    const r = await cobrarSinCliente({ api, cola, venta: v, enLinea: () => true });
    expect(r.modo).toBe('servidor');
    expect(api._s.ventas.size).toBe(1);
    const fila = [...api._s.ventas.values()][0];
    expect(fila.venta_lineas.length).toBe(2);               // ni faltan ni sobran líneas
    expect(fila.estado).toBe('pagada');
  });

  it('un rechazo del servidor se muestra, no se encola', async () => {
    const api = crearFakeApi();
    const cola = crearCola({ almacen: almacenMemoria() });
    const v = venta({ lineas: [{ producto: 'agotado', cantidad: 1 }] });
    await expect(cobrarSinCliente({ api, cola, venta: v, enLinea: () => true })).rejects.toBeInstanceOf(ErrorServidor);
    expect((await cola.pendientes()).length).toBe(0);
  });
});
