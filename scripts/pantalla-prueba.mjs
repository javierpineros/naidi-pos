// Ayuda para probar /pantalla en el iPad real contra el Supabase LOCAL (solo desarrollo; usa la service_role local
// que imprime `supabase status`, nunca una llave de producción).
//
//   node scripts/pantalla-prueba.mjs llave https://mi-pantalla.trycloudflare.com   emite una llave como el dueño (PIN + 2.º factor) e imprime el enlace de activación
//   node scripts/pantalla-prueba.mjs confirmar [n]                                 arma y confirma una venta de prueba con n líneas (por defecto 2); con 10 o más se prueba el desplazamiento
//   node scripts/pantalla-prueba.mjs pagar                                         paga esa venta (la pantalla muestra "Pagado")
//   node scripts/pantalla-prueba.mjs qr                                            cancela las ventas confirmadas sin pagar que queden abiertas (la pantalla vuelve al QR)
//   node scripts/pantalla-prueba.mjs revocar                                       revoca la última llave (la pantalla se apaga)
//
// El estado (cuentas de prueba, última venta y llave) se guarda en la carpeta temporal del sistema, fuera del repositorio.
import { execSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ARCHIVO = join(tmpdir(), 'naidi-pantalla-prueba.json');
const PIN = '2468'; // PIN de prueba del dueño de prueba, solo en la base local

function entorno() {
  const salida = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const env = {};
  for (const l of salida.split(/\r?\n/)) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
  if (!/127\.0\.0\.1|localhost/.test(env.API_URL || '')) throw new Error('Este script solo funciona contra el Supabase local.');
  return env;
}
const leer = () => (existsSync(ARCHIVO) ? JSON.parse(readFileSync(ARCHIVO, 'utf8')) : {});
const guardar = (o) => writeFileSync(ARCHIVO, JSON.stringify(Object.assign(leer(), o), null, 2));
const cliente = (env, llave) => createClient(env.API_URL, llave || env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const clave = () => 'Prueba-' + randomBytes(9).toString('hex') + '-Aa1';

// Código TOTP de 6 dígitos (RFC 6238) a partir del secreto en base32 que entrega Supabase al inscribir el factor.
function totp(secretoBase32) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretoBase32.replace(/=+$/, '').toUpperCase()) bits += alfabeto.indexOf(c).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac('sha1', bytes).update(contador).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

async function cuenta(env, admin, rol, correo, nombre) {
  const e = leer();
  if (e[rol]) return e[rol];
  const pw = clave();
  const u = await admin.auth.admin.createUser({ email: correo, password: pw, email_confirm: true });
  if (u.error) throw new Error(u.error.message);
  const s = await admin.from('staff').insert({ user_id: u.data.user.id, rol, nombre });
  if (s.error) throw new Error(s.error.message);
  guardar({ [rol]: { correo, pw, id: u.data.user.id } });
  return leer()[rol];
}

async function sesionDueno(env, admin) {
  const d = await cuenta(env, admin, 'dueno', `dueno.pantalla.${Date.now()}@prueba.test`, 'Dueño de prueba');
  const c = cliente(env);
  const r = await c.auth.signInWithPassword({ email: d.correo, password: d.pw });
  if (r.error) throw new Error(r.error.message);
  let e = leer();
  if (!e.totp) {
    const en = await c.auth.mfa.enroll({ factorType: 'totp' });
    if (en.error) throw new Error('Inscribiendo el segundo factor: ' + en.error.message);
    guardar({ totp: { factorId: en.data.id, secreto: en.data.totp.secret } });
    e = leer();
  }
  const ch = await c.auth.mfa.challenge({ factorId: e.totp.factorId });
  if (ch.error) throw new Error(ch.error.message);
  const v = await c.auth.mfa.verify({ factorId: e.totp.factorId, challengeId: ch.data.id, code: totp(e.totp.secreto) });
  if (v.error) throw new Error('Verificando el segundo factor: ' + v.error.message);
  return c; // sesión aal2
}

async function llave(env, admin, base) {
  if (!/^https:\/\/[^/]+$/.test(base || '')) throw new Error('Indica la URL https de la pantalla, por ejemplo https://algo.trycloudflare.com');
  const c = await sesionDueno(env, admin);
  const e = leer();
  if (!e.pinFijado) {
    const p = await c.rpc('fijar_pin', { p_nuevo: PIN });
    if (p.error || !p.data.ok) throw new Error('Fijando el PIN: ' + JSON.stringify(p.error || p.data));
    guardar({ pinFijado: true });
  }
  const r = await c.rpc('emitir_llave_dispositivo', { p_nombre: 'iPad de prueba ' + new Date().toISOString().slice(11, 19), p_pin: PIN });
  if (r.error) throw new Error(r.error.message);
  if (!r.data.ok) throw new Error('No se emitió la llave: ' + JSON.stringify(r.data));
  guardar({ dispositivo: r.data.id });
  console.log('Llave emitida (se muestra una sola vez). Abre esto en el iPad:\n');
  console.log(base + '/pantalla/#llave=' + r.data.llave + '\n');
}

async function cajero(env, admin) {
  const k = await cuenta(env, admin, 'cajero', `cajero.pantalla.${Date.now()}@prueba.test`, 'Cajero de prueba');
  const c = cliente(env);
  const r = await c.auth.signInWithPassword({ email: k.correo, password: k.pw });
  if (r.error) throw new Error(r.error.message);
  return c;
}

// Líneas de muestra variadas (nombres largos, toppings, cantidades) para probar cómo se acomoda un pedido grande.
const MUESTRA = [
  { p_producto: 'amazonas', p_tamano: 'mediano', p_toppings: ['miel'], p_cantidad: 1 },
  { p_producto: 'espresso', p_cantidad: 2 },
  { p_producto: 'carioca', p_tamano: 'grande', p_toppings: ['arandanos', 'kiwi'], p_cantidad: 1 },
  { p_producto: 'selva', p_tamano: 'pequeno', p_cantidad: 1 },
  { p_producto: 'bowl-personalizado', p_tamano: 'grande', p_base: 'acai-copoazu', p_toppings: ['banano', 'fresa', 'mango', 'arandanos', 'kiwi', 'granola-frutos-rojos', 'mantequilla-avellanas', 'miel'], p_cantidad: 1 },
  { p_producto: 'cacao', p_tamano: 'mediano', p_cantidad: 1 },
  { p_producto: 'latte', p_cantidad: 1 },
  { p_producto: 'fit', p_tamano: 'grande', p_toppings: ['chia', 'avena'], p_cantidad: 1 },
  { p_producto: 'litro-acai', p_cantidad: 1 },
  { p_producto: 'tucano', p_tamano: 'mini', p_cantidad: 3 },
  { p_producto: 'americano', p_cantidad: 1 },
  { p_producto: 'manaos', p_tamano: 'pequeno', p_cantidad: 1 },
];

async function confirmar(env, admin, arg) {
  const n = Math.max(1, Math.min(30, parseInt(arg, 10) || 2));
  const c = await cajero(env, admin);
  const v = await c.rpc('crear_venta', { p_idem: crypto.randomUUID() });
  if (v.error) throw new Error(v.error.message);
  const id = v.data.id || v.data.venta_id || v.data;
  for (let i = 0; i < n; i++) {
    const r = await c.rpc('agregar_linea', Object.assign({ p_venta: id }, MUESTRA[i % MUESTRA.length]));
    if (r.error) throw new Error('Línea ' + (i + 1) + ' (' + MUESTRA[i % MUESTRA.length].p_producto + '): ' + r.error.message);
  }
  const f = await c.rpc('confirmar_venta', { p_venta: id });
  if (f.error) throw new Error(f.error.message);
  guardar({ venta: id });
  console.log('Venta confirmada con ' + n + ' líneas. La pantalla debe mostrar el pedido, el total y las formas de pago.');
}

async function pagar(env, admin) {
  const e = leer();
  if (!e.venta) throw new Error('Primero corre "confirmar".');
  const c = await cajero(env, admin);
  // Se paga en efectivo con el total redondeado hacia arriba a los $10.000, sea cual sea el pedido.
  const t = await admin.from('ventas').select('total_cop,estado').eq('id', e.venta).single();
  if (t.error) throw new Error(t.error.message);
  if (t.data.estado !== 'confirmada') throw new Error('Esa venta ya está en estado "' + t.data.estado + '". Corre "confirmar" primero.');
  const recibido = Math.ceil(t.data.total_cop / 10000) * 10000;
  const r = await c.rpc('pagar_venta', { p_venta: e.venta, p_medio: 'efectivo', p_efectivo_recibido: recibido });
  if (r.error) throw new Error(r.error.message);
  console.log('Venta pagada. La pantalla debe decir "¡Pagado! Gracias" unos 20 segundos y volver al QR.');
}

// La pantalla muestra el QR solo si no hay ninguna venta confirmada sin pagar de la última hora.
async function qr(env, admin) {
  const abiertas = await admin.from('ventas').select('id,numero').eq('estado', 'confirmada').eq('canal', 'tienda');
  if (abiertas.error) throw new Error(abiertas.error.message);
  const c = await cajero(env, admin);
  for (const v of abiertas.data) {
    const r = await c.rpc('cancelar_venta', { p_venta: v.id, p_motivo: 'Prueba de la pantalla' });
    if (r.error) throw new Error('Venta ' + v.numero + ': ' + r.error.message);
  }
  console.log('Canceladas ' + abiertas.data.length + ' ventas abiertas. La pantalla vuelve al QR en unos segundos.');
}

async function revocar(env, admin) {
  const e = leer();
  if (!e.dispositivo) throw new Error('No hay una llave emitida por este script.');
  const c = await sesionDueno(env, admin);
  const r = await c.rpc('revocar_dispositivo', { p_id: e.dispositivo, p_pin: PIN });
  if (r.error || !r.data.ok) throw new Error('No se revocó: ' + JSON.stringify(r.error || r.data));
  console.log('Llave revocada. La pantalla debe mostrar "Esta pantalla está desactivada" en unos segundos.');
}

const [accion, arg] = process.argv.slice(2);
const acciones = { llave, confirmar, pagar, qr, revocar };
if (!acciones[accion]) {
  console.log('Uso: node scripts/pantalla-prueba.mjs llave <urlHttps> | confirmar [n] | pagar | qr | revocar');
  process.exit(1);
}
const env = entorno();
const admin = cliente(env, env.SERVICE_ROLE_KEY);
acciones[accion](env, admin, arg).catch((e) => { console.error('Error:', e.message); process.exit(1); });
