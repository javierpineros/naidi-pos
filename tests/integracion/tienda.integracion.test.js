// Integración REAL de la tienda web: la capa api.js de la tienda y la bandeja del POS contra el Supabase local, con sesiones de verdad.
// El inicio de sesión del cliente es el real (correo con código de 6 dígitos, leído en Mailpit). Requiere `supabase start`.
// Deja filas en la base local (corre `supabase db reset` antes de las pruebas pgTAP). Al terminar apaga la bandera pedidos_web.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { crearApi } from '../../src/pos/api.js';
import { crearApiTienda } from '../../src/tienda/api.js';

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
const correoCliente = `mateo.${sufijo}@integracion.test`;
let env, admin, pos, clienteSb, tienda, clienteId, pedido;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sesion = () => createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

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

// Dentro de `min` minutos (sin horario fijo: sirve a cualquier hora del día).
const enMin = (min) => new Date(Date.now() + min * 60000).toISOString();

beforeAll(async () => {
  env = leerEntorno();
  admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const b = await admin.from('banderas').update({ activa: true }).eq('clave', 'pedidos_web');
  if (b.error) throw new Error(b.error.message);

  const pw = 'Prueba-' + Math.random().toString(36).slice(2) + '-Aa1';
  const u = await admin.auth.admin.createUser({ email: `cajero.tienda.${sufijo}@integracion.test`, password: pw, email_confirm: true });
  const s = await admin.from('staff').insert({ user_id: u.data.user.id, rol: 'cajero', nombre: 'Cajero Tienda' });
  if (s.error) throw new Error(s.error.message);
  const cajeroSb = sesion();
  const r = await cajeroSb.auth.signInWithPassword({ email: `cajero.tienda.${sufijo}@integracion.test`, password: pw });
  if (r.error) throw new Error(r.error.message);
  pos = crearApi(cajeroSb);
  // El dueño habilita (bandera) y el personal enciende el interruptor al abrir la tienda.
  await pos.fijarPedidosWeb(true);
  clienteSb = sesion();
  tienda = crearApiTienda(clienteSb, { origen: () => 'http://localhost' });
}, 60000);

afterAll(async () => {
  await pos.fijarPedidosWeb(false);
  await admin.from('banderas').update({ activa: false }).eq('clave', 'pedidos_web');
});

describe('tienda web contra la base real', () => {
  it('sin sesión se ve el catálogo y la configuración pública, y no se puede pedir', async () => {
    const anon = crearApiTienda(sesion());
    const cat = await anon.catalogo();
    expect(cat.productos.length).toBeGreaterThan(8);
    const est = await anon.estado();
    expect(est).toMatchObject({ abierta: true, pagos: { al_recoger: true, en_linea: false }, max_abiertos: 2 });
    await expect(anon.miTienda()).rejects.toMatchObject({ codigo: '42501' });
  });

  it('el cliente entra con correo y código, acepta los datos y pide un bowl con cortesía', async () => {
    await tienda.enviarCodigo(correoCliente);
    await tienda.verificarCodigo(correoCliente, await codigoDelCorreo(correoCliente));
    clienteId = (await tienda.sesion()).id;
    const p = await tienda.perfil();
    await expect(tienda.crearPedido({ idem: crypto.randomUUID(), lineas: [{ producto: 'latte' }], ventanaInicio: enMin(60), ventanaFin: enMin(90), pago: 'al_recoger' }))
      .rejects.toMatchObject({ message: expect.stringContaining('aceptar el tratamiento de datos') });
    await tienda.consentir('datos', p.privacidad_version, true);
    expect(await tienda.miTienda()).toMatchObject({ acepta_datos: true, cortesia_disponible: true, abiertos: 0, max_abiertos: 2, restriccion: null });

    const idem = crypto.randomUUID();
    const args = { idem, lineas: [{ producto: 'amazonas', tamano: 'pequeno', toppings: ['miel'], cantidad: 1 }], ventanaInicio: enMin(60), ventanaFin: enMin(90), pago: 'al_recoger', cortesia: ['avena'], nota: 'sin canela' };
    pedido = await tienda.crearPedido(args);
    expect(pedido).toMatchObject({ estado: 'recibido', total_cop: 17800, repetido: false, nota: 'sin canela' });
    expect(pedido.codigo).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
    expect(pedido.cortesia_toppings).toEqual([{ clave: 'avena', nombre: 'Avena' }]);
    expect((await tienda.crearPedido(args)).repetido).toBe(true);
    expect((await tienda.misPedidos())).toHaveLength(1);
    expect((await tienda.voyEnCamino(pedido.id)).en_camino_en).toBeTruthy();
  }, 60000);

  it('el cliente no lee pedidos directo ni usa la bandeja del POS', async () => {
    const directo = await clienteSb.from('pedidos_web').select('*');
    expect(directo.data || []).toHaveLength(0);
    const r = await clienteSb.rpc('pedidos_web_abiertos');
    expect(r.error).not.toBeNull();
    const e = await clienteSb.rpc('entregar_pedido_web', { p_pedido: pedido.id, p_codigo: pedido.codigo, p_medio: 'efectivo', p_efectivo_recibido: 20000 });
    expect(e.error).not.toBeNull();
  });

  it('el POS lo recibe sin el código, lo prepara y lo entrega: se crea la venta web y se suman los puntos', async () => {
    const lista = await pos.pedidosWebAbiertos();
    const p = lista.find((x) => x.id === pedido.id);
    expect(p).toMatchObject({ estado: 'recibido', metodo_pago: 'al_recoger', total_cop: 17800 });
    expect(p.en_camino_en).toBeTruthy();
    expect(JSON.stringify(p)).not.toContain(pedido.codigo);
    expect((await pos.cambiarEstadoPedidoWeb(pedido.id, 'preparando')).estado).toBe('preparando');
    expect((await tienda.misPedidos())[0].estado).toBe('preparando');
    expect((await pos.cambiarEstadoPedidoWeb(pedido.id, 'listo')).estado).toBe('listo');

    await expect(pos.entregarPedidoWeb(pedido.id, 'ZZZZ', 'efectivo', 20000)).rejects.toMatchObject({ message: expect.stringContaining('código no coincide') });
    await expect(pos.entregarPedidoWeb(pedido.id, pedido.codigo)).rejects.toMatchObject({ message: expect.stringContaining('Registra cómo pagó') });
    expect((await tienda.misPedidos())[0].estado).toBe('listo');   // los intentos fallidos no cambian nada
    expect((await clienteSb.rpc('mi_saldo')).data).toBe(0);

    const r = await pos.entregarPedidoWeb(pedido.id, pedido.codigo.toLowerCase(), 'efectivo', 20000);
    expect(r).toMatchObject({ estado: 'entregado', total_cop: 17800, cambio_cop: 2200, puntos_acreditados: 17 });
    await expect(pos.entregarPedidoWeb(pedido.id, pedido.codigo, 'efectivo', 20000)).rejects.toMatchObject({ message: expect.stringContaining('ya se entregó') });

    const venta = await admin.from('ventas').select('canal, estado, medio_pago, cliente_id, total_cop').eq('id', r.venta_id).single();
    expect(venta.data).toMatchObject({ canal: 'web', estado: 'pagada', medio_pago: 'efectivo', cliente_id: clienteId, total_cop: 17800 });
    expect((await clienteSb.rpc('mi_saldo')).data).toBe(17);
    expect((await tienda.misPedidos())[0].estado).toBe('entregado');
  }, 60000);
});
