import { describe, it, expect } from 'vitest';
import { crearFakeApi } from './ayudas/fake-api.js';
import { entrarComoPersonal, click, escribir, texto, esperar, $, $$ } from './ayudas/montar.js';

// La hora del POS en las pruebas es 2026-11-10T15:00:00Z (10:00 en Bogotá).
function pedido(extra) {
  return {
    id: 'pw-1', numero: 7, estado: 'recibido', metodo_pago: 'al_recoger', pago_en_linea_estado: 'no_aplica', _codigo: 'K7P2',
    ventana_inicio: '2026-11-10T17:00:00Z', ventana_fin: '2026-11-10T17:30:00Z', en_camino_en: null,
    cortesia_toppings: [], nota: null, subtotal_cop: 26400, total_cop: 26400, creado_en: '2026-11-10T14:50:00Z',
    cliente_id: 'c-1', nombre_pila: 'Laura', inicial: 'P', foto_url: null,
    lineas: [{ producto_clave: 'amazonas', producto_nombre: 'Amazonas', categoria: 'bowls', tamano: 'pequeno', presentacion: 'bowl', base: null,
      toppings: [{ clave: 'miel', nombre: 'Miel', precio_cop: 1500, extra: true }], cantidad: 1, precio_unitario_cop: 26400 }],
    ...extra,
  };
}

describe('POS: pedidos web', () => {
  it('el interruptor enciende y apaga los pedidos web a mano, sin horario', async () => {
    const api = crearFakeApi();
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    expect(texto('[data-accion="interruptor-pedidos"]')).toContain('apagados: encender');
    await click('[data-accion="interruptor-pedidos"]');
    expect(api._s.tiendaWeb.abierta).toBe(true);
    expect(texto('[data-accion="interruptor-pedidos"]')).toContain('Recibiendo pedidos web: apagar');
    expect($('[data-accion="interruptor-pedidos"]').getAttribute('aria-pressed')).toBe('true');
    await click('[data-accion="interruptor-pedidos"]');
    expect(api._s.tiendaWeb.abierta).toBe(false);
    expect(api._s.llamadas.filter((l) => l[0] === 'fijarPedidosWeb').map((l) => l[1])).toEqual([true, false]);
  });

  it('si el dueño no habilitó los pedidos web, el interruptor está desactivado y lo explica', async () => {
    await entrarComoPersonal(crearFakeApi({ tiendaWeb: { abierta: false, habilitada: false } }));
    await click('[data-pestana="pedidos"]');
    expect($('[data-accion="interruptor-pedidos"]').disabled).toBe(true);
    expect(texto('[data-campo="interruptor-texto"]')).toContain('dueño debe habilitar');
  });

  it('el estado del interruptor se ve al abrir el turno aunque lo haya cambiado otra persona', async () => {
    await entrarComoPersonal(crearFakeApi({ tiendaWeb: { abierta: true, habilitada: true } }));
    await click('[data-pestana="pedidos"]');
    expect(texto('[data-accion="interruptor-pedidos"]')).toContain('Recibiendo pedidos web');
  });

  it('sin pedidos muestra la bandeja vacía', async () => {
    await entrarComoPersonal(crearFakeApi());
    await click('[data-pestana="pedidos"]');
    expect($('[data-campo="pedidos-vacio"]')).not.toBeNull();
    expect($('[data-pestana="pedidos"]').textContent).toBe('Pedidos web');
  });

  it('muestra el pedido con nombre de pila, ventana, contenido, cortesía y pago, y cuenta los abiertos en la pestaña', async () => {
    const api = crearFakeApi({ pedidos: [pedido({ cortesia_toppings: [{ clave: 'avena', nombre: 'Avena' }], nota: 'sin canela', en_camino_en: '2026-11-10T16:40:00Z' })] });
    await entrarComoPersonal(api);
    expect($('[data-pestana="pedidos"]').textContent).toBe('Pedidos web (1)');
    await click('[data-pestana="pedidos"]');
    const t = texto('.pedido-item');
    expect(t).toContain('#7 · Laura P.');
    expect(t).toContain('Recibido');
    expect(t).toContain('Va en camino');
    expect(t).toContain('Recoge entre las 12:00 y las 12:30');
    expect(t).toContain('Amazonas');
    expect(t).toContain('Miel');
    expect(t).toContain('Cortesía sin costo: Avena');
    expect(t).toContain('Nota: sin canela');
    expect(t).toContain('$26.400');
    expect(t).toContain('Paga al recoger');
    expect(t).not.toContain('K7P2');
  });

  it('pasa por Preparando y Listo', async () => {
    const api = crearFakeApi({ pedidos: [pedido()] });
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    await click('[data-accion="preparando"]');
    expect(texto('[data-campo="estado"]')).toBe('Preparando');
    expect($('[data-accion="preparando"]')).toBeNull();
    await click('[data-accion="listo"]');
    expect(texto('[data-campo="estado"]')).toBe('Listo');
    expect($('[data-accion="listo"]')).toBeNull();
  });

  it('entrega con el código, cobra en efectivo con cambio y mueve el pedido a cerrados', async () => {
    const api = crearFakeApi({ pedidos: [pedido()] });
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    await click('[data-accion="entregar"]');
    await escribir('[data-campo="codigo-pedido"]', 'zzzz');
    await escribir('[data-campo="efectivo-pedido"]', '30000');
    await click('[data-accion="confirmar-entrega"]');
    expect(texto('.modal-caja .error')).toContain('código no coincide');
    await escribir('[data-campo="codigo-pedido"]', 'k7p2');
    await click('[data-accion="confirmar-entrega"]');
    expect(texto('[data-campo="entrega-ok"]')).toContain('Pedido #7 entregado');
    expect(texto('[data-campo="cambio-final"]')).toBe('Devuelve $3.600');
    await click('[data-accion="cerrar-entrega"]');
    expect($('.modal-caja')).toBeNull();
    expect(texto('[data-campo="estado"]')).toBe('Entregado');
    expect($('[data-pestana="pedidos"]').textContent).toBe('Pedidos web');
    const llamada = api._s.llamadas.filter((l) => l[0] === 'entregarPedidoWeb').pop()[1];
    expect(llamada).toMatchObject({ id: 'pw-1', codigo: 'k7p2', medio: 'efectivo', efectivo: 30000 });
  });

  it('muestra el cambio en vivo mientras se digita el efectivo', async () => {
    const api = crearFakeApi({ pedidos: [pedido()] });
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    await click('[data-accion="entregar"]');
    await escribir('[data-campo="efectivo-pedido"]', '20000');
    expect(texto('[data-campo="cambio-pedido"]')).toBe('Faltan $6.400');
    await escribir('[data-campo="efectivo-pedido"]', '50000');
    expect(texto('[data-campo="cambio-pedido"]')).toBe('Cambio: $23.600');
  });

  it('exige que el efectivo alcance y el código de 4 caracteres antes de llamar al servidor', async () => {
    const api = crearFakeApi({ pedidos: [pedido()] });
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    await click('[data-accion="entregar"]');
    await click('[data-accion="confirmar-entrega"]');
    expect(texto('.modal-caja .error')).toContain('código de 4 caracteres');
    await escribir('[data-campo="codigo-pedido"]', 'K7P2');
    await escribir('[data-campo="efectivo-pedido"]', '1000');
    await click('[data-accion="confirmar-entrega"]');
    expect(texto('.modal-caja .error')).toContain('no alcanza');
    expect(api._s.llamadas.some((l) => l[0] === 'entregarPedidoWeb')).toBe(false);
  });

  it('un pedido pagado en línea no pide medio de pago', async () => {
    const api = crearFakeApi({ pedidos: [pedido({ metodo_pago: 'en_linea', pago_en_linea_estado: 'pagado' })] });
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    expect(texto('.pedido-item')).toContain('Pagado en línea');
    expect($('[data-accion="cancelar"]')).toBeNull();
    await click('[data-accion="entregar"]');
    expect($('[data-medio]')).toBeNull();
    await escribir('[data-campo="codigo-pedido"]', 'K7P2');
    await click('[data-accion="confirmar-entrega"]');
    const llamada = api._s.llamadas.filter((l) => l[0] === 'entregarPedidoWeb').pop()[1];
    expect(llamada.medio).toBeNull();
    expect(texto('[data-campo="estado"]')).toBe('Entregado');
  });

  it('"No llegó" solo aparece cuando la ventana ya venció', async () => {
    const api = crearFakeApi({ pedidos: [pedido(), pedido({ id: 'pw-2', numero: 8, ventana_inicio: '2026-11-10T13:00:00Z', ventana_fin: '2026-11-10T14:00:00Z' })] });
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    const [a, b] = $$('.pedido-item');
    expect($('[data-accion="no-llego"]', a)).toBeNull();
    expect($('[data-accion="no-llego"]', b)).not.toBeNull();
    await click($('[data-accion="no-llego"]', b));
    expect(texto('.avisos')).toContain('No llegó');
    expect($$('.pedido-item')[1].classList.contains('estado-no_llego')).toBe(true);
  });

  it('cancelar pide el motivo', async () => {
    const api = crearFakeApi({ pedidos: [pedido()] });
    await entrarComoPersonal(api);
    await click('[data-pestana="pedidos"]');
    await click('[data-accion="cancelar"]');
    await escribir('[data-campo="texto"]', 'Se acabó el açaí');
    await click('[data-accion="aceptar-texto"]');
    expect(api._s.llamadas.find((l) => l[0] === 'cancelarPedidoWeb')[1]).toEqual({ id: 'pw-1', motivo: 'Se acabó el açaí' });
    expect(texto('[data-campo="estado"]')).toBe('Cancelado');
  });

  it('suena solo con pedidos nuevos (no al abrir el turno) y sin internet conserva la lista', async () => {
    const api = crearFakeApi({ pedidos: [pedido()] });
    const m = await entrarComoPersonal(api);
    await click('[data-accion="activar-sonido"]');
    const base = m.audio.reg.osciladores;
    await m.pos.vistas.pedidos.refrescar();
    expect(m.audio.reg.osciladores).toBe(base);
    api._s.pedidos.push(pedido({ id: 'pw-3', numero: 9 }));
    await m.pos.vistas.pedidos.refrescar();
    expect(m.audio.reg.osciladores).toBe(base + 2);
    expect($$('.pedido-item')).toHaveLength(2);
    api._s.red = false;
    await m.pos.vistas.pedidos.refrescar();
    await esperar();
    expect($$('.pedido-item')).toHaveLength(2);
  });
});
