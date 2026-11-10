// Integración REAL del pago en línea con Bold: los manejadores de las Edge Functions (checkout, webhook, conciliación)
// contra el Supabase local, con sesiones y eventos firmados como los mandaría Bold. Es el "simulador local de webhooks":
// firma válida, inválida, evento repetido, fuera de orden, monto distinto y bandera apagada.
// La llamada a Bold se simula (no hay llaves de prueba); la prueba de punta a punta con Bold queda para cuando haya llaves.
// Requiere `supabase start`. Deja filas en la base local (corre `supabase db reset` antes de pgTAP).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { crearApi } from '../../src/pos/api.js';
import { crearApiTienda } from '../../src/tienda/api.js';
import { firmaWebhook, firmaIntegridad } from '../../supabase/functions/_shared/bold.ts';
import { manejarCheckout, manejarWebhook, manejarConciliacion, manejarVerificacion } from '../../supabase/functions/_shared/manejadores.ts';

function leerEntorno() {
  const salida = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const env = {};
  for (const l of salida.split(/\r?\n/)) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const SECRETA = 'secreta-de-prueba-local';
const sufijo = Math.random().toString(36).slice(2, 8);
const correo = `sofia.${sufijo}@integracion.test`;
let env, admin, pos, clienteSb, tienda, secretos, deps, jwt;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sesion = () => createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const enMin = (min) => new Date(Date.now() + min * 60000).toISOString();
const opcionesSb = { auth: { persistSession: false, autoRefreshToken: false } };

async function codigoDelCorreo(c) {
  const base = env.MAILPIT_URL || 'http://127.0.0.1:54324';
  for (let i = 0; i < 30; i++) {
    const lista = await (await fetch(base + '/api/v1/messages')).json();
    const msg = (lista.messages || []).find((m) => (m.To || []).some((t) => t.Address === c));
    if (msg) {
      const det = await (await fetch(base + '/api/v1/message/' + msg.ID)).json();
      const m = /\b(\d{6})\b/.exec((det.Text || '') + ' ' + (det.HTML || '').replace(/<[^>]+>/g, ' '));
      if (m) return m[1];
    }
    await dormir(500);
  }
  throw new Error('No llegó el correo con el código a ' + c);
}

async function nuevoPedidoEnLinea() {
  const p = await tienda.crearPedido({ idem: crypto.randomUUID(), lineas: [{ producto: 'latte', cantidad: 1 }], ventanaInicio: enMin(60), ventanaFin: enMin(90), pago: 'en_linea' });
  const r = await manejarCheckout(new Request('https://x.test/bold-checkout', { method: 'POST', body: JSON.stringify({ pedido_id: p.id }), headers: { Authorization: 'Bearer ' + jwt } }), deps);
  return { pedido: p, checkout: await r.json(), estado: r.status };
}

function evento(orderId, tipo, extra) {
  const id = 'evt-' + Math.random().toString(36).slice(2);
  return { id, type: tipo, subject: 'bp-' + id, data: { payment_id: 'bp-' + id, payment_method: 'CARD', amount: { total: 4000, currency: 'COP' }, metadata: { reference: orderId } }, ...(extra || {}) };
}
async function enviar(ev, firma) {
  const cuerpo = JSON.stringify(ev);
  const f = firma === undefined ? await firmaWebhook(cuerpo, SECRETA) : firma;
  return manejarWebhook(new Request('https://x.test/bold-webhook', { method: 'POST', body: cuerpo, headers: f ? { 'x-bold-signature': f } : {} }), deps);
}
const miPedido = async (id) => (await tienda.misPedidos()).find((x) => x.id === id);

beforeAll(async () => {
  env = leerEntorno();
  admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, opcionesSb);
  secretos = { identidad: 'identidad-de-prueba-local', secreta: SECRETA, sitio: 'http://localhost:5173', tokenConciliacion: 'tok-local' };

  // Habilitaciones del dueño: pedidos web, pago en línea y la forma de pago "en línea" en la regla.
  const vig = await admin.from('reglas_negocio').select('*').eq('clave', 'pedido_web.pagos').is('vigente_hasta', null).single();
  await admin.from('reglas_negocio').update({ vigente_hasta: new Date().toISOString() }).eq('id', vig.data.id);
  await admin.from('reglas_negocio').insert({ clave: 'pedido_web.pagos', version: vig.data.version + 1, valor: { al_recoger: true, en_linea: true }, descripcion: vig.data.descripcion, publica: true, vigente_desde: new Date().toISOString() });
  for (const clave of ['pedidos_web', 'pago_en_linea_bold']) {
    const b = await admin.from('banderas').update({ activa: true }).eq('clave', clave);
    if (b.error) throw new Error(b.error.message);
  }

  const pw = 'Prueba-' + Math.random().toString(36).slice(2) + '-Aa1';
  const u = await admin.auth.admin.createUser({ email: `cajero.bold.${sufijo}@integracion.test`, password: pw, email_confirm: true });
  const s = await admin.from('staff').insert({ user_id: u.data.user.id, rol: 'cajero', nombre: 'Cajero Bold' });
  if (s.error) throw new Error(s.error.message);
  const cajeroSb = sesion();
  const r = await cajeroSb.auth.signInWithPassword({ email: `cajero.bold.${sufijo}@integracion.test`, password: pw });
  if (r.error) throw new Error(r.error.message);
  pos = crearApi(cajeroSb);
  await pos.fijarPedidosWeb(true);

  clienteSb = sesion();
  tienda = crearApiTienda(clienteSb, { origen: () => 'http://localhost' });
  await tienda.enviarCodigo(correo);
  await tienda.verificarCodigo(correo, await codigoDelCorreo(correo));
  jwt = (await clienteSb.auth.getSession()).data.session.access_token;
  await tienda.consentir('datos', (await tienda.perfil()).privacidad_version, true);

  deps = {
    secretos,
    clienteServicio: admin,
    clienteUsuario: (aut) => createClient(env.API_URL, env.ANON_KEY, { ...opcionesSb, global: { headers: { Authorization: aut } } }),
    fetch: async () => new Response('{}', { status: 404 }),
  };
}, 90000);

afterAll(async () => {
  await pos.fijarPedidosWeb(false);
  await admin.from('banderas').update({ activa: false }).in('clave', ['pedidos_web', 'pago_en_linea_bold']);
});

describe('pago en línea con Bold contra la base real', () => {
  let a, b;

  it('el checkout entrega datos del botón firmados con el monto del pedido guardado', async () => {
    a = await nuevoPedidoEnLinea();
    expect(a.estado).toBe(200);
    expect(a.checkout).toMatchObject({ apiKey: 'identidad-de-prueba-local', amount: 4000, currency: 'COP', redirectionUrl: null });   // SITE_URL http://localhost: Bold exige https, así que no se envía
    expect(a.checkout.orderId).toMatch(/^NW\d+-[0-9a-f]{10}$/);
    expect(a.checkout.integritySignature).toBe(await firmaIntegridad(a.checkout.orderId, 4000, 'COP', SECRETA));
    expect((await miPedido(a.pedido.id)).pago_en_linea_estado).toBe('pendiente');
    // Sin sesión no hay checkout
    const sin = await manejarCheckout(new Request('https://x.test', { method: 'POST', body: JSON.stringify({ pedido_id: a.pedido.id }) }), deps);
    expect(sin.status).toBe(401);
  });

  it('firma inválida: 401 y no cambia nada', async () => {
    const r = await enviar(evento(a.checkout.orderId, 'SALE_APPROVED'), 'a'.repeat(64));
    expect(r.status).toBe(401);
    expect((await miPedido(a.pedido.id)).pago_en_linea_estado).toBe('pendiente');
  });

  it('monto distinto: no se acredita y queda una alerta para el dueño', async () => {
    const r = await enviar(evento(a.checkout.orderId, 'SALE_APPROVED', { data: { payment_id: 'bp-x', amount: { total: 1000, currency: 'COP' }, metadata: { reference: a.checkout.orderId } } }));
    expect((await r.json()).resultado).toBe('monto_distinto');
    expect((await miPedido(a.pedido.id)).pago_en_linea_estado).toBe('pendiente');
    const alertas = await admin.from('alertas').select('detalle').eq('tipo', 'pago_bold').is('resuelta_en', null);
    expect(alertas.data.some((x) => x.detalle.order_id === a.checkout.orderId && x.detalle.motivo === 'monto_distinto')).toBe(true);
  });

  it('el personal no prepara un pedido en línea sin pago', async () => {
    await expect(pos.cambiarEstadoPedidoWeb(a.pedido.id, 'preparando')).rejects.toMatchObject({ message: expect.stringContaining('todavía no aparece pagado') });
  });

  it('aprobación válida: el pedido queda pagado; el mismo evento repetido no hace nada', async () => {
    const ev = evento(a.checkout.orderId, 'SALE_APPROVED');
    const r1 = await enviar(ev);
    expect(r1.status).toBe(200);
    expect((await r1.json()).resultado).toBe('aprobado');
    expect((await miPedido(a.pedido.id)).pago_en_linea_estado).toBe('pagado');
    const r2 = await enviar(ev);
    expect(r2.status).toBe(200);
    expect((await r2.json()).resultado).toBe('duplicado');
    const pagos = await admin.from('pagos_bold').select('estado').eq('order_id', a.checkout.orderId);
    expect(pagos.data).toEqual([{ estado: 'aprobado' }]);
  });

  it('un rechazo tardío no deshace la aprobación', async () => {
    const r = await enviar(evento(a.checkout.orderId, 'SALE_REJECTED'));
    expect((await r.json()).resultado).toBe('ignorado');
    expect((await miPedido(a.pedido.id)).pago_en_linea_estado).toBe('pagado');
  });

  it('fuera de orden: una anulación que llega antes de la aprobación se ignora y la aprobación se aplica después', async () => {
    b = await nuevoPedidoEnLinea();
    expect((await (await enviar(evento(b.checkout.orderId, 'VOID_APPROVED'))).json()).resultado).toBe('ignorado');
    expect((await miPedido(b.pedido.id)).pago_en_linea_estado).toBe('pendiente');
    expect((await (await enviar(evento(b.checkout.orderId, 'SALE_APPROVED'))).json()).resultado).toBe('aprobado');
    expect((await miPedido(b.pedido.id)).pago_en_linea_estado).toBe('pagado');
  });

  it('pagado: el POS lo prepara y lo entrega sin elegir medio; la venta queda como pago en línea y suma puntos', async () => {
    expect((await pos.cambiarEstadoPedidoWeb(a.pedido.id, 'preparando')).estado).toBe('preparando');
    const r = await pos.entregarPedidoWeb(a.pedido.id, a.pedido.codigo);
    expect(r).toMatchObject({ estado: 'entregado', medio_pago: 'bold_online', total_cop: 4000 });
    const venta = await admin.from('ventas').select('medio_pago, estado, canal').eq('id', r.venta_id).single();
    expect(venta.data).toEqual({ medio_pago: 'bold_online', estado: 'pagada', canal: 'web' });
  });

  it('conciliación: sin el token 401; con él, un pago aprobado en Bold cuyo webhook no llegó se aplica', async () => {
    const c = await nuevoPedidoEnLinea();
    await admin.from('pagos_bold').update({ creado_en: new Date(Date.now() - 20 * 60000).toISOString() }).eq('order_id', c.checkout.orderId);
    const consulta = (token) => new Request('https://x.test/bold-conciliar', { method: 'POST', headers: token ? { 'x-conciliacion-token': token } : {} });
    expect((await manejarConciliacion(consulta('malo'), deps)).status).toBe(401);
    const conBold = { ...deps, fetch: async (url) => url.endsWith(c.checkout.orderId)
      ? new Response(JSON.stringify({ payment_status: 'APPROVED', payment_id: 'bp-conc-' + sufijo, amount: { total: 4000 } }), { status: 200 })
      : new Response('{}', { status: 404 }) };
    const r = await manejarConciliacion(consulta('tok-local'), conBold);
    expect((await r.json()).resumen[c.checkout.orderId]).toBe('aprobado');
    expect((await miPedido(c.pedido.id)).pago_en_linea_estado).toBe('pagado');
  });

  it('el cliente verifica su pago sin webhook: se le pregunta a Bold y la base lo acredita; no puede verificar pedidos ajenos', async () => {
    // Una segunda clienta, con su propio tope de pedidos abiertos
    const otro = sesion();
    const apiOtro = crearApiTienda(otro, { origen: () => 'http://localhost' });
    const correoOtro = `otro.${sufijo}@integracion.test`;
    await apiOtro.enviarCodigo(correoOtro);
    await apiOtro.verificarCodigo(correoOtro, await codigoDelCorreo(correoOtro));
    await apiOtro.consentir('datos', (await apiOtro.perfil()).privacidad_version, true);
    const jwtOtro = (await otro.auth.getSession()).data.session.access_token;
    const crear = async (api, token) => {
      const p = await api.crearPedido({ idem: crypto.randomUUID(), lineas: [{ producto: 'latte', cantidad: 1 }], ventanaInicio: enMin(60), ventanaFin: enMin(90), pago: 'en_linea' });
      const r = await manejarCheckout(new Request('https://x.test/bold-checkout', { method: 'POST', body: JSON.stringify({ pedido_id: p.id }), headers: { Authorization: 'Bearer ' + token } }), deps);
      return { pedido: p, orderId: (await r.json()).orderId };
    };
    const verificar = (pedidoId, token, fetchBold) => manejarVerificacion(
      new Request('https://x.test/bold-verificar', { method: 'POST', body: JSON.stringify({ pedido_id: pedidoId }), headers: { Authorization: 'Bearer ' + token } }), { ...deps, fetch: fetchBold });
    const pendiente = async () => new Response(JSON.stringify({ payment_status: 'PROCESSING' }), { status: 200 });
    const aprobado = async () => new Response(JSON.stringify({ payment_status: 'APPROVED', payment_id: 'bp-ver-' + sufijo + '-' + Math.random().toString(36).slice(2), amount: { total: 4000 } }), { status: 200 });
    const estadoDe = async (api, id) => (await api.misPedidos()).find((x) => x.id === id).pago_en_linea_estado;

    const propio = await crear(apiOtro, jwtOtro);
    expect((await (await verificar(propio.pedido.id, jwtOtro, pendiente)).json()).resumen[propio.orderId]).toBe('sin_cambio');
    expect(await estadoDe(apiOtro, propio.pedido.id)).toBe('pendiente');
    expect((await (await verificar(propio.pedido.id, jwtOtro, aprobado)).json()).resumen[propio.orderId]).toBe('aprobado');
    expect(await estadoDe(apiOtro, propio.pedido.id)).toBe('pagado');

    // Otra cuenta no puede disparar la verificación del pedido de alguien más
    const ajeno = await crear(apiOtro, jwtOtro);
    expect((await (await verificar(ajeno.pedido.id, jwt, aprobado)).json()).revisados).toBe(0);
    expect(await estadoDe(apiOtro, ajeno.pedido.id)).toBe('pendiente');
  });

  it('con la bandera apagada el webhook y el checkout no responden', async () => {
    await admin.from('banderas').update({ activa: false }).eq('clave', 'pago_en_linea_bold');
    try {
      const r = await enviar(evento('NW1-nada', 'SALE_APPROVED'));
      expect(r.status).toBe(404);
      const ck = await manejarCheckout(new Request('https://x.test', { method: 'POST', body: JSON.stringify({ pedido_id: b.pedido.id }), headers: { Authorization: 'Bearer ' + jwt } }), deps);
      expect(ck.status).toBe(404);
    } finally {
      await admin.from('banderas').update({ activa: true }).eq('clave', 'pago_en_linea_bold');
    }
  });
});
