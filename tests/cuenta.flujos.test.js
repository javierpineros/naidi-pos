import { describe, it, expect, afterEach } from 'vitest';
import { crearFakeCuenta, montarCuenta, COMPRA_POR_PAGAR, TOKEN_ENTRADA, TOKEN_QR } from './ayudas/fake-cuenta.js';
import { esperar, click, escribir, texto, $, $$ } from './ayudas/montar.js';

const SESION = { id: 'u-1', email: 'laura@correo.test' };
const CON_DATOS = { acepta_datos: true };
const copia = (x) => JSON.parse(JSON.stringify(x));

// Guardia general: ninguna pantalla debe mostrar "null", "undefined" ni "[object ...]" como texto.
afterEach(() => {
  const t = document.body.textContent;
  expect(t, 'texto con basura en pantalla: ' + t.slice(0, 200)).not.toMatch(/\bnull\b|\bundefined\b|\[object |NaN/);
});

describe('acceso con correo y código', () => {
  it('sin sesión pide el correo; un correo mal escrito no se envía', async () => {
    const api = crearFakeCuenta();
    await montarCuenta(api);
    expect($('[data-form="correo"]')).not.toBeNull();
    await escribir('[data-campo="correo"]', 'esto-no-es-un-correo');
    await click('[data-accion="enviar-codigo"]');
    expect(texto('[data-campo="error"]')).toContain('Revisa tu correo');
    expect(api._s.llamadas.some((l) => l[0] === 'enviarCodigo')).toBe(false);
  });

  it('envía el código, rechaza uno malo y con el bueno entra', async () => {
    const api = crearFakeCuenta({ perfil: CON_DATOS });
    await montarCuenta(api);
    await escribir('[data-campo="correo"]', ' Laura@Correo.test ');
    await click('[data-accion="enviar-codigo"]');
    expect(api._s.llamadas).toContainEqual(['enviarCodigo', 'laura@correo.test']);
    expect($('[data-form="codigo"]')).not.toBeNull();
    expect(texto('.acceso')).toContain('laura@correo.test');

    await escribir('[data-campo="codigo"]', '12');
    await click('[data-accion="verificar-codigo"]');
    expect(texto('[data-campo="error"]')).toContain('6 números');
    await escribir('[data-campo="codigo"]', '999999');
    await click('[data-accion="verificar-codigo"]');
    expect(texto('[data-campo="error"]')).toContain('no es válido');
    expect($('[data-vista="inicio"]')).toBeNull();

    await escribir('[data-campo="codigo"]', '123 456');
    await click('[data-accion="verificar-codigo"]');
    await esperar(12);
    expect($('[data-vista="inicio"]')).not.toBeNull();
    expect(texto('[data-vista="inicio"] h2')).toBe('Hola, Laura');
  });

  it('el botón de Google solo aparece si está activado', async () => {
    await montarCuenta(crearFakeCuenta());
    expect($('[data-accion="google"]')).toBeNull();
    await montarCuenta(crearFakeCuenta(), { googleActivo: true });
    expect($('[data-accion="google"]')).not.toBeNull();
  });

  it('sin internet lo dice con claridad', async () => {
    const api = crearFakeCuenta();
    await montarCuenta(api);
    api._s.red = false;
    await escribir('[data-campo="correo"]', 'laura@correo.test');
    await click('[data-accion="enviar-codigo"]');
    expect(texto('[data-campo="error"]')).toContain('No hay conexión');
  });
});

describe('consentimiento de datos (Ley 1581)', () => {
  it('sin consentimiento no se abre la cuenta; el botón espera la casilla y la de mensajes es opcional', async () => {
    const api = crearFakeCuenta({ sesion: SESION });
    await montarCuenta(api);
    expect($('[data-form="consentimiento"]')).not.toBeNull();
    expect($('[data-vista="inicio"]')).toBeNull();
    expect($('[data-accion="aceptar"]').disabled).toBe(true);
    expect($('a[href="/privacidad/"]')).not.toBeNull();
    await click('[data-campo="acepta-datos"]');
    expect($('[data-accion="aceptar"]').disabled).toBe(false);
    await click('[data-accion="aceptar"]');
    await esperar(12);
    expect(api._s.llamadas.filter((l) => l[0] === 'consentir')).toEqual([['consentir', 'datos', '2026-11-v1', true]]);
    expect($('[data-vista="inicio"]')).not.toBeNull();
  });

  it('si marca los mensajes también queda registrado', async () => {
    const api = crearFakeCuenta({ sesion: SESION });
    await montarCuenta(api);
    await click('[data-campo="acepta-datos"]');
    await click('[data-campo="acepta-mensajes"]');
    await click('[data-accion="aceptar"]');
    await esperar(12);
    expect(api._s.llamadas.filter((l) => l[0] === 'consentir').map((l) => l[1])).toEqual(['datos', 'mensajes']);
  });
});

describe('QR de entrada (#entrada=) y QR posterior a la venta (#qr=)', () => {
  it('con sesión: registra la llegada, quita el token de la barra y avisa', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    const m = await montarCuenta(api, { hash: '#entrada=' + TOKEN_ENTRADA });
    expect(m.hash.v).toBe('');
    expect(api._s.llamadas).toContainEqual(['hacerCheckin', TOKEN_ENTRADA]);
    expect(texto('[data-campo="aviso"]')).toContain('Ya estás en la lista');
    expect(texto('[data-campo="checkin"]')).toContain('Estás en la lista desde las 14:05');
    expect(m.almacen.size).toBe(0);           // el pendiente se consumió: recargar no repite el check-in
  });

  it('un cliente nuevo ve que tiene regalo de bienvenida', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, clienteNuevo: true });
    await montarCuenta(api, { hash: '#entrada=' + TOKEN_ENTRADA });
    expect(texto('[data-campo="aviso"]')).toContain('regalo de bienvenida');
  });

  it('sin sesión: el QR espera al ingreso y al consentimiento, y se usa después (sin perderse)', async () => {
    const api = crearFakeCuenta();
    const m = await montarCuenta(api, { hash: '#entrada=' + TOKEN_ENTRADA });
    expect(texto('.contexto')).toContain('registrar tu llegada');
    expect(api._s.llamadas.some((l) => l[0] === 'hacerCheckin')).toBe(false);
    await escribir('[data-campo="correo"]', 'laura@correo.test');
    await click('[data-accion="enviar-codigo"]');
    await escribir('[data-campo="codigo"]', '123456');
    await click('[data-accion="verificar-codigo"]');
    await esperar(12);
    expect($('[data-form="consentimiento"]')).not.toBeNull();
    expect(api._s.llamadas.some((l) => l[0] === 'hacerCheckin')).toBe(false);
    await click('[data-campo="acepta-datos"]');
    await click('[data-accion="aceptar"]');
    await esperar(14);
    expect(api._s.llamadas).toContainEqual(['hacerCheckin', TOKEN_ENTRADA]);
    expect(m.hash.v).toBe('');
  });

  it('un QR con formato raro se descarta sin llamar al servidor', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    await montarCuenta(api, { hash: '#entrada=no-es-un-token' });
    expect(api._s.llamadas.some((l) => l[0] === 'hacerCheckin')).toBe(false);
    expect(texto('[data-campo="aviso"]')).toContain('no es válido');
  });

  it('si el servidor lo rechaza (QR rotado, tope diario) se lo dice tal cual', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    api._s.fallos.hacerCheckin = 'Este QR de entrada no es válido. Escanea el que está en la tienda.';
    await montarCuenta(api, { hash: '#entrada=' + TOKEN_ENTRADA });
    expect(texto('[data-campo="aviso"]')).toContain('Escanea el que está en la tienda');
    expect($('[data-campo="checkin"]').textContent).toContain('¿Estás en la tienda?');
  });

  it('reclama los puntos de una compra con #qr= y el saldo sube', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: 10 });
    const m = await montarCuenta(api, { hash: '#qr=' + TOKEN_QR });
    expect(api._s.llamadas).toContainEqual(['reclamarQr', TOKEN_QR]);
    expect(texto('[data-campo="aviso"]')).toContain('Sumaste 25 puntos');
    expect(texto('[data-campo="saldo"]')).toBe('35');
    expect(m.hash.v).toBe('');
  });

  it('un QR ya usado muestra el motivo del servidor', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    api._s.fallos.reclamarQr = 'Este QR no es válido, ya se usó o venció.';
    await montarCuenta(api, { hash: '#qr=' + TOKEN_QR });
    expect(texto('[data-campo="aviso"]')).toContain('ya se usó o venció');
    expect(texto('[data-campo="saldo"]')).toBe('0');
  });
});

describe('inicio: puntos, progreso y compra en curso', () => {
  it('muestra el saldo y cuánto falta para el premio más cercano', async () => {
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: 50 }));
    expect(texto('[data-campo="saldo"]')).toBe('50');
    expect(texto('[data-campo="progreso"]')).toBe('Te faltan 70 puntos para tu premio de bowl Pequeño.');
    expect($('.barra-llena').getAttribute('style')).toContain('42%');
  });

  it('con puntos suficientes avisa que ya puede canjear', async () => {
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: 125 }));
    expect(texto('[data-campo="progreso"]')).toBe('¡Ya puedes canjear tu premio!');
    expect($('.barra-llena').getAttribute('style')).toContain('100%');
  });

  it('un saldo negativo se muestra sin romper la barra', async () => {
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: -5 }));
    expect($('.barra-llena').getAttribute('style')).toContain('0%');
    expect(texto('[data-campo="progreso"]')).toContain('Te faltan 120');
  });

  it('la compra confirmada aparece "Por pagar" con detalle y total, y se actualiza sola al sondear', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    const m = await montarCuenta(api);
    expect($('[data-campo="compra"]')).toBeNull();
    api._s.compra = copia(COMPRA_POR_PAGAR);
    await m.cuenta.sondear();
    expect(texto('[data-campo="estado-compra"]')).toBe('Por pagar');
    const t = texto('[data-campo="compra"]');
    expect(t).toContain('Amazonas Pequeño');
    expect(t).toContain('Miel');
    expect(t).toContain('2 × Café espresso');
    expect(t).toContain('$20.900');
    expect(texto('[data-campo="total"]')).toBe('$27.900');
    expect(t).toContain('Descuento −$3.100');
  });

  it('al pagarse muestra "Pagado" con los puntos nuevos y actualiza el saldo y el historial', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: 10, compra: copia(COMPRA_POR_PAGAR) });
    const m = await montarCuenta(api);
    expect(texto('[data-campo="saldo"]')).toBe('10');
    api._s.compra = { ...copia(COMPRA_POR_PAGAR), estado: 'pagada', medio_pago: 'efectivo', puntos_ganados: 27 };
    api._s.saldo = 37;
    api._s.perfil.compras_pagadas = 1;
    await m.cuenta.sondear();
    expect(texto('[data-campo="estado-compra"]')).toBe('Pagado');
    expect(texto('[data-campo="puntos-ganados"]')).toBe('¡Sumaste 27 puntos!');
    expect(texto('[data-campo="saldo"]')).toBe('37');
    expect($('[data-accion="esto-no-es"]')).toBeNull();      // ya pagada: no se reporta desde aquí
  });

  it('no repinta si nada cambió (no pierde lo que la persona está escribiendo)', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, compra: copia(COMPRA_POR_PAGAR) });
    const m = await montarCuenta(api);
    await click('[data-accion="esto-no-es"]');
    await escribir('[data-campo="nota"]', 'Pedí sin miel');
    const antes = $('[data-campo="nota"]');
    await m.cuenta.sondear();
    await m.cuenta.sondear();
    expect($('[data-campo="nota"]')).toBe(antes);
    expect($('[data-campo="nota"]').value).toBe('Pedí sin miel');
  });

  it('con una compra en curso ya no pregunta si está en la tienda (lo están atendiendo)', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    const m = await montarCuenta(api);
    expect(texto('[data-campo="checkin"]')).toContain('¿Estás en la tienda?');
    api._s.compra = copia(COMPRA_POR_PAGAR);
    await m.cuenta.sondear();
    expect($('[data-campo="checkin"]')).toBeNull();
  });

  it('el sondeo se programa cada 3 segundos', async () => {
    const m = await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS }));
    expect(m.temporizadores).toHaveLength(1);
    expect(m.temporizadores[0].ms).toBe(3000);
  });
});

describe('"esto no es lo que pedí"', () => {
  it('avisa al vendedor con la nota y confirma sin dejar cancelar nada', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, compra: copia(COMPRA_POR_PAGAR) });
    await montarCuenta(api);
    await click('[data-accion="esto-no-es"]');
    await escribir('[data-campo="nota"]', 'Pedí sin miel');
    await click('[data-accion="enviar-reporte"]');
    expect(api._s.llamadas).toContainEqual(['reportarPedido', 'v-1', 'Pedí sin miel']);
    expect(texto('[data-campo="reportado"]')).toContain('Ya le avisamos al vendedor');
    expect($('[data-accion="esto-no-es"]')).toBeNull();
    expect($('[data-accion="cancelar-compra"]')).toBeNull();
  });

  it('se puede arrepentir, y un error del servidor se muestra', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, compra: copia(COMPRA_POR_PAGAR) });
    await montarCuenta(api);
    await click('[data-accion="esto-no-es"]');
    await click('[data-accion="cancelar-reporte"]');
    expect($('[data-accion="esto-no-es"]')).not.toBeNull();
    api._s.fallos.reportarPedido = 'Ya avisaste varias veces sobre este pedido. Habla con el personal.';
    await click('[data-accion="esto-no-es"]');
    await click('[data-accion="enviar-reporte"]');
    expect(texto('[data-form="reporte"] .error')).toContain('Habla con el personal');
  });
});

describe('premios', () => {
  it('lista los tamaños con sus puntos y cuánto falta', async () => {
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: 125 }));
    await click('[data-pestana="premios"]');
    expect($$('[data-premio]').map((e) => e.dataset.premio)).toEqual(['pequeno', 'mediano', 'grande']);
    expect($('[data-accion="canjear-pequeno"]')).not.toBeNull();
    expect($('[data-accion="canjear-mediano"]')).toBeNull();
    expect(texto('[data-campo="faltan-mediano"]')).toBe('Te faltan 5');
    expect(texto('[data-premio="pequeno"]')).toContain('50% de descuento · 120 puntos');
  });

  it('canjear pide confirmación, descuenta y muestra el premio con su vigencia', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: 125 });
    await montarCuenta(api);
    await click('[data-pestana="premios"]');
    await click('[data-accion="canjear-pequeno"]');
    expect(texto('[data-campo="confirmar-canje"]')).toContain('120 puntos');
    expect(texto('[data-campo="confirmar-canje"]')).toContain('45 días');
    expect(api._s.llamadas.some((l) => l[0] === 'canjear')).toBe(false);     // aún no
    await click('[data-accion="confirmar-canje"]');
    await esperar(10);
    expect(api._s.llamadas).toContainEqual(['canjear', 'pequeno']);
    expect(texto('[data-vista="premios"] .aviso')).toContain('Canjeaste 120 puntos');
    expect(texto('[data-voucher]')).toContain('50% de descuento en un bowl Pequeño');
    expect(texto('[data-voucher]')).toContain('Vence el 25 dic');
    expect($('[data-accion="canjear-pequeno"]')).toBeNull();                 // ya no le alcanza
  });

  it('un error del canje (otro dispositivo gastó los puntos) se muestra', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, saldo: 125 });
    await montarCuenta(api);
    await click('[data-pestana="premios"]');
    await click('[data-accion="canjear-pequeno"]');
    api._s.saldo = 20;
    await click('[data-accion="confirmar-canje"]');
    await esperar(6);
    expect(texto('[data-campo="confirmar-canje"] .error')).toContain('Te faltan 100 puntos');
  });

  it('muestra el regalo de bienvenida (toppings gratis) y los premios con vigencia', async () => {
    const vouchers = [
      { id: 'w-a', tipo: 'bienvenida', modalidad: 'toppings_gratis', cantidad_toppings: 1, estado: 'activo', vence_en: '2026-12-20T12:00:00Z' },
      { id: 'w-b', tipo: 'premio', modalidad: 'descuento_linea', descuento_pct: 50, tamanos: ['grande'], estado: 'activo', vence_en: '2026-12-25T12:00:00Z' },
    ];
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, vouchers }));
    await click('[data-pestana="premios"]');
    expect(texto('[data-voucher="w-a"]')).toContain('Regalo de bienvenida');
    expect(texto('[data-voucher="w-a"]')).toContain('1 topping gratis');
    expect(texto('[data-voucher="w-b"]')).toContain('bowl Grande');
  });

  it('sin premios lo dice', async () => {
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS }));
    await click('[data-pestana="premios"]');
    expect(texto('[data-campo="sin-premios"]')).toBe('Todavía no tienes premios listos.');
  });
});

describe('historial', () => {
  it('muestra las compras y los movimientos de puntos', async () => {
    const compras = [{ venta_id: 'v-2', numero: 90, pagada_en: '2026-11-08T17:00:00Z', total_cop: 19900, descuento_cop: 0, medio_pago: 'transferencia', puntos: 19,
      lineas: [{ producto: 'Selva', tamano: 'grande', cantidad: 1 }] }];
    const movimientos = [{ tipo: 'suma', puntos: 19, creado_en: '2026-11-08T17:00:00Z' }, { tipo: 'canje', puntos: -120, creado_en: '2026-11-09T17:00:00Z' }];
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, compras, movimientos }));
    await click('[data-pestana="historial"]');
    await esperar(6);
    expect(texto('[data-venta="v-2"]')).toContain('8 nov · $19.900');
    expect(texto('[data-venta="v-2"]')).toContain('Selva Grande');
    expect(texto('[data-venta="v-2"]')).toContain('Transferencia · +19 puntos');
    const t = texto('[data-vista="historial"]');
    expect(t).toContain('Puntos por tu compra');
    expect(t).toContain('Canje de premio');
    expect(t).toContain('+19');
    expect(t).toContain('-120');
  });

  it('vacío lo dice', async () => {
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS }));
    await click('[data-pestana="historial"]');
    await esperar(6);
    expect(texto('[data-campo="sin-compras"]')).toContain('Todavía no tienes compras');
    expect(texto('[data-campo="sin-movimientos"]')).toContain('Aún no tienes movimientos');
  });
});

describe('perfil: celular y cumpleaños (con motivo, después de la primera compra)', () => {
  it('antes de comprar no se piden', async () => {
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS }));
    expect($('[data-campo="pedir-perfil"]')).toBeNull();
  });

  it('tras la primera compra pagada se piden con su motivo; "ahora no" lo oculta y no vuelve', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: { acepta_datos: true, compras_pagadas: 1 } });
    const m = await montarCuenta(api);
    expect(texto('[data-campo="pedir-perfil"]')).toContain('opcionales');
    expect(texto('[data-campo="pedir-perfil"]')).toContain('cumpleaños');
    await click('[data-accion="perfil-ahora-no"]');
    expect($('[data-campo="pedir-perfil"]')).toBeNull();
    const m2 = await montarCuenta(api, { almacen: [...m.almacen.entries()] });
    expect($('[data-campo="pedir-perfil"]')).toBeNull();
    expect(m2.almacen.size).toBeGreaterThan(0);
  });

  it('guarda el celular y el cumpleaños y deja de pedirlos', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: { acepta_datos: true, compras_pagadas: 1 } });
    await montarCuenta(api);
    await escribir('[data-campo="pedir-perfil"] [data-campo="celular"]', '300 123 4567');
    await escribir('[data-campo="pedir-perfil"] [data-campo="cumpleanos"]', '1990-05-17');
    await click('[data-campo="pedir-perfil"] [data-accion="guardar-perfil"]');
    await esperar(8);
    expect(api._s.llamadas).toContainEqual(['actualizarPerfil', '300 123 4567', '1990-05-17']);
    expect($('[data-campo="pedir-perfil"]')).toBeNull();
    expect(texto('[data-campo="aviso"]')).toContain('Guardamos tus datos');
  });

  it('desde Mi perfil se pueden cambiar los datos y el permiso de mensajes', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: { acepta_datos: true, celular: '3001112233' } });
    await montarCuenta(api);
    await click('[data-pestana="perfil"]');
    expect(texto('[data-vista="perfil"]')).toContain('Laura Patiño Ruiz');
    expect(texto('[data-vista="perfil"]')).toContain('laura@correo.test');
    expect($('[data-campo="celular"]').value).toBe('3001112233');
    await click('[data-campo="mensajes"]');
    await esperar(8);
    expect(api._s.llamadas).toContainEqual(['consentir', 'mensajes', '2026-11-v1', true]);
    expect(api._s.perfil.acepta_mensajes).toBe(true);
  });
});

describe('seguridad y sesión', () => {
  it('cuenta de personal: no abre la cuenta de cliente y deja salir', async () => {
    const api = crearFakeCuenta({ sesion: SESION, esPersonal: true });
    await montarCuenta(api);
    expect(texto('[data-campo="error"]')).toContain('cuenta de cliente');
    expect($('[data-vista="inicio"]')).toBeNull();
    await click('[data-accion="salir"]');
    await esperar(6);
    expect($('[data-form="correo"]')).not.toBeNull();
  });

  it('nunca pinta HTML que venga en los datos', async () => {
    const compra = copia(COMPRA_POR_PAGAR);
    compra.lineas[0].producto = '<img src=x onerror=alert(1)>';
    await montarCuenta(crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS, compra }));
    expect($('img[src="x"]')).toBeNull();
    expect(texto('[data-campo="compra"]')).toContain('<img src=x');
  });

  it('cerrar sesión vuelve al acceso y borra un QR pendiente', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    const m = await montarCuenta(api);
    m.almacen.set('naidi.cuenta.pendiente', JSON.stringify({ tipo: 'entrada', token: TOKEN_ENTRADA }));
    await click('[data-pestana="perfil"]');
    await click('[data-accion="salir"]');
    await esperar(6);
    expect(api._s.llamadas.some((l) => l[0] === 'salir')).toBe(true);
    expect($('[data-form="correo"]')).not.toBeNull();
    expect(m.almacen.has('naidi.cuenta.pendiente')).toBe(false);
  });

  it('sin internet al abrir muestra el aviso y no una pantalla en blanco', async () => {
    const api = crearFakeCuenta({ sesion: SESION, perfil: CON_DATOS });
    api._s.red = false;
    await montarCuenta(api);
    expect(texto('[data-campo="error"]')).toContain('No hay conexión');
  });
});
