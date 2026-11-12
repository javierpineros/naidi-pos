import { describe, it, expect, afterEach } from 'vitest';
import { crearFakeApi } from './ayudas/fake-api.js';
import { montarPos, entrarComoPersonal, esperar, click, escribir, texto, fila, $, $$ } from './ayudas/montar.js';

const MARIA = {
  checkin_id: 'ck-1', cliente_id: 'c-maria', nombre_pila: 'María', inicial: 'P', foto_url: null,
  llegada_en: '2026-11-10T19:05:00Z', vence_en: '2026-11-10T19:35:00Z', cliente_nuevo: true, alerta_pendiente: true,
  regalo_bienvenida: true, premio_listo: false, pedido_web_listo: false,
};
const JUAN = { ...MARIA, checkin_id: 'ck-2', cliente_id: 'c-juan', nombre_pila: 'Juan', inicial: 'G', llegada_en: '2026-11-10T19:10:00Z', cliente_nuevo: false, alerta_pendiente: false, regalo_bienvenida: false, premio_listo: true };
const copia = (x) => JSON.parse(JSON.stringify(x));

// Guardia general: ninguna pantalla debe mostrar "null", "undefined" ni "[object ...]" como texto (un bug real que
// vi en el navegador: append nativo escribía "null" en la cabecera).
afterEach(() => {
  const t = document.body.textContent;
  expect(t, 'texto con basura en pantalla: ' + t.slice(0, 200)).not.toMatch(/\bnull\b|\bundefined\b|\[object |NaN/);
});

describe('acceso del personal', () => {
  it('el cajero entra con correo y código de 6 dígitos y no ve Reportes', async () => {
    const api = crearFakeApi();
    const m = await montarPos(api);
    expect($('[data-campo="correo"]')).not.toBeNull();
    await escribir('[data-campo="correo"]', 'cajero@naidi.test');
    await click('[data-accion="enviar-codigo"]');
    expect($('[data-campo="codigo"]')).not.toBeNull();
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    await esperar(12);
    expect($('[data-vista="espera"]')).not.toBeNull();
    expect($$('[data-pestana]').map((b) => b.dataset.pestana)).toEqual(['espera', 'venta', 'pedidos', 'rappi', 'caja']);
    expect(texto('.cabecera')).toContain('cajero@naidi.test');
    expect(m.pos.estado.rol).toBe('cajero');
  });

  it('un código incorrecto muestra el error y no entra', async () => {
    const api = crearFakeApi();
    await montarPos(api);
    await escribir('[data-campo="correo"]', 'cajero@naidi.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '000000');
    await click('[data-accion="verificar-codigo"]');
    expect(texto('[data-zona="error"]')).toMatch(/no es correcto/);
    expect($('[data-vista="espera"]')).toBeNull();
  });

  it('una cuenta que no es del personal no entra', async () => {
    const api = crearFakeApi({ tienePerfil: false });
    await montarPos(api);
    await escribir('[data-campo="correo"]', 'cliente@correo.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    expect(texto('[data-zona="error"]')).toMatch(/no tiene acceso al POS/);
    expect($('[data-vista="espera"]')).toBeNull();
    expect(api._s.sesion).toBeNull();           // y se cierra la sesión
    expect($('[data-campo="correo"]')).not.toBeNull();
  });

  it('el dueño sin segundo factor lo activa antes de entrar y ve Reportes', async () => {
    const api = crearFakeApi({ rol: 'dueno' });
    await montarPos(api);
    await escribir('[data-campo="correo"]', 'dueno@naidi.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    expect($('.qr-mfa')).not.toBeNull();
    expect(texto('.acceso')).toMatch(/verificación en dos pasos/);
    expect($('[data-vista="espera"]')).toBeNull();          // todavía no entra
    await escribir('[data-campo="mfa"]', '654321');
    await click('[data-accion="verificar-mfa"]');
    await esperar(12);
    expect($$('[data-pestana]').map((b) => b.dataset.pestana)).toContain('reportes');
  });

  it('el dueño con segundo factor ya registrado solo escribe su código', async () => {
    const api = crearFakeApi({ rol: 'dueno', factor: 'f-9' });
    await montarPos(api);
    await escribir('[data-campo="correo"]', 'dueno@naidi.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    expect($('.qr-mfa')).toBeNull();
    await escribir('[data-campo="mfa"]', '654321');
    await click('[data-accion="verificar-mfa"]');
    await esperar(12);
    expect($('[data-vista="espera"]')).not.toBeNull();
  });
});

describe('lista de espera', () => {
  it('muestra solo nombre de pila e inicial, hora de llegada y marcas, por orden de llegada', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA), copia(JUAN)] });
    await entrarComoPersonal(api);
    const items = $$('.espera-item');
    expect(items.length).toBe(2);
    expect(texto('strong', items[0])).toBe('María P.');
    expect(texto('small', items[0])).toBe('Llegó a las 14:05');
    expect(items[0].textContent).toContain('Cliente nuevo');
    expect(items[0].textContent).toContain('Regalo de bienvenida');
    expect(items[1].textContent).toContain('Premio listo');
    expect(items[0].classList.contains('alerta')).toBe(true);
    expect(items[1].classList.contains('alerta')).toBe(false);
    expect(document.body.textContent).not.toMatch(/Pérez|Gómez/);
  });

  it('sin clientes lo dice', async () => {
    await entrarComoPersonal(crearFakeApi());
    expect(texto('[data-campo="espera-vacia"]')).toBe('Nadie en espera por ahora.');
  });

  it('el botón "Activar sonido" desbloquea el audio', async () => {
    const m = await entrarComoPersonal(crearFakeApi());
    expect($('[data-accion="activar-sonido"]').textContent).toBe('Activar sonido');
    expect(m.sonido.activo()).toBe(false);
    await click('[data-accion="activar-sonido"]');
    expect(m.sonido.activo()).toBe(true);
    expect($('[data-accion="activar-sonido"]').textContent).toBe('Sonido activo');
  });

  it('un cliente nuevo suena una sola vez y la marca visual se queda hasta que la vean', async () => {
    const api = crearFakeApi();
    const m = await entrarComoPersonal(api);
    await click('[data-accion="activar-sonido"]');
    const base = m.audio.reg.osciladores;

    api._s.espera.push(copia(MARIA));
    await m.pos.vistas.espera.refrescar();
    expect(m.audio.reg.osciladores).toBe(base + 2);           // sonó (dos tonos)
    expect($('.espera-item.alerta')).not.toBeNull();         // y se ve resaltado

    await m.pos.vistas.espera.refrescar();
    await m.pos.vistas.espera.refrescar();
    expect(m.audio.reg.osciladores).toBe(base + 2);           // no vuelve a sonar por el mismo cliente
    expect($('.espera-item.alerta')).not.toBeNull();         // pero la alerta visual sigue ahí

    await click('[data-accion="alerta-vista"]');
    expect(api._s.llamadas.some((l) => l[0] === 'marcarAlertaVista' && l[1] === 'ck-1')).toBe(true);
    expect($('.espera-item.alerta')).toBeNull();
  });

  it('el sonido tiene límite de frecuencia aunque lleguen clientes nuevos seguidos', async () => {
    const api = crearFakeApi();
    const m = await entrarComoPersonal(api);
    await click('[data-accion="activar-sonido"]');
    const base = m.audio.reg.osciladores;
    api._s.espera.push(copia(MARIA));
    await m.pos.vistas.espera.refrescar();
    api._s.espera.push({ ...copia(MARIA), checkin_id: 'ck-3', cliente_id: 'c-3', nombre_pila: 'Ana' });
    await m.pos.vistas.espera.refrescar();
    expect(m.audio.reg.osciladores).toBe(base + 2);           // el segundo cae dentro del intervalo mínimo: sin sonido
    expect($$('.espera-item.alerta').length).toBe(2);        // pero los dos quedan resaltados
    m.avanzar(25000);
    api._s.espera.push({ ...copia(MARIA), checkin_id: 'ck-4', cliente_id: 'c-4', nombre_pila: 'Luz' });
    await m.pos.vistas.espera.refrescar();
    expect(m.audio.reg.osciladores).toBe(base + 4);           // pasado el intervalo, vuelve a sonar
  });

  it('sin el sonido activado igual se resalta al cliente nuevo', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)] });
    const m = await entrarComoPersonal(api);
    expect($('.espera-item.alerta')).not.toBeNull();
    expect(m.audio.reg.osciladores).toBe(0);
  });

  it('"Ya se fue" saca al cliente de la lista', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA), copia(JUAN)] });
    await entrarComoPersonal(api);
    await click('.espera-item [data-accion="se-fue"]');
    expect($$('.espera-item').length).toBe(1);
    expect(texto('.espera-item strong')).toBe('Juan G.');
  });

  it('si se cae el internet la lista conserva lo último y avisa "Sin conexión"', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)] });
    const m = await entrarComoPersonal(api);
    api._s.red = false;
    await m.pos.vistas.espera.refrescar();
    expect($$('.espera-item').length).toBe(1);
    expect(texto('[data-campo="conexion"]')).toBe('Sin conexión');
    api._s.red = true;
    await m.pos.vistas.espera.refrescar();
    expect(texto('[data-campo="conexion"]')).toBe('En línea');
  });
});

describe('venta con cliente', () => {
  const vouchers = () => ({
    'c-maria': [
      { id: 'w-1', tipo: 'bienvenida', modalidad: 'toppings_gratis', cantidad_toppings: 1, toppings: null, estado: 'activo' },
      { id: 'w-2', tipo: 'premio', modalidad: 'descuento_compra', descuento_pct: 20, estado: 'activo' },
    ],
  });

  async function atenderAMaria(api) {
    const m = await entrarComoPersonal(api);
    await click('.espera-item [data-accion="atender"]');
    return m;
  }

  it('atender abre la venta del cliente en el servidor y marca la alerta como vista', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)], vouchers: vouchers() });
    const m = await atenderAMaria(api);
    expect(m.pos.estado.pestana).toBe('venta');
    expect(texto('[data-campo="cliente"]')).toBe('Cliente: María P.');
    expect(api._s.llamadas.find((l) => l[0] === 'crearVenta')[1].cliente).toBe('c-maria');
    expect(api._s.llamadas.some((l) => l[0] === 'marcarAlertaVista')).toBe(true);
  });

  it('arma la venta con atajos y selector, aplica premios y cobra en efectivo con cambio', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)], vouchers: vouchers() });
    await atenderAMaria(api);

    await click('[data-atajo="amazonas:pequeno"]');                       // atajo: 16.300
    expect(texto('[data-campo="total"]')).toBe('$16.300');

    await click('.catalogo [data-producto="bowl-personalizado"]');        // selector completo
    await click('[data-base="mango"]');
    await click('[data-tamano="mediano"]');
    for (const t of ['banano', 'fresa', 'mango', 'kiwi', 'avena', 'chia']) await click('[data-topping="' + t + '"]');
    expect(texto('[data-accion="agregar-seleccion"]')).toBe('Agregar · $19.700');   // 18.200 + chía extra
    await click('[data-accion="agregar-seleccion"]');
    expect(texto('[data-campo="total"]')).toBe('$36.000');                // total que calcula el servidor

    // premio de toppings gratis sobre el bowl personalizado (la chía extra: 1.500)
    const linea2 = api._s.ventas.get('v-1').venta_lineas[1].id;
    const bloque = $('[data-premio="w-1"]');
    const sel = $('[data-campo="linea-premio"]', bloque);
    sel.value = linea2;
    await click($('[data-accion="aplicar-premio"]', bloque));
    expect(texto('[data-campo="total"]')).toBe('$34.500');

    // 20% de la compra
    await click('[data-premio="w-2"] [data-accion="aplicar-premio"]');
    expect(texto('[data-campo="total"]')).toBe('$27.600');
    expect($('[data-premio="compra"]')).not.toBeNull();

    await click('[data-accion="confirmar-pedido"]');
    expect(api._s.ventas.get('v-1').estado).toBe('confirmada');
    expect($('.pago')).not.toBeNull();
    expect($('[data-accion="agregar-seleccion"]')).toBeNull();

    // efectivo: no alcanza → deshabilitado; alcanza → cambio
    expect($('[data-accion="registrar-pago"]').disabled).toBe(true);
    await escribir('[data-campo="recibido"]', '20000');
    expect(texto('[data-campo="cambio"]')).toBe('Faltan $7.600');
    expect($('[data-accion="registrar-pago"]').disabled).toBe(true);
    await escribir('[data-campo="recibido"]', '30000');
    expect(texto('[data-campo="cambio"]')).toBe('Cambio: $2.400');
    await click('[data-accion="registrar-pago"]');

    expect(texto('[data-campo="pagado"]')).toBe('Pagado ✓');
    expect(texto('[data-campo="puntos"]')).toBe('Puntos acreditados a María: 27');
    expect(api._s.llamadas.find((l) => l[0] === 'pagarVenta')[1]).toMatchObject({ medio: 'efectivo', efectivo: 30000 });

    await click('[data-accion="nueva-venta"]');
    expect($('[data-vista="espera"]').hidden).toBe(false);
    expect(texto('.vista-venta .vacio h2')).toBe('Sin venta abierta');
  });

  it('quitar un producto y quitar un premio actualizan el total desde el servidor', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)], vouchers: vouchers() });
    await atenderAMaria(api);
    await click('[data-atajo="amazonas:pequeno"]');
    await click('[data-producto="latte"]');
    expect(texto('[data-campo="total"]')).toBe('$20.300');
    await click('[data-premio="w-2"] [data-accion="aplicar-premio"]');
    expect(texto('[data-campo="total"]')).toBe('$16.240');
    await click('[data-accion="quitar-premio-compra"]');
    expect(texto('[data-campo="total"]')).toBe('$20.300');
    await click('[data-linea] [data-accion="quitar-linea"]');
    expect(texto('[data-campo="total"]')).toBe('$4.000');
  });

  it('cancelar una venta confirmada exige motivo', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)] });
    await atenderAMaria(api);
    await click('[data-producto="espresso"]');
    await click('[data-accion="confirmar-pedido"]');
    await click('[data-accion="cancelar-venta"]');
    await click('[data-accion="aceptar-texto"]');                          // sin escribir nada
    expect(texto('.modal-caja .error')).toMatch(/Escribe algo/);
    await escribir('[data-campo="texto"]', 'El cliente se arrepintió');
    await click('[data-accion="aceptar-texto"]');
    expect(api._s.llamadas.find((l) => l[0] === 'cancelarVenta')[1].motivo).toBe('El cliente se arrepintió');
    expect(texto('.vista-venta .vacio h2')).toBe('Sin venta abierta');
  });

  it('"Repetir lo de la última vez" agrega lo anterior y avisa de lo que ya no existe', async () => {
    const api = crearFakeApi({
      espera: [copia(MARIA)],
      ultima: { 'c-maria': { lineas: [
        { producto: 'amazonas', nombre: 'Amazonas', tamano: 'pequeno', presentacion: 'bowl', base: null, toppings: ['miel'], cantidad: 1 },
        { producto: 'agotado', nombre: 'Bowl agotado', tamano: null, presentacion: null, base: null, toppings: [], cantidad: 1 },
      ] } },
    });
    await atenderAMaria(api);
    await click('[data-accion="repetir-ultima"]');
    expect(texto('[data-campo="total"]')).toBe('$17.800');
    expect(document.body.textContent).toContain('Ya no está disponible: Bowl agotado.');
  });

  it('no deja atender a otro cliente con una venta abierta', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA), copia(JUAN)] });
    const m = await entrarComoPersonal(api);
    await click('.espera-item [data-accion="atender"]');
    await click('[data-producto="espresso"]');
    m.pos.ctx.irA('espera');
    await click($$('.espera-item')[1].querySelector('[data-accion="atender"]'));
    expect(api._s.llamadas.filter((l) => l[0] === 'crearVenta').length).toBe(1);
    expect(document.body.textContent).toContain('Termina o descarta la venta');
  });

  it('sin conexión, una venta con cliente avisa y no pierde lo que ya tenía', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)] });
    await atenderAMaria(api);
    await click('[data-producto="espresso"]');
    api._s.red = false;
    await click('[data-producto="latte"]');
    expect(document.body.textContent).toContain('Sin conexión');
    expect($$('.lineas li').length).toBe(1);
    api._s.red = true;
    await click('[data-producto="latte"]');
    expect($$('.lineas li').length).toBe(2);
  });
});

describe('venta sin cliente', () => {
  it('con internet: cobra por transferencia, muestra el destino y entrega el QR para reclamar puntos', async () => {
    const api = crearFakeApi();
    await entrarComoPersonal(api);
    await click('[data-accion="venta-sin-cliente-espera"]');
    expect(texto('[data-campo="cliente"]')).toBe('Sin cliente');
    await click('[data-producto="espresso"]');
    await click('[data-producto="latte"]');
    expect(texto('[data-campo="total"]')).toBe('$6.500');
    await click('[data-accion="confirmar-pedido"]');
    await click('[data-medio="transferencia"]');
    expect(texto('[data-campo="destino"]')).toContain('@naidi.fit');
    await click('[data-accion="registrar-pago"]');
    expect(texto('[data-campo="pagado"]')).toBe('Pagado ✓');
    expect($('[data-campo="qr-posventa"] svg')).not.toBeNull();
    const v = [...api._s.ventas.values()][0];
    expect(v).toMatchObject({ estado: 'pagada', medio_pago: 'transferencia', cliente_id: null });
    expect(v.venta_lineas.length).toBe(2);
  });

  it('SIN internet: guarda la venta localmente y la sincroniza cuando vuelve la conexión (una sola vez)', async () => {
    const api = crearFakeApi();
    const red = { on: true };
    const m = await entrarComoPersonal(api, { enLinea: () => red.on });
    await click('[data-accion="venta-sin-cliente-espera"]');
    await click('[data-producto="espresso"]');
    await click('[data-atajo="amazonas:pequeno"]');

    red.on = false; api._s.red = false;                                   // se cae el internet
    await click('[data-accion="confirmar-pedido"]');
    await click('[data-medio="datafono_bold"]');
    await click('[data-accion="registrar-pago"]');
    expect(texto('.listo h2')).toBe('Venta guardada sin conexión');
    expect($('[data-campo="qr-posventa"]')).toBeNull();
    expect(texto('[data-campo="pendientes"]')).toBe('1 venta por enviar');
    expect(api._s.llamadas.filter((l) => l[0] !== 'enviarCodigo').length).toBe(0);   // la venta no tocó el servidor
    expect((await m.cola.pendientes())[0]).toMatchObject({ medio: 'datafono_bold', total_estimado: 18800 });

    red.on = true; api._s.red = true;                                     // vuelve
    await m.pos.sincronizarCola();
    expect(api._s.offline.size).toBe(1);
    expect((await m.cola.pendientes()).length).toBe(0);
    expect($('[data-campo="pendientes"]')).toBeNull();
    expect(document.body.textContent).toContain('1 venta(s) hechas sin internet ya quedaron registradas');
    await m.pos.sincronizarCola();
    expect(api._s.offline.size).toBe(1);                                  // y no se duplica
  });

  it('se puede asignar el cliente en cualquier momento: la venta pasa a ser con cliente', async () => {
    const api = crearFakeApi({ espera: [copia(MARIA)] });
    await entrarComoPersonal(api);
    await click('[data-accion="venta-sin-cliente-espera"]');
    await click('[data-producto="espresso"]');
    await click('[data-atajo="amazonas:pequeno"]');
    await click('[data-accion="asignar-cliente"]');
    expect(texto('[data-campo="cliente"]')).toBe('Cliente: María P.');
    expect(api._s.ventas.get('v-1').cliente_id).toBe('c-maria');
    expect(api._s.ventas.get('v-1').venta_lineas.length).toBe(2);
    expect(texto('[data-campo="total"]')).toBe('$18.800');
  });

  it('el efectivo exige monto suficiente y calcula el cambio', async () => {
    const api = crearFakeApi();
    await entrarComoPersonal(api);
    await click('[data-accion="venta-sin-cliente-espera"]');
    await click('[data-producto="americano"]');
    await click('[data-accion="confirmar-pedido"]');
    expect($('[data-accion="registrar-pago"]').disabled).toBe(true);
    await click('[data-accion="monto-exacto"]');
    expect($('[data-accion="registrar-pago"]').disabled).toBe(false);
    await escribir('[data-campo="recibido"]', '5000');
    expect(texto('[data-campo="cambio"]')).toBe('Cambio: $2.000');
    await click('[data-accion="registrar-pago"]');
    expect(texto('.listo')).toContain('Cambio: $2.000');
  });
});

describe('ventas de Rappi', () => {
  it('exige número de pedido y no duplica el mismo pedido', async () => {
    const api = crearFakeApi();
    await entrarComoPersonal(api);
    await click('[data-pestana="rappi"]');
    await click('.vista-rappi [data-producto="espresso"]');
    await click('[data-accion="registrar-rappi"]');
    expect(document.body.textContent).toContain('Escribe el número de pedido de Rappi.');
    await escribir('[data-campo="pedido-rappi"]', 'RAPPI-1001');
    await click('[data-accion="registrar-rappi"]');
    expect(texto('[data-campo="mensaje-rappi"]')).toBe('Pedido RAPPI-1001 registrado por $2.500.');

    await click('.vista-rappi [data-producto="espresso"]');
    await escribir('[data-campo="pedido-rappi"]', 'RAPPI-1001');
    await click('[data-accion="registrar-rappi"]');
    expect(texto('[data-campo="mensaje-rappi"]')).toMatch(/ya estaba registrado/);
    expect(api._s.rappi.size).toBe(1);
  });

  it('sin conexión no inventa nada: avisa y se puede reintentar sin duplicar', async () => {
    const api = crearFakeApi();
    await entrarComoPersonal(api);
    await click('[data-pestana="rappi"]');
    await click('.vista-rappi [data-producto="latte"]');
    await escribir('[data-campo="pedido-rappi"]', 'RAPPI-7');
    api._s.red = false;
    await click('[data-accion="registrar-rappi"]');
    expect(document.body.textContent).toContain('Sin conexión');
    api._s.red = true;
    await click('[data-accion="registrar-rappi"]');
    await click('.vista-rappi [data-producto="latte"]');
    expect(api._s.rappi.size).toBe(1);
    const llamadas = api._s.llamadas.filter((l) => l[0] === 'registrarVentaRappi');
    expect(llamadas[0][1].idem).toBe(llamadas[1][1].idem);                // misma clave en el reintento
  });
});

describe('caja', () => {
  const cierre = {
    fecha: '2026-11-10', cerrado: false, ventas: 3, total_cop: 27800, canceladas: 1, anuladas: { ventas: 1, total_cop: 4000 },
    por_medio: [{ medio: 'efectivo', ventas: 1, total_cop: 2500 }, { medio: 'rappi', ventas: 1, total_cop: 5000 }, { medio: 'transferencia', ventas: 1, total_cop: 20300 }],
    sin_pagar: [{ venta_id: 'x', numero: 9, total_cop: 3000, confirmada_en: '2026-11-10T20:00:00Z', cliente: 'Juan' }],
  };
  const ventasDia = [{ id: 'vp-1', numero: 5, estado: 'pagada', canal: 'tienda', medio_pago: 'efectivo', total_cop: 2500, cliente: null, pagada_en: '2026-11-10T19:00:00Z' }];

  it('el cierre se separa por medio de pago e informa lo que quedó sin pagar', async () => {
    const api = crearFakeApi({ cierre, ventasDia });
    await entrarComoPersonal(api);
    await click('[data-pestana="caja"]');
    const filas = $$('[data-tabla="por-medio"] tbody tr').map(fila);
    expect(filas).toEqual(['Efectivo 1 $2.500', 'Rappi 1 $5.000', 'Transferencia 1 $20.300']);
    expect(texto('[data-campo="total-dia"]')).toBe('$27.800');
    expect(texto('[data-campo="sin-pagar"]')).toContain('#9 · $3.000 · Juan');
    expect($('[data-accion="anular-venta"]')).toBeNull();                 // el cajero no anula
  });

  it('cerrar la caja pide confirmación y avisa que marcó lo pendiente para el dueño', async () => {
    const api = crearFakeApi({ cierre, ventasDia });
    await entrarComoPersonal(api);
    await click('[data-pestana="caja"]');
    await click('[data-accion="cerrar-caja"]');
    expect(texto('.modal-caja p')).toMatch(/1 venta\(s\) confirmada\(s\) sin pagar/);
    await click('[data-accion="no-confirmar"]');
    expect(api._s.llamadas.some((l) => l[0] === 'cerrarCaja')).toBe(false);
    await click('[data-accion="cerrar-caja"]');
    await click('[data-accion="si-confirmar"]');
    expect(api._s.llamadas.some((l) => l[0] === 'cerrarCaja')).toBe(true);
    expect(document.body.textContent).toContain('Caja cerrada.');
  });

  it('una venta confirmada sin pagar se puede abrir de nuevo y cobrar', async () => {
    const api = crearFakeApi({ ventasDia: [{ id: 'v-1', numero: 1, estado: 'confirmada', canal: 'tienda', medio_pago: null, total_cop: 2500, cliente: null, confirmada_en: '2026-11-10T19:00:00Z' }] });
    await entrarComoPersonal(api);
    const id = await api.crearVenta({ idem: 'k-1', cliente: null });
    await api.agregarLinea(id, { producto: 'espresso', cantidad: 1 });
    await api.confirmarVenta(id);
    await click('[data-pestana="caja"]');
    await click('[data-accion="abrir-venta"]');
    expect($('.pago')).not.toBeNull();
    await click('[data-medio="transferencia"]');
    await click('[data-accion="registrar-pago"]');
    expect(texto('[data-campo="pagado"]')).toBe('Pagado ✓');
    expect(api._s.ventas.get(id).estado).toBe('pagada');
  });

  it('el dueño anula con motivo y PIN; un PIN incorrecto no anula y dice cuántos intentos quedan', async () => {
    const api = crearFakeApi({ rol: 'dueno', factor: 'f-1', cierre, ventasDia });
    await montarPos(api);
    await escribir('[data-campo="correo"]', 'dueno@naidi.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    await escribir('[data-campo="mfa"]', '654321');
    await click('[data-accion="verificar-mfa"]');
    await esperar(12);
    await click('[data-pestana="caja"]');

    await click('[data-accion="anular-venta"]');
    await escribir('[data-campo="texto"]', 'error de digitación');
    await click('[data-accion="aceptar-texto"]');
    expect($('input[type="password"]')).not.toBeNull();                   // pide el PIN
    await escribir('input[type="password"]', '0000');
    await click('[data-accion="aceptar-texto"]');
    expect(document.body.textContent).toContain('PIN incorrecto. Te quedan 3 intentos.');

    await click('[data-accion="anular-venta"]');
    await escribir('[data-campo="texto"]', 'error de digitación');
    await click('[data-accion="aceptar-texto"]');
    await escribir('input[type="password"]', '2468');
    await click('[data-accion="aceptar-texto"]');
    expect(document.body.textContent).toContain('Venta anulada. Se revirtieron 5 puntos.');
    expect(api._s.llamadas.filter((l) => l[0] === 'anularVenta').map((l) => l[1].pin)).toEqual(['0000', '2468']);
  });

  it('el dueño ve y resuelve las alertas de ventas sin pagar', async () => {
    const api = crearFakeApi({ rol: 'dueno', factor: 'f-1', cierre, ventasDia,
      alertas: [{ id: 7, tipo: 'venta_sin_pagar', detalle: { numero: 9, total_cop: 3000 } }] });
    await montarPos(api);
    await escribir('[data-campo="correo"]', 'dueno@naidi.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    await escribir('[data-campo="mfa"]', '654321');
    await click('[data-accion="verificar-mfa"]');
    await esperar(12);
    await click('[data-pestana="caja"]');
    expect(texto('[data-campo="alertas"]')).toContain('Venta #9 sin pagar al cierre');
    await click('[data-accion="resolver-alerta"]');
    await escribir('[data-campo="texto"]', 'Pagó por transferencia al día siguiente');
    await click('[data-accion="aceptar-texto"]');
    expect(api._s.llamadas.find((l) => l[0] === 'resolverAlerta')[1]).toEqual({ id: 7, nota: 'Pagó por transferencia al día siguiente' });
    expect($('[data-campo="alertas"]')).toBeNull();
  });
});

describe('reportes (solo dueño)', () => {
  it('muestra ventas por sabor, tamaño y hora, y el costo de premios', async () => {
    const api = crearFakeApi({ rol: 'dueno', factor: 'f-1' });
    await montarPos(api);
    await escribir('[data-campo="correo"]', 'dueno@naidi.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    await escribir('[data-campo="mfa"]', '654321');
    await click('[data-accion="verificar-mfa"]');
    await esperar(12);
    await click('[data-pestana="reportes"]');
    await click('[data-accion="ver-reportes"]');
    expect(texto('[data-campo="resumen"]')).toBe('3 ventas · $30.000 · ticket promedio $10.000');
    expect(fila($('[data-tabla="por-sabor"] tbody tr'))).toBe('Açaí mango 2 $25.400');
    expect(fila($('[data-tabla="por-hora"] tbody tr'))).toBe('14:00 3 $30.000');
    expect(texto('[data-campo="costo"]')).toBe('Costo de premios: $10.600 (27.9% de las ventas)');
  });
});
