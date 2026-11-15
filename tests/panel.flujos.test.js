import { describe, it, expect } from 'vitest';
import { crearPanel } from '../src/panel/app.js';
import { textoAlerta } from '../src/panel/ui/alertas.js';
import { ErrorRed, ErrorServidor } from '../src/lib/errores.js';
import { click, escribir, texto, esperar, $, $$ } from './ayudas/montar.js';

// La hora del panel en las pruebas es 2026-11-10T15:00:00Z (10:00 en Bogotá).
const AHORA = new Date('2026-11-10T15:00:00Z');
const ANA = { nombre: 'Ana María Torres Gil', correo: 'ana@naidi.test' };

const alertaNoLlego = (extra) => ({ id: 1, tipo: 'no_llego', venta_id: null, cliente_id: 'c-ana', cliente: ANA, creada_en: '2026-11-10T14:00:00Z', resuelta_en: null, nota: null, detalle: { pedidos_no_llego: 3, ultimo_numero: 7 }, ...extra });
const alertaBold = (extra) => ({ id: 2, tipo: 'pago_bold', venta_id: null, cliente_id: 'c-ana', cliente: ANA, creada_en: '2026-11-10T14:30:00Z', resuelta_en: null, nota: null, detalle: { motivo: 'pedido_cerrado', pedido: 12, estado_pedido: 'cancelado', order_id: 'NW12-abc', monto: 4000 }, ...extra });

// Servidor simulado: imita lo esencial de las funciones SQL (las reales se prueban con pgTAP).
function crearFakePanel(opciones) {
  const o = opciones || {};
  const s = {
    sesion: o.sesion === undefined ? null : o.sesion,
    rol: o.rol || 'dueno',
    nivel: o.nivel || 'aal2',
    factor: o.factor || null,
    activo: true,
    verificacionVencida: !!o.verificacionVencida,
    pin: o.pin === null ? null : (o.pin || '4321'),
    alertas: o.alertas || [],
    resueltas: o.resueltas || [],
    cuentas: o.cuentas || [],
    pantallas: o.pantallas || [],
    reglas: o.reglas || [
      { clave: 'puntos.cop_por_punto', version: 2, valor: 1000, descripcion: 'Pesos por punto.', publica: true, vigente_desde: '2026-11-09T10:00:00Z', vigente_hasta: null },
      { clave: 'puntos.cop_por_punto', version: 1, valor: 1500, descripcion: 'Pesos por punto.', publica: true, vigente_desde: '2026-11-01T10:00:00Z', vigente_hasta: '2026-11-09T10:00:00Z' },
      { clave: 'pin.max_intentos', version: 1, valor: 5, descripcion: 'Intentos de PIN.', publica: false, vigente_desde: '2026-11-01T10:00:00Z', vigente_hasta: null },
    ],
    banderas: o.banderas || [
      { clave: 'pago_en_linea_bold', activa: true, desde: null, hasta: null, descripcion: 'Pago en línea con Bold.' },
      { clave: 'referidos', activa: false, desde: null, hasta: null, descripcion: 'Fase 2: referidos.' },
    ],
    punto: o.punto || { token: 'a'.repeat(48), rotado_en: null },
    auditoria: o.auditoria || [
      { id: 2, en: '2026-11-10T14:00:00Z', accion: 'cambiar_regla', entidad: 'regla', entidad_id: 'puntos.cop_por_punto', actor: 'Javier', detalle: { version: 2, anterior: 1500, nuevo: 1000 } },
      { id: 1, en: '2026-11-10T13:00:00Z', accion: 'anular_venta', entidad: 'venta', entidad_id: 'v-9', actor: 'Javier', detalle: { motivo: 'error de digitación' } },
    ],
    pagos: o.pagos || { activo: true, pendientes: [], devoluciones: [], recientes: [], ultima_conciliacion: null },
    llamadas: [],
    red: true,
  };
  const reg = (n, a) => s.llamadas.push([n, a]);
  const red = () => { if (!s.red) throw new ErrorRed(); };
  const copia = (x) => JSON.parse(JSON.stringify(x));
  const pinMal = () => ({ ok: false, error: 'pin_incorrecto', intentos_restantes: 4 });
  return {
    _s: s,
    async sesion() { return s.sesion ? { ...s.sesion, nivel: s.nivel, siguiente: 'aal2' } : null; },
    async enviarCodigo() { red(); },
    async verificarCodigo(correo) { red(); s.sesion = { id: 'u-1', email: correo }; },
    async mfaFactor() { return s.factor; },
    async mfaEnrolar() { return { id: 'f-nuevo', qr: 'data:image/svg+xml;base64,AAA', secreto: 'ABCD' }; },
    async mfaVerificar() { s.nivel = 'aal2'; },
    async miPerfilDePersonal() { return s.activo ? { rol: s.rol, nombre: 'Persona', activo: true } : null; },
    async salir() { reg('salir'); s.sesion = null; },
    async tengoPin() { red(); return s.pin !== null; },
    async fijarPin(nuevo, actual) {
      red(); reg('fijarPin', [nuevo, actual]);
      if (s.pin !== null && actual !== s.pin) return pinMal();
      s.pin = nuevo;
      return { ok: true };
    },
    async restablecerPin(nuevo) {
      red(); reg('restablecerPin', [nuevo]);
      if (s.verificacionVencida) return { ok: false, error: 'verificacion_vencida' };
      s.pin = nuevo;
      return { ok: true };
    },
    async listaAlertas(resueltas) { red(); reg('listaAlertas', !!resueltas); return copia(resueltas ? s.resueltas : s.alertas); },
    async resolverAlerta(id, nota) {
      red(); reg('resolverAlerta', [id, nota]);
      const a = s.alertas.find((x) => x.id === id);
      if (!a) throw new ErrorServidor('Esa alerta no existe o ya se resolvió.');
      s.alertas = s.alertas.filter((x) => x.id !== id);
      s.resueltas.unshift({ ...a, resuelta_en: '2026-11-10T15:00:00Z', nota });
      s.pagos.devoluciones = s.pagos.devoluciones.filter((d) => d.alerta_id !== id);
    },
    async cuentasRestringidas() { red(); return copia(s.cuentas); },
    async restringirCuenta(cliente, modo, motivo, pin) {
      red(); reg('restringirCuenta', [cliente, modo, motivo, pin]);
      if (pin !== s.pin) return pinMal();
      s.cuentas = s.cuentas.filter((c) => c.cliente_id !== cliente);
      if (modo) s.cuentas.push({ cliente_id: cliente, nombre: ANA.nombre, correo: ANA.correo, modo, motivo, fijada_en: '2026-11-10T15:00:00Z', no_llego: 3 });
      s.alertas = s.alertas.filter((a) => !(a.tipo === 'no_llego' && a.cliente_id === cliente));
      return { ok: true, modo };
    },
    async listarPantallas() { red(); return copia(s.pantallas); },
    async emitirPantalla(nombre, pin) {
      red(); reg('emitirPantalla', [nombre, pin]);
      if (pin !== s.pin) return pinMal();
      s.pantallas.unshift({ id: 'd-' + (s.pantallas.length + 1), nombre, creado_en: '2026-11-10T15:00:00Z', ultimo_uso: null, revocado_en: null, activo: true });
      return { ok: true, id: s.pantallas[0].id, llave: 'nd_' + 'ab'.repeat(32) };
    },
    async revocarPantalla(id, pin) {
      red(); reg('revocarPantalla', [id, pin]);
      if (pin !== s.pin) return pinMal();
      const p = s.pantallas.find((x) => x.id === id);
      p.activo = false; p.revocado_en = '2026-11-10T15:00:00Z';
      return { ok: true };
    },
    async pagosBold() { red(); return copia(s.pagos); },
    async reporteVentas(desde, hasta) { red(); reg('reporteVentas', [desde, hasta]); return { totales: { ventas: 3, total_cop: 30000, ticket_promedio_cop: 10000 }, por_sabor: [], por_tamano: [], por_hora: [], por_canal: [] }; },
    async reporteCanjes(desde, hasta) { red(); reg('reporteCanjes', [desde, hasta]); return { canjes: { cantidad: 0, puntos: 0 }, puntos_acreditados: 0, costo_total_cop: 0, costo_sobre_ventas_pct: 0, costo_premios: [] }; },
    async listarReglas() { red(); return copia(s.reglas); },
    async cambiarRegla(clave, valor, pin) {
      red(); reg('cambiarRegla', [clave, valor, pin]);
      if (pin !== s.pin) return pinMal();
      const vigente = s.reglas.find((r) => r.clave === clave && !r.vigente_hasta);
      vigente.vigente_hasta = '2026-11-10T15:00:00Z';
      s.reglas.push({ ...vigente, version: vigente.version + 1, valor, vigente_desde: '2026-11-10T15:00:00Z', vigente_hasta: null });
      return { ok: true, clave, version: vigente.version + 1 };
    },
    async listarBanderas() { red(); return copia(s.banderas); },
    async cambiarBandera(clave, activa, desde, hasta, pin) {
      red(); reg('cambiarBandera', [clave, activa, desde, hasta, pin]);
      if (pin !== s.pin) return pinMal();
      s.banderas.find((b) => b.clave === clave).activa = activa;
      return { ok: true, clave, activa };
    },
    async puntoDeVenta() { red(); return copia(s.punto); },
    async rotarTokenEntrada(pin) {
      red(); reg('rotarTokenEntrada', [pin]);
      if (pin !== s.pin) return pinMal();
      s.punto = { token: 'b'.repeat(48), rotado_en: '2026-11-10T15:00:00Z' };
      return { ok: true, token: s.punto.token };
    },
    async auditoria(limite) { red(); reg('auditoria', limite); return copia(s.auditoria); },
  };
}

async function montar(api, opciones) {
  const o = opciones || {};
  document.body.innerHTML = '<div id="app"></div>';
  const raiz = document.getElementById('app');
  const panel = crearPanel({ raiz, api, ahora: () => AHORA, origen: () => 'https://naidi.test', setInterval: () => 0, setTimeout: () => 0, ...(o.cfg || {}) });
  panel.iniciar();
  await esperar();
  return { panel, raiz };
}

async function entrar(api, opciones) {
  const m = await montar(api, opciones);
  if (!$('[data-campo="correo"]')) { await esperar(12); return m; }
  await escribir('[data-campo="correo"]', 'javier@naidi.test');
  await click('[data-accion="enviar-codigo"]');
  await escribir('[data-campo="codigo"]', '123456');
  await click('[data-accion="verificar-codigo"]');
  await esperar(12);
  return m;
}

// Responde el modal de texto o de PIN que esté abierto.
async function responder(valor) {
  if (valor !== undefined) await escribir('[data-campo="texto"]', valor);
  await click('[data-accion="aceptar-texto"]');
}
const irA = (nombre) => click('[data-pestana="' + nombre + '"]');

describe('Panel: acceso', () => {
  it('un cajero no entra: se cierra su sesión y se le dice que es solo para el dueño', async () => {
    const api = crearFakePanel({ rol: 'cajero' });
    await entrar(api);
    expect(texto('[data-zona="error"]')).toContain('solo para el dueño');
    expect($('[data-pestana]')).toBeNull();
    expect(api._s.llamadas.some((l) => l[0] === 'salir')).toBe(true);
  });

  it('una cuenta que no es del personal tampoco entra', async () => {
    const api = crearFakePanel({ rol: 'dueno' });
    api._s.activo = false;
    await entrar(api);
    expect($('[data-pestana]')).toBeNull();
    expect(texto('[data-zona="error"]')).toContain('no tiene acceso');
  });

  it('el dueño sin segundo factor activo lo verifica antes de ver nada', async () => {
    const api = crearFakePanel({ nivel: 'aal1', factor: 'f-1' });
    await entrar(api);
    expect($('[data-campo="mfa"]')).not.toBeNull();
    expect($('[data-pestana]')).toBeNull();
    await escribir('[data-campo="mfa"]', '123456');
    await click('[data-accion="verificar-mfa"]');
    await esperar(12);
    expect($$('[data-pestana]').map((b) => b.dataset.pestana)).toEqual(['alertas', 'cuentas', 'pantallas', 'pagos', 'reportes', 'reglas', 'banderas', 'entrada', 'auditoria']);
  });

  it('el título es del panel y entra directo al dueño con sesión ya iniciada', async () => {
    const api = crearFakePanel({ sesion: { id: 'u-1', email: 'javier@naidi.test' } });
    await montar(api);
    await esperar(12);
    expect(texto('.cabecera')).toContain('Panel del dueño');
    expect(texto('.cabecera')).toContain('javier@naidi.test');
  });

  it('salir vuelve a pedir el acceso', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await click('[data-accion="salir"]');
    await esperar(6);
    expect($('[data-campo="correo"]')).not.toBeNull();
    expect(texto('.titulo')).toBe('Panel Naidi');
  });
});

describe('Panel: PIN del dueño', () => {
  it('sin PIN lo avisa de entrada; con PIN no muestra el aviso', async () => {
    const sin = crearFakePanel({ pin: null });
    await entrar(sin);
    expect($('[data-zona="sin-pin"]').hidden).toBe(false);
    expect(texto('[data-zona="sin-pin"]')).toContain('Aún no tienes un PIN');
    const con = crearFakePanel();
    await entrar(con);
    expect($('[data-zona="sin-pin"]').hidden).toBe(true);
  });

  it('crear el PIN pide el nuevo dos veces, no pide el actual y esconde el aviso', async () => {
    const api = crearFakePanel({ pin: null });
    await entrar(api);
    await click('[data-accion="crear-pin"]');
    await responder('2468');
    await responder('2468');
    expect(api._s.llamadas.filter((l) => l[0] === 'fijarPin')[0][1]).toEqual(['2468', null]);
    expect(texto('.avisos')).toContain('PIN creado');
    expect($('[data-zona="sin-pin"]').hidden).toBe(true);
    expect(api._s.pin).toBe('2468');
  });

  it('cambiar el PIN pide primero el actual', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await click('[data-accion="mi-pin"]');
    await responder('4321');
    await responder('9753');
    await responder('9753');
    expect(api._s.llamadas.filter((l) => l[0] === 'fijarPin')[0][1]).toEqual(['9753', '4321']);
    expect(texto('.avisos')).toContain('PIN cambiado');
  });

  it('con el PIN actual equivocado avisa los intentos que quedan y no cambia nada', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await click('[data-accion="mi-pin"]');
    await responder('0000');
    await responder('9753');
    await responder('9753');
    expect(texto('.avisos')).toContain('PIN incorrecto');
    expect(api._s.pin).toBe('4321');
  });

  it('un PIN que no son 4 a 8 dígitos ni se envía', async () => {
    const api = crearFakePanel({ pin: null });
    await entrar(api);
    await click('[data-accion="crear-pin"]');
    await responder('12');
    expect(texto('.avisos')).toContain('entre 4 y 8 dígitos');
    expect(api._s.llamadas.some((l) => l[0] === 'fijarPin')).toBe(false);
  });

  it('si los dos PIN no coinciden no cambia nada', async () => {
    const api = crearFakePanel({ pin: null });
    await entrar(api);
    await click('[data-accion="crear-pin"]');
    await responder('2468');
    await responder('2469');
    expect(texto('.avisos')).toContain('no coinciden');
    expect(api._s.pin).toBeNull();
  });

  it('"Olvidé mi PIN": pide el código de la app de verificación y crea un PIN nuevo sin pedir el actual', async () => {
    const api = crearFakePanel({ factor: 'f-1' });
    await entrar(api);
    await click('[data-accion="olvide-pin"]');
    await responder('654321');
    await responder('1357');
    await responder('1357');
    expect(api._s.llamadas.filter((l) => l[0] === 'restablecerPin')[0][1]).toEqual(['1357']);
    expect(api._s.llamadas.some((l) => l[0] === 'fijarPin')).toBe(false);
    expect(texto('.avisos')).toContain('PIN restablecido');
    expect(api._s.pin).toBe('1357');
  });

  it('"Olvidé mi PIN": si el servidor dice que la verificación venció, no cambia nada y lo explica', async () => {
    const api = crearFakePanel({ factor: 'f-1', verificacionVencida: true });
    await entrar(api);
    await click('[data-accion="olvide-pin"]');
    await responder('654321');
    await responder('1357');
    await responder('1357');
    expect(texto('.avisos')).toContain('Vuelve a empezar');
    expect(api._s.pin).toBe('4321');
  });

  it('"Olvidé mi PIN": cancelar el código no cambia nada', async () => {
    const api = crearFakePanel({ factor: 'f-1' });
    await entrar(api);
    await click('[data-accion="olvide-pin"]');
    await click('[data-accion="cancelar-texto"]');
    expect(api._s.llamadas.some((l) => l[0] === 'restablecerPin')).toBe(false);
  });

  it('cancelar en cualquier paso no cambia nada', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await click('[data-accion="mi-pin"]');
    await click('[data-accion="cancelar-texto"]');
    expect(api._s.llamadas.some((l) => l[0] === 'fijarPin')).toBe(false);
  });
});

describe('Panel: alertas', () => {
  it('muestra cada alerta en español claro, con la persona y su correo', async () => {
    const api = crearFakePanel({ alertas: [alertaNoLlego(), alertaBold()] });
    await entrar(api);
    const t = texto('[data-alerta="1"]');
    expect(t).toContain('Ana María Torres Gil (ana@naidi.test) no recogió 3 pedidos web');
    expect(t).toContain('#7');
    expect(texto('[data-alerta="2"]')).toContain('Bold cobró $4.000 por el pedido #12');
    expect(texto('[data-alerta="2"]')).not.toContain('pedido_cerrado');
  });

  it('sin alertas lo dice y no deja ningún conteo en la pestaña', async () => {
    await entrar(crearFakePanel());
    expect(texto('[data-campo="sin-alertas"]')).toContain('No hay alertas abiertas');
    expect($('[data-pestana="alertas"]').textContent).toBe('Alertas');
  });

  it('la pestaña lleva el número de alertas abiertas', async () => {
    await entrar(crearFakePanel({ alertas: [alertaNoLlego(), alertaBold()] }));
    expect($('[data-pestana="alertas"]').textContent).toBe('Alertas (2)');
  });

  it('resolver una alerta pide qué pasó y la manda con esa nota', async () => {
    const api = crearFakePanel({ alertas: [alertaBold()] });
    await entrar(api);
    await click('[data-alerta="2"] [data-accion="resolver-alerta"]');
    await responder('Devolución hecha en Bold');
    expect(api._s.llamadas.filter((l) => l[0] === 'resolverAlerta')[0][1]).toEqual([2, 'Devolución hecha en Bold']);
    expect($('[data-alerta="2"]')).toBeNull();
    expect($('[data-pestana="alertas"]').textContent).toBe('Alertas');
  });

  it('cancelar el motivo no resuelve nada', async () => {
    const api = crearFakePanel({ alertas: [alertaBold()] });
    await entrar(api);
    await click('[data-alerta="2"] [data-accion="resolver-alerta"]');
    await click('[data-accion="cancelar-texto"]');
    expect(api._s.llamadas.some((l) => l[0] === 'resolverAlerta')).toBe(false);
    expect($('[data-alerta="2"]')).not.toBeNull();
  });

  it('"No llegó": exigir prepago pide motivo y PIN, restringe la cuenta y la alerta desaparece', async () => {
    const api = crearFakePanel({ alertas: [alertaNoLlego()] });
    await entrar(api);
    await click('[data-accion="exigir-prepago"]');
    await responder('No llegó tres veces');
    await responder('4321');
    expect(api._s.llamadas.filter((l) => l[0] === 'restringirCuenta')[0][1]).toEqual(['c-ana', 'prepago', 'No llegó tres veces', '4321']);
    expect($('[data-alerta="1"]')).toBeNull();
    expect(texto('.avisos')).toContain('solo podrá pedir pagando en línea');
  });

  it('bloquear pedidos web sin escribir motivo también funciona', async () => {
    const api = crearFakePanel({ alertas: [alertaNoLlego()] });
    await entrar(api);
    await click('[data-accion="bloquear"]');
    await responder('');
    await responder('4321');
    expect(api._s.llamadas.filter((l) => l[0] === 'restringirCuenta')[0][1]).toEqual(['c-ana', 'bloqueo', '', '4321']);
    expect(texto('.avisos')).toContain('ya no puede hacer pedidos web');
  });

  it('con un PIN incorrecto avisa cuántos intentos quedan y la alerta sigue abierta', async () => {
    const api = crearFakePanel({ alertas: [alertaNoLlego()] });
    await entrar(api);
    await click('[data-accion="exigir-prepago"]');
    await responder('');
    await responder('0000');
    expect(texto('.avisos')).toContain('PIN incorrecto. Te quedan 4 intentos.');
    expect($('[data-alerta="1"]')).not.toBeNull();
  });

  it('se pueden ver las alertas ya resueltas, con su nota', async () => {
    const api = crearFakePanel({ resueltas: [alertaNoLlego({ id: 9, resuelta_en: '2026-11-09T20:00:00Z', nota: 'Decisión: bloqueo' })] });
    await entrar(api);
    await click('[data-accion="ver-resueltas"]');
    expect(texto('[data-lista="resueltas"]')).toContain('Decisión: bloqueo');
    expect($('[data-lista="resueltas"] [data-accion]')).toBeNull();
    await click('[data-accion="ver-resueltas"]');
    expect($('[data-lista="resueltas"]')).toBeNull();
  });

  it('sin conexión avisa y no deja la pantalla rota', async () => {
    const api = crearFakePanel({ alertas: [alertaBold()] });
    await entrar(api);
    api._s.red = false;
    await click('[data-accion="actualizar-alertas"]');
    expect(texto('.avisos')).toContain('Sin conexión');
    expect($('[data-alerta="2"]')).not.toBeNull();
  });

  it('el texto de cada alerta no deja ver nombres internos', () => {
    const tipos = ['venta_sin_pagar', 'compras_inusuales', 'reclamos_tope', 'cliente_reporta'];
    for (const tipo of tipos) {
      const t = textoAlerta({ tipo, cliente: ANA, detalle: { numero: 5, total_cop: 20000, cierre: '2026-11-10' } });
      expect(t).not.toMatch(/_/);
    }
    const motivos = ['monto_distinto', 'pago_duplicado', 'pedido_cerrado', 'anulado_pedido_cerrado', 'otro'];
    for (const motivo of motivos) {
      expect(textoAlerta({ tipo: 'pago_bold', detalle: { motivo, pedido: 3, monto: 4000, esperado: 4000, recibido: 3000, estado_pedido: 'cancelado' } })).not.toMatch(/monto_distinto|pago_duplicado|pedido_cerrado|anulado_pedido_cerrado/);
    }
  });
});

describe('Panel: cuentas con restricción', () => {
  const cuenta = (extra) => ({ cliente_id: 'c-ana', nombre: ANA.nombre, correo: ANA.correo, modo: 'prepago', motivo: 'No llegó tres veces', fijada_en: '2026-11-08T15:00:00Z', no_llego: 3, ...extra });

  it('lista las cuentas con su restricción, motivo y cuántas veces no llegaron', async () => {
    await entrar(crearFakePanel({ cuentas: [cuenta()] }));
    await irA('cuentas');
    const t = texto('[data-cliente="c-ana"]');
    expect(t).toContain('Ana María Torres Gil');
    expect(t).toContain('prepago');
    expect(t).toContain('No llegó tres veces');
    expect(t).toContain('3');
  });

  it('sin cuentas lo dice', async () => {
    await entrar(crearFakePanel());
    await irA('cuentas');
    expect(texto('[data-campo="sin-cuentas"]')).toContain('No hay cuentas con restricción');
  });

  it('quitar la restricción pide confirmar y PIN, y manda modo nulo', async () => {
    const api = crearFakePanel({ cuentas: [cuenta()] });
    await entrar(api);
    await irA('cuentas');
    await click('[data-accion="quitar-restriccion"]');
    await click('[data-accion="si-confirmar"]');
    await responder('4321');
    expect(api._s.llamadas.filter((l) => l[0] === 'restringirCuenta')[0][1]).toEqual(['c-ana', null, null, '4321']);
    expect($('[data-cliente="c-ana"]')).toBeNull();
    expect(texto('.avisos')).toContain('Restricción quitada');
  });

  it('no quita nada si se arrepiente en la confirmación', async () => {
    const api = crearFakePanel({ cuentas: [cuenta()] });
    await entrar(api);
    await irA('cuentas');
    await click('[data-accion="quitar-restriccion"]');
    await click('[data-accion="no-confirmar"]');
    expect(api._s.llamadas.some((l) => l[0] === 'restringirCuenta')).toBe(false);
  });

  it('pasar de prepago a bloqueo pide motivo y PIN', async () => {
    const api = crearFakePanel({ cuentas: [cuenta()] });
    await entrar(api);
    await irA('cuentas');
    await click('[data-accion="cambiar-modo"]');
    await responder('Reincidente');
    await responder('4321');
    expect(api._s.llamadas.filter((l) => l[0] === 'restringirCuenta')[0][1]).toEqual(['c-ana', 'bloqueo', 'Reincidente', '4321']);
    expect(texto('[data-cliente="c-ana"] [data-campo="modo"]')).toContain('bloqueados');
  });
});

describe('Panel: pantallas del iPad', () => {
  it('emitir muestra el enlace de activación una sola vez, y la lista no vuelve a mostrar la llave', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('pantallas');
    expect(texto('[data-campo="sin-pantallas"]')).toContain('no has emitido');
    await click('[data-accion="emitir-pantalla"]');
    await responder('iPad del mostrador');
    await responder('4321');
    expect($('[data-campo="enlace-activacion"]').value).toBe('https://naidi.test/pantalla/#llave=nd_' + 'ab'.repeat(32));
    expect(texto('.modal-caja')).toContain('Se muestra una sola vez');
    await click('[data-accion="cerrar-enlace"]');
    expect($('[data-campo="enlace-activacion"]')).toBeNull();
    expect(document.body.textContent).not.toContain('nd_abab');
    expect(texto('[data-tabla="pantallas"]')).toContain('iPad del mostrador');
    expect(texto('[data-tabla="pantallas"]')).toContain('Activa');
    expect(texto('[data-tabla="pantallas"]')).toContain('Nunca');
  });

  it('un PIN incorrecto no emite la llave', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('pantallas');
    await click('[data-accion="emitir-pantalla"]');
    await responder('iPad');
    await responder('9999');
    expect(texto('.avisos')).toContain('PIN incorrecto');
    expect($('[data-campo="enlace-activacion"]')).toBeNull();
    expect(api._s.pantallas).toHaveLength(0);
  });

  it('si ya hay el máximo de pantallas muestra el error del servidor', async () => {
    const api = crearFakePanel();
    api.emitirPantalla = async () => { throw new ErrorServidor('Ya hay el máximo de pantallas activas. Revoca una antes de emitir otra llave.'); };
    await entrar(api);
    await irA('pantallas');
    await click('[data-accion="emitir-pantalla"]');
    await responder('iPad 4');
    await responder('4321');
    expect(texto('.avisos')).toContain('máximo de pantallas activas');
  });

  it('revocar pide confirmar y PIN; la pantalla queda revocada y sin botón', async () => {
    const api = crearFakePanel({ pantallas: [{ id: 'd-1', nombre: 'iPad 1', creado_en: '2026-11-01T15:00:00Z', ultimo_uso: '2026-11-10T14:00:00Z', revocado_en: null, activo: true }] });
    await entrar(api);
    await irA('pantallas');
    await click('[data-accion="revocar-pantalla"]');
    await click('[data-accion="si-confirmar"]');
    await responder('4321');
    expect(api._s.llamadas.filter((l) => l[0] === 'revocarPantalla')[0][1]).toEqual(['d-1', '4321']);
    expect(texto('[data-pantalla="d-1"] [data-campo="estado"]')).toBe('Revocada');
    expect($('[data-pantalla="d-1"] [data-accion="revocar-pantalla"]')).toBeNull();
  });
});

describe('Panel: pagos Bold', () => {
  const devolucion = (extra) => ({ alerta_id: 2, creada_en: '2026-11-10T14:30:00Z', motivo: 'pedido_cerrado', pedido: 12, order_id: 'NW12-abc', cliente: ANA.nombre, correo: ANA.correo, monto_cop: 4000, bold_payment_id: 'bp-1', detalle: {}, ...extra });
  const pagos = (extra) => ({ activo: true, pendientes: [], devoluciones: [], recientes: [], ultima_conciliacion: null, ...extra });

  it('lista las devoluciones por resolver con lo necesario para hacerlas, y marcarlas deja constancia', async () => {
    const api = crearFakePanel({ alertas: [alertaBold()], pagos: pagos({ devoluciones: [devolucion()] }) });
    await entrar(api);
    expect($('[data-pestana="pagos"]').textContent).toBe('Pagos Bold (1)');
    await irA('pagos');
    const t = texto('[data-tabla="devoluciones"]');
    expect(t).toContain('#12');
    expect(t).toContain('Pagado con el pedido ya cerrado');
    expect(t).toContain('Ana María Torres Gil');
    expect(t).toContain('ana@naidi.test');
    expect(t).toContain('$4.000');
    expect(t).toContain('NW12-abc');
    await click('[data-accion="resolver-devolucion"]');
    await responder('Devolución hecha en Bold el 10/11');
    expect(api._s.llamadas.filter((l) => l[0] === 'resolverAlerta')[0][1]).toEqual([2, 'Devolución hecha en Bold el 10/11']);
    expect(texto('[data-campo="sin-devoluciones"]')).toContain('No hay devoluciones pendientes');
    expect($('[data-pestana="pagos"]').textContent).toBe('Pagos Bold');
    expect($('[data-alerta="2"]')).toBeNull();
  });

  it('muestra los pendientes y los pagos recientes con su estado', async () => {
    await entrar(crearFakePanel({ pagos: pagos({
      pendientes: [{ order_id: 'NW20-x', pedido: 20, monto_cop: 18000, creado_en: '2026-11-10T14:40:00Z', cliente: 'Beto Ruiz' }],
      recientes: [{ order_id: 'NW19-y', pedido: 19, monto_cop: 9500, estado: 'aprobado', medio: 'CARD', creado_en: '2026-11-10T13:00:00Z', confirmado_en: '2026-11-10T13:02:00Z' }],
    }) }));
    await irA('pagos');
    expect(texto('[data-tabla="pendientes"]')).toContain('Beto Ruiz');
    expect(texto('[data-tabla="pendientes"]')).toContain('$18.000');
    expect(texto('[data-tabla="recientes"]')).toContain('Aprobado');
    expect(texto('[data-tabla="recientes"]')).toContain('$9.500');
  });

  it('dice si el pago en línea está encendido o apagado', async () => {
    await entrar(crearFakePanel({ pagos: pagos({ activo: false }) }));
    await irA('pagos');
    expect(texto('[data-campo="estado-bold"]')).toBe('Pago en línea apagado');
  });

  it('avisa si la conciliación automática nunca ha corrido', async () => {
    await entrar(crearFakePanel());
    await irA('pagos');
    expect($('[data-campo="conciliacion"]').dataset.estado).toBe('sin-corridas');
    expect(texto('[data-campo="conciliacion"]')).toContain('no ha corrido nunca');
  });

  it('con una corrida reciente la da por viva y con una vieja avisa que se detuvo', async () => {
    await entrar(crearFakePanel({ pagos: pagos({ ultima_conciliacion: { corrida_en: '2026-11-10T14:55:00Z', revisados: 2, resumen: { aprobado: 1 } } }) }));
    await irA('pagos');
    expect($('[data-campo="conciliacion"]').dataset.estado).toBe('viva');
    expect(texto('[data-campo="conciliacion"]')).toContain('hace 5 min');
    expect(texto('[data-campo="conciliacion"]')).toContain('2 pagos revisados');

    await entrar(crearFakePanel({ pagos: pagos({ ultima_conciliacion: { corrida_en: '2026-11-10T11:00:00Z', revisados: 0, resumen: {} } }) }));
    await irA('pagos');
    expect($('[data-campo="conciliacion"]').dataset.estado).toBe('detenida');
    expect(texto('[data-campo="conciliacion"]')).toContain('lleva rato sin correr');
  });
});

describe('Panel: reportes, reglas, banderas, QR de entrada y auditoría (H9b)', () => {
  it('reportes: pide el rango y muestra el resumen', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('reportes');
    await click('[data-accion="ver-reportes"]');
    expect(api._s.llamadas.some((l) => l[0] === 'reporteVentas')).toBe(true);
    expect(texto('[data-campo="resumen"]')).toContain('3 ventas');
  });

  it('reglas: muestra la vigente con su historial y un cambio crea una versión nueva con PIN', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('reglas');
    const fila = $('[data-regla="puntos.cop_por_punto"]');
    expect(fila.querySelector('[data-campo="valor"]').textContent).toBe('1000');
    expect(fila.querySelector('[data-campo="historial"]').textContent).toContain('1500');
    await click('[data-regla="puntos.cop_por_punto"] [data-accion="cambiar-regla"]');
    await escribir('[data-campo="valor-regla"]', '1200');
    await click('[data-accion="guardar-regla"]');
    await responder('4321');
    await esperar(8);
    expect(api._s.llamadas).toContainEqual(['cambiarRegla', ['puntos.cop_por_punto', 1200, '4321']]);
    expect(texto('[data-regla="puntos.cop_por_punto"] [data-campo="valor"]')).toBe('1200');
    expect(texto('.avisos')).toContain('versión 3');
  });

  it('reglas: un JSON inválido o sin cambios no llega al servidor, y un PIN malo no cambia nada', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('reglas');
    await click('[data-regla="pin.max_intentos"] [data-accion="cambiar-regla"]');
    await escribir('[data-campo="valor-regla"]', 'cinco');
    await click('[data-accion="guardar-regla"]');
    expect(texto('[data-campo="error-regla"]')).toContain('JSON válido');
    await escribir('[data-campo="valor-regla"]', '5');
    await click('[data-accion="guardar-regla"]');
    expect(texto('[data-campo="error-regla"]')).toContain('No cambiaste nada');
    await escribir('[data-campo="valor-regla"]', '7');
    await click('[data-accion="guardar-regla"]');
    await responder('0000');
    await esperar(6);
    expect(texto('[data-campo="error-regla"]')).toContain('PIN incorrecto');
    expect(api._s.reglas.filter((r) => r.clave === 'pin.max_intentos').length).toBe(1);
  });

  it('banderas: apagar una sensible pide confirmar y PIN; encender una apagada solo el PIN', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('banderas');
    expect(texto('[data-bandera="pago_en_linea_bold"] [data-campo="estado"]')).toBe('Encendida');
    await click('[data-bandera="pago_en_linea_bold"] [data-accion="cambiar-bandera"]');
    expect(document.body.textContent).toContain('impide que los clientes paguen en línea');
    await click('[data-accion="si-confirmar"]');
    await responder('4321');
    await esperar(6);
    expect(texto('[data-bandera="pago_en_linea_bold"] [data-campo="estado"]')).toBe('Apagada');
    await click('[data-bandera="referidos"] [data-accion="cambiar-bandera"]');
    await responder('4321');
    await esperar(6);
    expect(texto('[data-bandera="referidos"] [data-campo="estado"]')).toBe('Encendida');
    expect(api._s.llamadas.filter((l) => l[0] === 'cambiarBandera').length).toBe(2);
  });

  it('QR de entrada: se muestra y rotarlo pide confirmación y PIN', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('entrada');
    expect($('[data-campo="qr-entrada"]').dataset.url).toBe('https://naidi.test/cuenta/#entrada=' + 'a'.repeat(48));
    expect($('[data-campo="qr-entrada"] svg')).not.toBeNull();
    await click('[data-accion="rotar-entrada"]');
    await click('[data-accion="si-confirmar"]');
    await responder('0000');
    await esperar(4);
    expect(api._s.punto.token).toBe('a'.repeat(48));                      // PIN malo: no cambia
    await click('[data-accion="rotar-entrada"]');
    await click('[data-accion="si-confirmar"]');
    await responder('4321');
    await esperar(6);
    expect($('[data-campo="qr-entrada"]').dataset.url).toContain('b'.repeat(48));
    expect(texto('[data-campo="rotado"]')).toContain('Último cambio');
  });

  it('auditoría: lista los movimientos con nombres claros y se puede filtrar', async () => {
    const api = crearFakePanel();
    await entrar(api);
    await irA('auditoria');
    expect(api._s.llamadas).toContainEqual(['auditoria', 200]);
    expect($$('[data-auditoria]').length).toBe(2);
    expect(texto('[data-tabla="auditoria"]')).toContain('Cambió una regla');
    expect(texto('[data-tabla="auditoria"]')).toContain('Anuló una venta');
    await escribir('[data-campo="buscar-auditoria"]', 'anular');
    expect($$('[data-auditoria]').length).toBe(1);
    await escribir('[data-campo="buscar-auditoria"]', 'zzz');
    expect($('[data-campo="sin-auditoria"]')).not.toBeNull();
  });
});

describe('Panel: alertas de pagos Bold de compras del POS (QR del iPad)', () => {
  it('hablan de "la compra #n" y no de un pedido web', () => {
    const t = (detalle) => textoAlerta({ tipo: 'pago_bold', cliente: null, detalle });
    expect(t({ motivo: 'monto_distinto', venta: 57, esperado: 21500, recibido: 22000 })).toMatch(/la compra #57.*21\.500/);
    expect(t({ motivo: 'venta_no_cobrable', venta: 57, estado_venta: 'cancelada', monto: 21500, total_venta: 21500 })).toMatch(/compra #57.*cancelada/);
    expect(t({ motivo: 'anulado_venta_pagada', venta: 57 })).toMatch(/compra #57.*PIN/);
    expect(t({ motivo: 'pago_duplicado', pedido: 41, monto: 4000 })).toContain('el pedido #41');   // los pedidos web siguen igual
    expect(t({ motivo: 'venta_no_cobrable', venta: 57, estado_venta: 'cancelada', monto: 1 })).not.toMatch(/undefined|null/);
  });
});
