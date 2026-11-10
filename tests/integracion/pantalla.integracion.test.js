// Integración REAL de la pantalla del iPad: el cliente de /pantalla (src/pantalla/api.js) contra el Supabase local,
// por la API REST de verdad y sin sesión (solo la llave anon pública + la llave del dispositivo).
// Requiere `supabase start`. Correr con:  pnpm test:integracion
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { crearApi } from '../../src/pos/api.js';
import { crearApiPantalla } from '../../src/pantalla/api.js';
import { nuevaClave } from '../../src/pos/vender.js';

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
const llave = 'nd_' + randomBytes(32).toString('hex');
let env, admin, api, pantalla, dispositivoId;

beforeAll(async () => {
  env = leerEntorno();
  admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const clave = 'Prueba-' + Math.random().toString(36).slice(2) + '-Aa1';
  const u = await admin.auth.admin.createUser({ email: `cajero.pant.${sufijo}@integracion.test`, password: clave, email_confirm: true });
  const r = await admin.from('staff').insert({ user_id: u.data.user.id, rol: 'cajero', nombre: 'Cajero Pantalla' });
  if (r.error) throw new Error(r.error.message);
  const c = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: `cajero.pant.${sufijo}@integracion.test`, password: clave });
  if (error) throw new Error(error.message);
  api = crearApi(c);
  // El dueño emite la llave con PIN y segundo factor (eso lo prueban las pruebas pgTAP). Aquí se inserta el hash tal cual lo guardaría la función.
  const d = await admin.from('dispositivos').insert({ nombre: 'iPad de integración ' + sufijo, llave_hash: createHash('sha256').update(llave).digest('hex') }).select('id').single();
  if (d.error) throw new Error(d.error.message);
  dispositivoId = d.data.id;
  pantalla = crearApiPantalla({ url: env.API_URL, anon: env.ANON_KEY, fetch: globalThis.fetch.bind(globalThis) });
}, 60000);

describe('pantalla del iPad contra la base real (sin sesión)', () => {
  it('el hash que calcula el servidor coincide con SHA-256 de la llave (la llave nunca se guarda)', async () => {
    const r = await pantalla.estado(llave);
    expect(r.ok).toBe(true);
    const fila = await admin.from('dispositivos').select('llave_hash,ultimo_uso').eq('id', dispositivoId).single();
    expect(fila.data.llave_hash).not.toContain(llave);
    expect(fila.data.ultimo_uso).not.toBeNull();
  });

  it('con la llave: recibe el QR de entrada vigente, las formas de pago y el destino de transferencia', async () => {
    const r = await pantalla.estado(llave);
    const pv = await admin.from('punto_venta').select('token').eq('id', 1).single();
    expect(r.entrada_token).toBe(pv.data.token);
    expect(r.formas_pago).toEqual(['efectivo', 'datafono_bold', 'transferencia']);
    expect(r.transferencia).toMatchObject({ tipo: 'bre-b' });
  });

  it('una llave inventada o vacía recibe llave_invalida, no un error', async () => {
    expect((await pantalla.estado('nd_' + 'f'.repeat(64))).error).toBe('llave_invalida');
    expect((await pantalla.estado('')).error).toBe('llave_invalida');
  });

  it('sin sesión no se pueden leer las tablas ni llamar funciones del personal', async () => {
    const anon = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false } });
    const ventas = await anon.from('ventas').select('id').limit(1);
    expect(ventas.error).not.toBeNull();
    const disp = await anon.from('dispositivos').select('id').limit(1);
    expect(disp.error).not.toBeNull();
    const lista = await anon.rpc('lista_espera');
    expect(lista.error).not.toBeNull();
    const emitir = await anon.rpc('emitir_llave_dispositivo', { p_nombre: 'x', p_pin: '0000' });
    expect(emitir.error).not.toBeNull();
  });

  it('al confirmar la venta la pantalla ve sus líneas y el total; al pagarla, "pagada"; luego se apaga', async () => {
    const v = await api.crearVenta({ idem: nuevaClave() });
    const id = v.id || v.venta_id || v;
    await api.agregarLinea(id, { producto: 'amazonas', tamano: 'pequeno', toppings: ['miel'] });
    await api.agregarLinea(id, { producto: 'espresso', cantidad: 2 });
    const numero = (await admin.from('ventas').select('numero').eq('id', id).single()).data.numero;
    const alistando = (await pantalla.estado(llave)).venta;               // todavía se está alistando: no se muestra
    expect(alistando === null || alistando.numero !== numero).toBe(true);
    await api.confirmarVenta(id);

    const confirmada = await pantalla.estado(llave);
    const fila = await admin.from('ventas').select('total_cop,numero').eq('id', id).single();
    expect(confirmada.venta.estado).toBe('confirmada');
    expect(confirmada.venta.total_cop).toBe(fila.data.total_cop);
    expect(confirmada.venta.numero).toBe(fila.data.numero);
    expect(confirmada.venta.lineas.map((l) => l.nombre)).toEqual(expect.arrayContaining(['Amazonas', 'Café espresso']));
    expect(confirmada.venta.lineas.reduce((s, l) => s + l.total_cop, 0)).toBe(fila.data.total_cop);
    expect(JSON.stringify(confirmada)).not.toMatch(/cliente_id|puntos|@integracion\.test/);

    await api.pagarVenta(id, 'efectivo', 50000);
    expect((await pantalla.estado(llave)).venta.estado).toBe('pagada');
  });

  it('al revocar la llave, la pantalla deja de recibir datos en la siguiente consulta', async () => {
    const r = await admin.from('dispositivos').update({ revocado_en: new Date().toISOString() }).eq('id', dispositivoId);
    expect(r.error).toBeNull();
    expect((await pantalla.estado(llave)).error).toBe('llave_invalida');
  });
});
