import { describe, it, expect, vi } from 'vitest';
import { crearFakeTienda } from './ayudas/fake-tienda.js';
import { crearTienda } from '../src/tienda/app.js';
import { esperar, click, escribir, texto, $, $$ } from './ayudas/montar.js';

// Hora de las pruebas: 2026-11-10T15:00:00Z = 10:00 en Bogotá. Con 20 min de anticipación, la primera ventana de hoy es 10:30.
const AHORA = new Date('2026-11-10T15:00:00Z');
const SESION = { id: 'u-1', email: 'laura@prueba.test' };

async function montar(api, opciones) {
  document.body.innerHTML = '<div id="app"></div>';
  const guardado = new Map();
  const almacen = { leer: (k) => guardado.get(k) || null, escribir: (k, v) => guardado.set(k, v), borrar: (k) => guardado.delete(k) };
  const t = crearTienda({ raiz: document.getElementById('app'), api, almacen, ahora: () => AHORA, setInterval: () => 0, clearInterval: () => {}, ...(opciones || {}) });
  await t.iniciar();
  await esperar();
  return { t, almacen: guardado };
}

async function agregarBowl() {
  await click('[data-producto="amazonas"] [data-accion="elegir"]');
  await click('[data-tamano="pequeno"]');
  await click('[data-accion="agregar"]');
}

describe('Tienda: menú y carrito', () => {
  it('muestra el catálogo con precios del servidor, sin necesidad de sesión', async () => {
    await montar(crearFakeTienda());
    expect($$('.producto').length).toBeGreaterThan(8);
    expect(texto('[data-producto="amazonas"]')).toContain('Desde $7.000');
    expect(texto('[data-producto="latte"]')).toContain('$4.000');
    expect($('[data-campo="tienda-cerrada"]')).toBeNull();
  });

  it('con la tienda cerrada avisa y no deja elegir productos', async () => {
    await montar(crearFakeTienda({ estado: { abierta: false } }));
    expect(texto('[data-campo="tienda-cerrada"]')).toContain('no estamos recibiendo pedidos');
    expect($('[data-producto="amazonas"] [data-accion="elegir"]').disabled).toBe(true);
  });

  it('un bowl del menú trae sus toppings definidos: solo se elige tamaño y cantidad', async () => {
    const { almacen } = await montar(crearFakeTienda());
    await click('[data-producto="amazonas"] [data-accion="elegir"]');
    expect($$('[data-topping]')).toHaveLength(0);          // sin selector de toppings
    expect($('[data-base]')).toBeNull();                    // ni de base
    await click('[data-tamano="pequeno"]');
    expect(texto('[data-campo="precio-hoja"]')).toBe('$16.300');
    await click('[data-accion="mas"]');
    expect(texto('[data-campo="precio-hoja"]')).toBe('$32.600');
    await click('[data-accion="agregar"]');
    expect($('[data-campo="hoja"]')).toBeNull();
    expect(texto('[data-campo="total-pastilla"]')).toBe('$32.600');
    expect(JSON.parse(almacen.get('tienda.carrito'))).toHaveLength(1);
    expect(JSON.parse(almacen.get('tienda.carrito'))[0].toppings).toEqual([]);
  });

  it('un café se agrega con un toque y el carrito sobrevive a una recarga', async () => {
    const api = crearFakeTienda();
    const { almacen } = await montar(api);
    await click('[data-producto="latte"] [data-accion="elegir"]');
    expect(texto('.pastilla-carrito')).toContain('1 producto');
    // "Recarga": una tienda nueva con el mismo almacenamiento
    document.body.innerHTML = '<div id="app"></div>';
    const t2 = crearTienda({ raiz: document.getElementById('app'), api, almacen: { leer: (k) => almacen.get(k) || null, escribir: (k, v) => almacen.set(k, v), borrar: () => {} }, ahora: () => AHORA, setInterval: () => 0 });
    await t2.iniciar();
    await esperar();
    expect(texto('[data-campo="total-pastilla"]')).toBe('$4.000');
  });

  it('el bowl personalizado exige elegir base y cobra los toppings que pasan de los incluidos', async () => {
    await montar(crearFakeTienda());
    await click('[data-producto="bowl-personalizado"] [data-accion="elegir"]');
    await click('[data-tamano="mini"]');   // Mini incluye 3 toppings
    await click('[data-base="fresa"]');
    for (const t of ['banano', 'fresa', 'mango', 'kiwi']) await click('[data-topping="' + t + '"]');
    // Mini $7.000 + el cuarto topping (kiwi $1.500)
    expect(texto('[data-campo="precio-hoja"]')).toBe('$8.500');
  });

  it('al elegir toppings en "Arma tu bowl" la hoja conserva su desplazamiento (no salta al inicio)', async () => {
    await montar(crearFakeTienda());
    await click('[data-producto="bowl-personalizado"] [data-accion="elegir"]');
    // jsdom no calcula el diseño: se simula que la persona ya bajó dentro de la hoja
    $('.hoja').scrollTop = 340;
    await click('[data-topping="mango"]');
    expect($('.hoja').scrollTop).toBe(340);
    await click('[data-topping="kiwi"]');
    expect($('.hoja').scrollTop).toBe(340);
    expect($('[data-topping="kiwi"]').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Tienda: fotos de los productos', () => {
  it('cada tarjeta con foto muestra su imagen decorativa y la que no tiene foto queda sin imagen', async () => {
    await montar(crearFakeTienda());
    const foto = (clave) => $('[data-producto="' + clave + '"] img.producto-foto');
    expect(foto('amazonas').getAttribute('src')).toBe('/img/productos/amazonas.webp');
    expect(foto('fruta-intensa').getAttribute('src')).toBe('/img/productos/frutal.webp');   // la clave y el archivo pueden diferir
    expect(foto('latte').getAttribute('src')).toBe('/img/productos/latte.webp');
    expect(foto('amazonas').getAttribute('alt')).toBe('');                                  // decorativa: el nombre está al lado
    expect(foto('bowl-personalizado')).toBeNull();
  });

  it('si una foto no carga se quita y la tarjeta sigue usable', async () => {
    await montar(crearFakeTienda());
    const img = $('[data-producto="selva"] img.producto-foto');
    img.dispatchEvent(new Event('error'));
    expect($('[data-producto="selva"] img.producto-foto')).toBeNull();
    expect($('[data-producto="selva"] [data-accion="elegir"]')).not.toBeNull();
  });
});

describe('Tienda: desplazamiento entre pantallas', () => {
  it('al pasar del menú a "Tu pedido" la página empieza arriba (no deja tapado "¿Cuándo lo recoges?")', async () => {
    await montar(crearFakeTienda());
    await agregarBowl();
    const antes = window.scrollTo;
    const espia = vi.fn();
    window.scrollTo = espia;
    try {
      await click('[data-accion="ver-carrito"]');
      expect(texto('h1')).toBe('Tu pedido');
      expect(espia).toHaveBeenCalledWith(0, 0);
    } finally { window.scrollTo = antes; }
  });
});

describe('Tienda: pedir', () => {
  it('sin sesión pide entrar con correo y código, y vuelve al carrito con lo que había elegido', async () => {
    const api = crearFakeTienda();
    await montar(api);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect(texto('[data-campo="total"]')).toBe('$16.300');
    await click('[data-accion="pedir"]');
    expect(texto('[data-campo="error"]')).toContain('Elige la hora');
    await escribir('[data-campo="ventana"]', $('[data-campo="ventana"] option:nth-child(2)').value);
    await click('[data-accion="pedir"]');
    expect($('[data-form="correo"]')).not.toBeNull();
    await escribir('[data-campo="correo"]', 'laura@prueba.test');
    await click('[data-accion="enviar-codigo"]');
    expect($('[data-form="codigo"]')).not.toBeNull();
    await escribir('[data-campo="codigo"]', '000000');
    await click('[data-accion="verificar-codigo"]');
    expect(texto('[data-campo="error"]')).toContain('no es válido');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    await esperar(8);
    expect(texto('[data-campo="total"]')).toBe('$16.300');   // volvió al carrito, intacto
  });

  it('pide con sesión: manda solo qué pidió (sin precios), muestra el código y el QR', async () => {
    const api = crearFakeTienda({ sesion: SESION });
    await montar(api);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    const opciones = $$('[data-campo="ventana"] option').map((o) => o.textContent);
    expect(opciones[1]).toBe('Hoy 10:30 – 11:00');
    expect(opciones.some((o) => o.startsWith('Hoy 10:00') || o.startsWith('Hoy 10:15'))).toBe(false);   // antes de la anticipación mínima
    expect(opciones[opciones.length - 1]).toBe('Hoy 12:45 – 13:15');                                    // tope: 3 h de anticipación máxima, sin horario fijo
    await escribir('[data-campo="ventana"]', $('[data-campo="ventana"] option:nth-child(2)').value);
    await escribir('[data-campo="nota"]', 'sin canela');
    await click('[data-accion="pedir"]');
    const enviado = api._s.llamadas.find((l) => l[0] === 'crearPedido')[1];
    expect(enviado.pago).toBe('al_recoger');
    expect(enviado.ventanaInicio).toBe('2026-11-10T15:30:00.000Z');
    expect(enviado.ventanaFin).toBe('2026-11-10T16:00:00.000Z');
    expect(enviado.nota).toBe('sin canela');
    expect(enviado.lineas).toEqual([{ producto: 'amazonas', tamano: 'pequeno', presentacion: 'bowl', base: null, toppings: [], cantidad: 1 }]);
    expect(JSON.stringify(enviado)).not.toMatch(/precio|total/i);
    expect(texto('[data-campo="pedido-creado"]')).toContain('#41');
    expect(texto('[data-campo="codigo"]')).toBe('K7P2');
    expect($('[data-campo="qr"] svg')).not.toBeNull();
    expect(texto('[data-campo="estado"]')).toBe('Recibido');
    expect(texto('.pedido')).toContain('Recógelo entre las 10:30 y las 11:00');
    expect(JSON.parse(localStorage.getItem('tienda.carrito') || '[]')).toEqual([]);
  });

  it('ofrece la cortesía (solo con bowl y cuenta elegible) y la envía', async () => {
    const api = crearFakeTienda({ sesion: SESION });
    await montar(api);
    await click('[data-producto="latte"] [data-accion="elegir"]');
    await click('[data-accion="ver-carrito"]');
    expect($('[data-campo="cortesia"]')).toBeNull();           // un café solo no lleva cortesía
    await click('[data-accion="quitar"]');
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect(texto('[data-campo="cortesia"]')).toContain('sin costo');
    await click('[data-cortesia="avena"]');
    await click('[data-cortesia="chia"]');                       // con cantidad 1, el segundo reemplaza al primero
    await escribir('[data-campo="ventana"]', $('[data-campo="ventana"] option:nth-child(2)').value);
    await click('[data-accion="pedir"]');
    expect(api._s.llamadas.find((l) => l[0] === 'crearPedido')[1].cortesia).toEqual(['chia']);
    expect(texto('.pedido')).toContain('Cortesía: Chía');
  });

  it('si la cuenta ya no tiene cortesía disponible, no se ofrece', async () => {
    const api = crearFakeTienda({ sesion: SESION, mia: { cortesia_disponible: false } });
    await montar(api);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect($('[data-campo="cortesia"]')).toBeNull();
  });

  it('pide aceptar el tratamiento de datos antes de pedir y luego vuelve al carrito', async () => {
    const api = crearFakeTienda({ sesion: SESION, perfil: { acepta_datos: false } });
    await montar(api);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    await escribir('[data-campo="ventana"]', $('[data-campo="ventana"] option:nth-child(2)').value);
    await click('[data-accion="pedir"]');
    expect($('[data-form="consentimiento"]')).not.toBeNull();
    expect(api._s.llamadas.some((l) => l[0] === 'crearPedido')).toBe(false);
    expect($('[data-accion="aceptar"]').disabled).toBe(true);
    $('[data-campo="acepta-datos"]').checked = true;
    $('[data-campo="acepta-datos"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    await click('[data-accion="aceptar"]');
    await esperar(8);
    expect(api._s.llamadas.find((l) => l[0] === 'consentir')[1]).toEqual({ tipo: 'datos', version: '2026-11-v1', acepta: true });
    expect(texto('[data-campo="total"]')).toBe('$16.300');
  });

  it('un reintento tras perder la conexión reutiliza la misma clave (no duplica el pedido)', async () => {
    const api = crearFakeTienda({ sesion: SESION });
    await montar(api);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    await escribir('[data-campo="ventana"]', $('[data-campo="ventana"] option:nth-child(2)').value);
    api._s.red = false;
    await click('[data-accion="pedir"]');
    expect(texto('[data-campo="error"]')).toContain('No hay conexión');
    api._s.red = true;
    await click('[data-accion="pedir"]');
    const claves = api._s.llamadas.filter((l) => l[0] === 'crearPedido').map((l) => l[1].idem);
    expect(claves).toHaveLength(2);
    expect(claves[0]).toBe(claves[1]);
    expect(api._s.pedidos).toHaveLength(1);
  });

  it('muestra el error del servidor tal cual (por ejemplo, el tope de pedidos abiertos)', async () => {
    const api = crearFakeTienda({ sesion: SESION, mia: { abiertos: 2 } });
    await montar(api);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect(texto('main')).toContain('Ya tienes 2 pedido(s) abierto(s)');
    expect($('[data-accion="pedir"]').disabled).toBe(true);
  });

  it('si los pedidos abiertos se entregaron mientras la página seguía abierta, el aviso de tope desaparece al abrir "Tu pedido"', async () => {
    const api = crearFakeTienda({ sesion: SESION, mia: { abiertos: 2 } });
    await montar(api);                                   // al entrar, la cuenta tenía 2 abiertos
    api._s.mia.abiertos = 0;                             // el POS los entregó después
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(texto('main')).not.toContain('pedido(s) abierto(s)');
    expect($('[data-accion="pedir"]').disabled).toBe(false);
  });

  it('una cuenta bloqueada no puede pedir y una de prepago solo ve el pago en línea', async () => {
    const bloqueada = crearFakeTienda({ sesion: SESION, mia: { restriccion: 'bloqueo' } });
    await montar(bloqueada);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect(texto('main')).toContain('no podemos recibir pedidos web de esta cuenta');
    expect($('[data-accion="pedir"]').disabled).toBe(true);

    const prepago = crearFakeTienda({ sesion: SESION, mia: { restriccion: 'prepago' }, estado: { pagos: { al_recoger: true, en_linea: true } } });
    await montar(prepago);
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect($('[data-pago="al_recoger"]').disabled).toBe(true);
    expect($('[data-pago="en_linea"]').checked).toBe(true);
    expect($('[data-pago="en_linea"]').type).toBe('radio');
  });

  it('la forma de pago sale de la configuración: solo se ofrece lo que está activo', async () => {
    await montar(crearFakeTienda({ sesion: SESION }));
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect($('[data-pago="al_recoger"]')).not.toBeNull();
    expect($('[data-pago="en_linea"]')).toBeNull();

    await montar(crearFakeTienda({ sesion: SESION, estado: { pagos: { al_recoger: true, en_linea: true } } }));
    await agregarBowl();
    await click('[data-accion="ver-carrito"]');
    expect($('[data-pago="en_linea"]')).not.toBeNull();
    await click('[data-pago="en_linea"]');
    expect($('[data-pago="en_linea"]').checked).toBe(true);
    expect($('[data-pago="al_recoger"]').checked).toBe(false);
    expect($('[data-pago]').tagName).toBe('INPUT');   // opciones de radio, no botones
  });
});

describe('Tienda: mis pedidos', () => {
  const pedido = (extra) => ({
    id: 'pw-9', numero: 9, estado: 'recibido', metodo_pago: 'al_recoger', pago_en_linea_estado: 'no_aplica', codigo: 'AB23',
    ventana_inicio: '2026-11-10T16:00:00Z', ventana_fin: '2026-11-10T16:30:00Z', en_camino_en: null, cortesia_toppings: [], nota: null,
    subtotal_cop: 16300, total_cop: 16300, creado_en: '2026-11-10T14:50:00Z',
    lineas: [{ producto_clave: 'amazonas', producto_nombre: 'Amazonas', categoria: 'bowls', tamano: 'pequeno', presentacion: 'bowl', base: null, toppings: [], cantidad: 1, precio_unitario_cop: 16300 }],
    ...extra,
  });

  it('muestra el estado, la ventana, el código y el QR; avisa "voy en camino"', async () => {
    const api = crearFakeTienda({ sesion: SESION, pedidos: [pedido()] });
    await montar(api);
    await click('[data-accion="mis-pedidos"]');
    expect(texto('[data-campo="estado"]')).toBe('Recibido');
    expect(texto('[data-campo="codigo"]')).toBe('AB23');
    await click('[data-accion="en-camino"]');
    expect(texto('[data-campo="en-camino"]')).toContain('vas en camino');
    expect($('[data-accion="en-camino"]')).toBeNull();
  });

  it('refleja el cambio de estado que hace el POS en la siguiente consulta', async () => {
    const api = crearFakeTienda({ sesion: SESION, pedidos: [pedido()] });
    const { t } = await montar(api);
    await click('[data-accion="mis-pedidos"]');
    api._s.pedidos[0].estado = 'listo';
    await t.refrescarPedidos();
    expect(texto('[data-campo="estado"]')).toBe('Listo');
    expect(texto('.pedido')).toContain('Tu pedido está listo');
    expect($('[data-accion="cancelar-pedido"]')).toBeNull();   // ya no se cancela solo
  });

  it('cancela un pedido recibido y pasa a anteriores sin código', async () => {
    const api = crearFakeTienda({ sesion: SESION, pedidos: [pedido()] });
    await montar(api);
    await click('[data-accion="mis-pedidos"]');
    await click('[data-accion="cancelar-pedido"]');
    expect(texto('[data-campo="estado"]')).toBe('Cancelado');
    expect($('[data-campo="codigo"]')).toBeNull();
  });

  it('un pedido entregado queda en anteriores', async () => {
    const api = crearFakeTienda({ sesion: SESION, pedidos: [pedido({ estado: 'entregado' })] });
    await montar(api);
    await click('[data-accion="mis-pedidos"]');
    expect(texto('main')).toContain('Anteriores');
    expect($('[data-campo="codigo"]')).toBeNull();
  });

  it('salir cierra la sesión y vuelve al menú', async () => {
    const api = crearFakeTienda({ sesion: SESION, pedidos: [pedido()] });
    await montar(api);
    await click('[data-accion="mis-pedidos"]');
    await click('[data-accion="salir"]');
    expect(api._s.sesion).toBeNull();
    expect($('[data-accion="entrar"]')).not.toBeNull();
    expect($$('.producto').length).toBeGreaterThan(0);
  });
});

describe('Tienda: pago en línea con Bold', () => {
  const ESTADO = { pagos: { al_recoger: true, en_linea: true } };
  const enLinea = (extra) => ({
    id: 'pw-5', numero: 5, estado: 'recibido', metodo_pago: 'en_linea', pago_en_linea_estado: 'pendiente', codigo: 'AB23',
    ventana_inicio: '2026-11-10T16:00:00Z', ventana_fin: '2026-11-10T16:30:00Z', en_camino_en: null, cortesia_toppings: [], nota: null,
    subtotal_cop: 4000, total_cop: 4000, creado_en: '2026-11-10T14:50:00Z',
    lineas: [{ producto_clave: 'latte', producto_nombre: 'Café latte', categoria: 'cafes', tamano: null, presentacion: null, base: null, toppings: [], cantidad: 1, precio_unitario_cop: 4000 }],
    ...extra,
  });

  it('al pedir en línea abre el botón de Bold con los datos firmados por el servidor', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO });
    await montar(api);
    await click('[data-producto="latte"] [data-accion="elegir"]');
    await click('[data-accion="ver-carrito"]');
    await escribir('[data-campo="ventana"]', $('[data-campo="ventana"] option:nth-child(2)').value);
    await click('[data-pago="en_linea"]');
    await click('[data-accion="pedir"]');
    await esperar(6);
    expect(api._s.llamadas.find((l) => l[0] === 'crearPedido')[1].pago).toBe('en_linea');
    expect(texto('[data-campo="pago-pendiente"]')).toContain('Falta pagar $4.000');
    expect($('[data-campo="codigo"]')).toBeNull();   // el código y el QR solo aparecen cuando el pago está confirmado
    const boton = $('[data-campo="boton-bold"] script');
    expect(boton).not.toBeNull();
    expect(boton.getAttribute('data-api-key')).toBe('identidad-test');
    expect(boton.getAttribute('data-amount')).toBe('4000');
    expect(boton.getAttribute('data-currency')).toBe('COP');
    expect(boton.getAttribute('data-integrity-signature')).toBe('f'.repeat(64));
    expect(boton.getAttribute('data-redirection-url')).toBe('https://naidi.test/tienda/');
    expect(boton.hasAttribute('data-description')).toBe(false);
    expect(JSON.parse(boton.getAttribute('data-customer-data'))).toEqual({ email: 'laura@prueba.test' });
    expect(boton.src).toContain('checkout.bold.co/library/boldPaymentButton.js');
    expect($('[data-accion="pagar-ahora"]')).toBeNull();
  });

  it('el botón sobrevive a las consultas periódicas y desaparece cuando el servidor confirma el pago', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea()] });
    const { t } = await montar(api);
    await click('[data-accion="mis-pedidos"]');
    await click('[data-accion="pagar-ahora"]');
    const nodo = $('[data-campo="boton-bold"]');
    await t.refrescarPedidos();
    await t.refrescarPedidos();
    expect($('[data-campo="boton-bold"]')).toBe(nodo);           // mismo nodo: el botón no se reinicia
    expect(api._s.llamadas.filter((l) => l[0] === 'iniciarPagoBold')).toHaveLength(1);
    api._s.pedidos[0].pago_en_linea_estado = 'pagado';           // lo marca el webhook en el servidor
    await t.refrescarPedidos();
    expect($('[data-campo="boton-bold"]')).toBeNull();
    expect(texto('[data-campo="pago-confirmado"]')).toContain('Pago confirmado');
    expect($('[data-accion="pagar-ahora"]')).toBeNull();
  });

  it('al volver de Bold avisa que está confirmando el pago, sin darlo por hecho', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea()] });
    await montar(api, { leerBusqueda: () => '?bold-order-id=NW5-abc&bold-tx-status=approved' });
    expect(texto('[data-campo="pago-confirmando"]')).toContain('Recibimos tu pago y lo estamos confirmando');
    expect($('[data-campo="pago-confirmado"]')).toBeNull();                          // la redirección no es prueba de pago
    expect(api._s.llamadas.some((l) => l[0] === 'verificarPagoBold')).toBe(true);    // pero se le pregunta a Bold por el estado real
    expect(texto('[data-accion="pagar-ahora"]')).toContain('Intentar de nuevo');     // discreto: ya pagó, solo por si no terminó
  });

  it('al volver de Bold, si el servidor confirma el pago la tarjeta pasa a pagada y muestra el código', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea()] });
    api._s.boldAprobado = true;
    await montar(api, { leerBusqueda: () => '?bold-order-id=NW5-abc&bold-tx-status=approved' });
    expect(texto('[data-campo="pago-confirmado"]')).toContain('Pago confirmado');
    expect($('[data-campo="pago-pendiente"]')).toBeNull();
    expect(texto('[data-campo="codigo"]')).toBe('AB23');
    expect($('[data-accion="pagar-ahora"]')).toBeNull();
  });

  it('si Bold devuelve un pago no aprobado lo dice y deja intentar de nuevo', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea()] });
    await montar(api, { leerBusqueda: () => '?bold-order-id=NW5-abc&bold-tx-status=rejected' });
    expect(texto('[data-campo="pago-no-completado"]')).toContain('Todavía no vemos un pago aprobado');
    expect(texto('[data-campo="pago-no-completado"]')).toContain('no vuelvas a pagar');
    expect(texto('[data-accion="pagar-ahora"]')).toBe('Pagar ahora');
  });

  it('el aviso de retorno de Bold solo aparece en el pedido que volvió, no en otro pendiente', async () => {
    const otro = enLinea({ id: 'pw-6', numero: 6, codigo: 'ZZ99' });
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea(), otro] });
    await montar(api, { leerBusqueda: () => '?bold-order-id=NW5-abc&bold-tx-status=approved' });
    const tarjetaOtro = $('[data-pedido="pw-6"]');
    expect(tarjetaOtro.querySelector('[data-campo="pago-confirmando"]')).toBeNull();
    expect(tarjetaOtro.querySelector('[data-campo="pago-no-completado"]')).toBeNull();
    expect(tarjetaOtro.querySelector('[data-accion="pagar-ahora"]').textContent).toBe('Pagar ahora');
    expect($('[data-pedido="pw-5"] [data-campo="pago-confirmando"]')).not.toBeNull();
  });

  it('si pagó en Bold y cerró sin volver, al abrir Mis pedidos se pregunta a Bold y queda pagado', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea()] });
    api._s.boldAprobado = true;                          // pagó en Bold, pero la tienda no se enteró
    await montar(api);                                   // entra a la tienda normal, sin parámetros de retorno
    await click('[data-accion="mis-pedidos"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(api._s.llamadas.filter((l) => l[0] === 'verificarPagoBold')).toHaveLength(1);
    expect(texto('[data-campo="pago-confirmado"]')).toContain('Pago confirmado');
    expect($('[data-accion="pagar-ahora"]')).toBeNull();
  });

  it('mientras el pago sigue pendiente avisa, antes del botón, que no vuelva a pagar si ya pagó', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea()] });
    await montar(api);
    await click('[data-accion="mis-pedidos"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(texto('[data-campo="pago-pendiente"]')).toContain('Si ya pagaste, espera un momento y no vuelvas a pagar');
    expect(texto('[data-accion="pagar-ahora"]')).toBe('Pagar ahora');
  });

  it('lo que falta pagar va primero en Mis pedidos', async () => {
    const pagado = enLinea({ id: 'pw-8', numero: 8, pago_en_linea_estado: 'pagado' });
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [pagado, enLinea()] });
    await montar(api);
    await click('[data-accion="mis-pedidos"]');
    expect($$('.pedido').map((x) => x.dataset.numero)).toEqual(['5', '8']);
  });

  it('un pedido para pagar al recoger no muestra pago en línea; un error del servidor se ve en la tarjeta', async () => {
    const api = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea({ id: 'pw-6', numero: 6, metodo_pago: 'al_recoger', pago_en_linea_estado: 'no_aplica' })] });
    await montar(api);
    await click('[data-accion="mis-pedidos"]');
    expect($('[data-accion="pagar-ahora"]')).toBeNull();

    const api2 = crearFakeTienda({ sesion: SESION, estado: ESTADO, pedidos: [enLinea()] });
    api2._s.fallos.pago = 'El pago en línea todavía no está disponible.';
    await montar(api2);
    await click('[data-accion="mis-pedidos"]');
    await click('[data-accion="pagar-ahora"]');
    expect(texto('.pedido .error')).toContain('todavía no está disponible');
    expect($('[data-campo="boton-bold"]')).toBeNull();
  });
});
