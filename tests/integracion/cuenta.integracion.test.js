// Integración REAL de /cuenta: la capa api.js de la cuenta del cliente contra el Supabase local, con sesiones de verdad.
// El inicio de sesión es el real: correo con código de 6 dígitos (se lee el correo en Mailpit, el buzón de pruebas local).
// Requiere `supabase start`. Correr con:  pnpm test:integracion
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { crearApi } from '../../src/pos/api.js';
import { crearCola, almacenMemoria } from '../../src/pos/cola.js';
import { cobrarSinCliente, nuevaClave } from '../../src/pos/vender.js';
import { crearApiCuenta } from '../../src/cuenta/api.js';

function leerEntorno() {
  const salida = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const env = {};
  for (const l of salida.split(/\r?\n/)) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const sufijo = Math.random().toString(36).slice(2, 8);
const correoCliente = `laura.${sufijo}@integracion.test`;
let env, admin, cuenta, clienteSb, api, clienteId, ventaId;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sesion = () => createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// Lee el código de 6 dígitos del correo que Supabase mandó al buzón local.
async function codigoDelCorreo(correo) {
  const base = env.MAILPIT_URL || 'http://127.0.0.1:54324';
  for (let i = 0; i < 30; i++) {
    const lista = await (await fetch(base + '/api/v1/messages')).json();
    const msg = (lista.messages || []).find((m) => (m.To || []).some((t) => t.Address === correo));
    if (msg) {
      const det = await (await fetch(base + '/api/v1/message/' + msg.ID)).json();
      const m = /\b(\d{6})\b/.exec((det.Text || '') + ' ' + (det.HTML || '').replace(/<[^>]+>/g, ' '));
      if (m) return m[1];
    }
    await dormir(500);
  }
  throw new Error('No llegó el correo con el código a ' + correo);
}

beforeAll(async () => {
  env = leerEntorno();
  admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  // Personal (cajero) con contraseña: solo para armar las ventas del cliente.
  const pw = 'Prueba-' + Math.random().toString(36).slice(2) + '-Aa1';
  const u = await admin.auth.admin.createUser({ email: `cajero.cuenta.${sufijo}@integracion.test`, password: pw, email_confirm: true });
  const s = await admin.from('staff').insert({ user_id: u.data.user.id, rol: 'cajero', nombre: 'Cajero Cuenta' });
  if (s.error) throw new Error(s.error.message);
  const cajeroSb = sesion();
  const r = await cajeroSb.auth.signInWithPassword({ email: `cajero.cuenta.${sufijo}@integracion.test`, password: pw });
  if (r.error) throw new Error(r.error.message);
  api = crearApi(cajeroSb);
  clienteSb = sesion();
  cuenta = crearApiCuenta(clienteSb, { origen: () => 'http://localhost' });
}, 60000);

describe('cuenta del cliente contra la base real', () => {
  it('un código equivocado da un mensaje claro en español; el real entra y crea el perfil', async () => {
    await cuenta.enviarCodigo(correoCliente);
    await expect(cuenta.verificarCodigo(correoCliente, '000000')).rejects.toMatchObject({ message: expect.stringContaining('no es válido') });
    const codigo = await codigoDelCorreo(correoCliente);
    await cuenta.verificarCodigo(correoCliente, codigo);
    const ses = await cuenta.sesion();
    expect(ses.email).toBe(correoCliente);
    clienteId = ses.id;
    const p = await cuenta.perfil();
    expect(p).toMatchObject({ nombre_pila: expect.any(String), acepta_datos: false, acepta_mensajes: false, compras_pagadas: 0 });
    expect(p.privacidad_version).toBeTruthy();
  }, 60000);

  it('sin consentimiento no hay check-in; con él sí, con el QR de entrada vigente', async () => {
    const pv = await admin.from('punto_venta').select('token').eq('id', 1).single();
    await expect(cuenta.hacerCheckin(pv.data.token)).rejects.toMatchObject({ message: expect.stringContaining('consentimiento_requerido') });
    const p = await cuenta.perfil();
    await cuenta.consentir('datos', p.privacidad_version, true);
    expect((await cuenta.perfil()).acepta_datos).toBe(true);
    await expect(cuenta.hacerCheckin('f'.repeat(48))).rejects.toMatchObject({ message: expect.stringContaining('no es válido') });
    const r = await cuenta.hacerCheckin(pv.data.token);
    expect(r).toMatchObject({ cliente_nuevo: true, ya_estaba: false });
    expect((await cuenta.miCheckin()).checkin_id).toBe(r.checkin_id);
    expect((await cuenta.hacerCheckin(pv.data.token)).ya_estaba).toBe(true);        // un solo check-in activo por cuenta
    expect((await cuenta.vouchers()).some((w) => w.tipo === 'bienvenida')).toBe(true);
  });

  it('el vendedor confirma la venta: el cliente la ve "por pagar" y puede reportar que no es lo que pidió', async () => {
    const r = await api.crearVenta({ idem: nuevaClave(), cliente: clienteId });
    ventaId = r.id || r.venta_id || r;
    await api.agregarLinea(ventaId, { producto: 'amazonas', tamano: 'pequeno', toppings: ['miel'] });
    await api.agregarLinea(ventaId, { producto: 'espresso', cantidad: 2 });
    expect(await cuenta.compraEnCurso()).toBeNull();                                  // todavía se está alistando
    await api.confirmarVenta(ventaId);

    const c = await cuenta.compraEnCurso();
    const fila = await admin.from('ventas').select('total_cop').eq('id', ventaId).single();
    expect(c).toMatchObject({ venta_id: ventaId, estado: 'confirmada', total_cop: fila.data.total_cop, puntos_ganados: 0 });
    expect(c.lineas).toHaveLength(2);

    expect(await cuenta.reportarPedido(ventaId, '  Pedí sin miel ')).toMatchObject({ ok: true, ya_reportado: false });
    expect((await cuenta.reportarPedido(ventaId)).ya_reportado).toBe(true);
    const abiertos = await api.reportesAbiertos();
    const mio = abiertos.find((a) => a.venta_id === ventaId);
    expect(mio).toMatchObject({ nota: 'Pedí sin miel' });
    expect(mio.cliente).not.toContain(' ');                                           // solo nombre de pila
    await api.resolverReporte(mio.id);
    expect((await api.reportesAbiertos()).some((a) => a.venta_id === ventaId)).toBe(false);
  });

  it('otro cliente no puede reportar ni ver la compra; al pagar, el cliente ve "Pagado", sus puntos y su historial', async () => {
    const otro = sesion();
    const pw = 'Prueba-' + Math.random().toString(36).slice(2) + '-Aa1';
    await admin.auth.admin.createUser({ email: `beto.${sufijo}@integracion.test`, password: pw, email_confirm: true });
    await otro.auth.signInWithPassword({ email: `beto.${sufijo}@integracion.test`, password: pw });
    const apiOtro = crearApiCuenta(otro);
    await expect(apiOtro.reportarPedido(ventaId)).rejects.toMatchObject({ message: expect.stringContaining('No encontramos') });
    expect(await apiOtro.compraEnCurso()).toBeNull();

    await api.pagarVenta(ventaId, 'efectivo', 50000);
    const c = await cuenta.compraEnCurso();
    expect(c.estado).toBe('pagada');
    expect(c.puntos_ganados).toBeGreaterThan(0);
    expect(await cuenta.saldo()).toBe(c.puntos_ganados);
    const compras = await cuenta.compras();
    expect(compras[0]).toMatchObject({ venta_id: ventaId, medio_pago: 'efectivo', puntos: c.puntos_ganados });
    expect((await cuenta.movimientos())[0]).toMatchObject({ tipo: 'suma', puntos: c.puntos_ganados });
    await expect(cuenta.reportarPedido(ventaId)).rejects.toMatchObject({ message: expect.stringContaining('ya no se puede reportar') });
    expect((await cuenta.perfil()).compras_pagadas).toBeGreaterThanOrEqual(1);
  });

  it('el QR posterior a la venta (venta sin cliente) suma puntos una sola vez', async () => {
    const cola = crearCola({ almacen: almacenMemoria() });
    const r = await cobrarSinCliente({ api, cola, enLinea: () => true,
      venta: { idem: nuevaClave(), lineas: [{ producto: 'litro-acai', cantidad: 1 }], medio: 'transferencia', total_estimado: 53000 } });
    const antes = await cuenta.saldo();
    const rec = await cuenta.reclamarQr(r.resultado.qr_token);
    expect(rec.puntos_acreditados).toBe(53);
    expect(await cuenta.saldo()).toBe(antes + 53);
    await expect(cuenta.reclamarQr(r.resultado.qr_token)).rejects.toMatchObject({ message: expect.stringContaining('ya se usó') });
  });

  it('canjear el premio: sin puntos suficientes falla; con ellos descuenta y deja el voucher con su vigencia', async () => {
    const reglas = await cuenta.reglas();
    expect(reglas.umbrales).toEqual({ pequeno: 120, mediano: 130, grande: 140 });
    let saldo = await cuenta.saldo();
    if (saldo >= 120) throw new Error('La prueba espera un saldo menor a 120; hay datos de otra corrida');
    await expect(cuenta.canjear('pequeno')).rejects.toMatchObject({ message: expect.stringContaining('Te faltan') });
    await expect(cuenta.canjear('mini')).rejects.toMatchObject({ message: expect.stringContaining('no entra al premio') });
    const bono = await admin.from('puntos_libro').insert({ cliente_id: clienteId, tipo: 'bono', puntos: 100, nota: 'Prueba de integración' });
    expect(bono.error).toBeNull();
    saldo = await cuenta.saldo();
    const r = await cuenta.canjear('pequeno');
    expect(r.puntos_descontados).toBe(120);
    expect(await cuenta.saldo()).toBe(saldo - 120);
    const premio = (await cuenta.vouchers()).find((w) => w.tipo === 'premio');
    expect(premio).toMatchObject({ descuento_pct: 50, tamanos: ['pequeno'] });
    expect(new Date(premio.vence_en).getTime() - Date.now()).toBeGreaterThan(40 * 24 * 3600 * 1000);
  });

  it('celular y cumpleaños se guardan y se rechazan los datos mal escritos', async () => {
    await expect(cuenta.actualizarPerfil('abc', null)).rejects.toMatchObject({ message: expect.stringContaining('celular') });
    await cuenta.actualizarPerfil('300 123 4567', '1990-05-17');
    expect(await cuenta.perfil()).toMatchObject({ celular: '300 123 4567', cumpleanos: '1990-05-17' });
    await cuenta.consentir('mensajes', (await cuenta.perfil()).privacidad_version, true);
    expect((await cuenta.perfil()).acepta_mensajes).toBe(true);
  });

  it('el cliente no puede leer directamente ventas, puntos ni alertas', async () => {
    for (const t of ['ventas', 'puntos_libro', 'alertas', 'vouchers', 'qr_posventa', 'punto_venta']) {
      const r = await clienteSb.from(t).select('*').limit(1);
      expect(r.error !== null || (r.data || []).length === 0, 'el cliente leyó ' + t).toBe(true);
    }
    await expect(api.reportesAbiertos()).resolves.toBeDefined();
    const r = await clienteSb.rpc('reportes_abiertos');
    expect(r.error).not.toBeNull();
  });
});
