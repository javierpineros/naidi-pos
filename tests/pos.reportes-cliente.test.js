import { describe, it, expect } from 'vitest';
import { crearFakeApi } from './ayudas/fake-api.js';
import { entrarComoPersonal, click, texto, esperar, $, $$ } from './ayudas/montar.js';

const REPORTE = { id: 7, venta_id: 'v-1', numero: 120, total_cop: 26400, cliente: 'Laura', nota: 'Pedí sin miel', creada_en: '2026-11-10T19:12:00Z' };
const copia = (x) => JSON.parse(JSON.stringify(x));

describe('POS: reportes "esto no es lo que pedí" del cliente', () => {
  it('sin reportes no se muestra nada', async () => {
    await entrarComoPersonal(crearFakeApi());
    expect($('[data-campo="reportes-cliente"]').hidden).toBe(true);
    expect($$('.reporte-item')).toHaveLength(0);
  });

  it('un reporte abierto se ve resaltado con la venta, el cliente y su nota, también desde otra pestaña', async () => {
    const api = crearFakeApi({ reportes: [copia(REPORTE)] });
    await entrarComoPersonal(api);
    await click('[data-pestana="venta"]');
    const caja = $('[data-campo="reportes-cliente"]');
    expect(caja.hidden).toBe(false);
    const t = texto('.reporte-item');
    expect(t).toContain('Laura dice que su pedido no es lo que pidió');
    expect(t).toContain('Venta #120');
    expect(t).toContain('$26.400');
    expect(t).toContain('Pedí sin miel');
  });

  it('suena una sola vez por reporte y la alerta visual se queda hasta que el vendedor la revisa', async () => {
    const api = crearFakeApi();
    const m = await entrarComoPersonal(api);
    await click('[data-accion="activar-sonido"]');
    const base = m.audio.reg.osciladores;

    api._s.reportes.push(copia(REPORTE));
    await m.pos.reportes.refrescar();
    expect(m.audio.reg.osciladores).toBe(base + 2);
    expect($$('.reporte-item')).toHaveLength(1);

    await m.pos.reportes.refrescar();
    await m.pos.reportes.refrescar();
    expect(m.audio.reg.osciladores).toBe(base + 2);       // no vuelve a sonar por el mismo reporte
    expect($$('.reporte-item')).toHaveLength(1);          // pero sigue a la vista

    await click('[data-accion="reporte-revisado"]');
    expect(api._s.llamadas.some((l) => l[0] === 'resolverReporte' && l[1] === 7)).toBe(true);
    expect($$('.reporte-item')).toHaveLength(0);
    expect($('[data-campo="reportes-cliente"]').hidden).toBe(true);
  });

  it('sin internet conserva el aviso que ya estaba a la vista', async () => {
    const api = crearFakeApi({ reportes: [copia(REPORTE)] });
    const m = await entrarComoPersonal(api);
    expect($$('.reporte-item')).toHaveLength(1);
    api._s.red = false;
    await m.pos.reportes.refrescar();
    await esperar();
    expect($$('.reporte-item')).toHaveLength(1);
  });
});
