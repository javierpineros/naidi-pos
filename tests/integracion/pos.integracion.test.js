// Integración REAL: el POS (capa api.js, cola y cobro) contra el Supabase local, con sesiones de verdad.
// Verifica que los nombres y parámetros de las funciones SQL que usa el front existen y se comportan como se espera.
// Requiere `supabase start`. Correr con:  pnpm test:integracion
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { crearApi } from '../../src/pos/api.js';
import { crearCola, almacenMemoria } from '../../src/pos/cola.js';
import { cobrarSinCliente, nuevaClave } from '../../src/pos/vender.js';
import { ErrorServidor } from '../../src/lib/errores.js';

function leerEntorno() {
  const salida = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const env = {};
  for (const l of salida.split(/\r?\n/)) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const clave = () => 'Prueba-' + Math.random().toString(36).slice(2) + '-Aa1';
const sufijo = Math.random().toString(36).slice(2, 8);
let env, admin, cajero, api, cliente, clienteApi, clienteId, cajeroId;

async function crearSesion(correo, claveUso) {
  const c = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: correo, password: claveUso });
  if (error) throw new Error('No pude iniciar sesión de prueba: ' + error.message);
  return c;
}

beforeAll(async () => {
  env = leerEntorno();
  admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const pc = clave();
  const pk = clave();
  const u1 = await admin.auth.admin.createUser({ email: `cajero.${sufijo}@integracion.test`, password: pc, email_confirm: true });
  const u2 = await admin.auth.admin.createUser({ email: `cliente.${sufijo}@integracion.test`, password: pk, email_confirm: true, user_metadata: { full_name: 'Laura Patiño Ruiz' } });
  cajeroId = u1.data.user.id;
  clienteId = u2.data.user.id;
  const r = await admin.from('staff').insert({ user_id: cajeroId, rol: 'cajero', nombre: 'Cajero Integración' });
  if (r.error) throw new Error(r.error.message);
  cajero = await crearSesion(`cajero.${sufijo}@integracion.test`, pc);
  cliente = await crearSesion(`cliente.${sufijo}@integracion.test`, pk);
  api = crearApi(cajero);
  clienteApi = crearApi(cliente);
}, 60000);

describe('POS contra la base real', () => {
  it('la sesión del cajero se reconoce y tiene rol de personal', async () => {
    const ses = await api.sesion();
    expect(ses.id).toBe(cajeroId);
    expect(ses.nivel).toBe('aal1');
    expect((await api.miPerfilDePersonal(cajeroId)).rol).toBe('cajero');
    expect(await api.miPerfilDePersonal(clienteId)).toBeNull();           // un cliente no es personal
  });

  it('carga el catálogo y el destino de transferencia', async () => {
    const c = await api.catalogo();
    expect(c.productos.filter((p) => p.activo).length).toBe(13);
    expect(c.tamanos.map((t) => t.precio_cop)).toEqual([7000, 16300, 18200, 19900]);
    expect(await api.destinoTransferencia()).toMatchObject({ tipo: 'bre-b' });
  });

  it('vender sin cliente por el servidor: cobra, deja la venta pagada y entrega el QR de 256 bits', async () => {
    const cola = crearCola({ almacen: almacenMemoria() });
    const idem = nuevaClave();
    const r = await cobrarSinCliente({ api, cola, enLinea: () => true,
      venta: { idem, lineas: [{ producto: 'espresso', cantidad: 1 }, { producto: 'latte', cantidad: 1 }], medio: 'transferencia', total_estimado: 6500 } });
    expect(r.modo).toBe('servidor');
    expect(r.resultado.qr_token).toMatch(/^[0-9a-f]{64}$/);
    const v = await admin.from('ventas').select('estado,total_cop,medio_pago,cliente_id').eq('idempotency_key', idem).single();
    expect(v.data).toMatchObject({ estado: 'pagada', total_cop: 6500, medio_pago: 'transferencia', cliente_id: null });
  });

  it('venta sin internet: la cola la envía al volver la conexión y reenviar no la duplica', async () => {
    const cola = crearCola({ almacen: almacenMemoria() });
    const idem = nuevaClave();
    const r = await cobrarSinCliente({ api, cola, enLinea: () => false,
      venta: { idem, lineas: [{ producto: 'americano', cantidad: 2 }], medio: 'efectivo', efectivo_recibido: 10000, total_estimado: 6000 } });
    expect(r.modo).toBe('cola');
    const antes = await admin.from('ventas').select('id').eq('idempotency_key', idem);
    expect(antes.data.length).toBe(0);                                    // todavía no llegó al servidor

    const s1 = await cola.sincronizar(api);
    expect(s1).toMatchObject({ enviadas: 1, duplicadas: 0 });
    const despues = await admin.from('ventas').select('estado,total_cop,cambio_cop,creada_offline').eq('idempotency_key', idem);
    expect(despues.data).toEqual([{ estado: 'pagada', total_cop: 6000, cambio_cop: 4000, creada_offline: true }]);

    await cola.encolar({ idem, lineas: [{ producto: 'americano', cantidad: 2 }], medio: 'efectivo', efectivo_recibido: 10000, total_estimado: 6000 });
    const s2 = await cola.sincronizar(api);                               // la respuesta "se perdió": se reenvía
    expect(s2).toMatchObject({ enviadas: 0, duplicadas: 1 });
    expect((await admin.from('ventas').select('id').eq('idempotency_key', idem)).data.length).toBe(1);
  });

  it('Rappi: se registra una vez por número de pedido', async () => {
    const pedido = 'INT-' + sufijo;
    const a = await api.registrarVentaRappi({ idem: nuevaClave(), pedido, lineas: [{ producto: 'espresso', cantidad: 2 }] });
    expect(a).toMatchObject({ duplicada: false, total_cop: 5000 });
    const b = await api.registrarVentaRappi({ idem: nuevaClave(), pedido, lineas: [{ producto: 'latte', cantidad: 1 }] });
    expect(b).toMatchObject({ duplicada: true, venta_id: a.venta_id });
  });

  it('check-in del cliente → lista de espera del POS → venta con cliente, regalo y puntos', async () => {
    const token = (await admin.from('punto_venta').select('token').eq('id', 1).single()).data.token;
    // el cliente acepta el tratamiento de datos y escanea el QR de entrada
    const version = (await admin.from('reglas_negocio').select('valor').eq('clave', 'privacidad.version').is('vigente_hasta', null).single()).data.valor;
    const c1 = await cliente.rpc('registrar_consentimiento', { p_tipo: 'datos', p_version: version, p_acepta: true });
    expect(c1.error).toBeNull();
    const ck = await cliente.rpc('hacer_checkin', { p_token: token });
    expect(ck.error).toBeNull();
    expect(ck.data.cliente_nuevo).toBe(true);

    const espera = await api.listaEspera();
    const mio = espera.find((e) => e.cliente_id === clienteId);
    expect(mio).toMatchObject({ nombre_pila: 'Laura', inicial: 'R', cliente_nuevo: true, regalo_bienvenida: true, alerta_pendiente: true });
    expect(JSON.stringify(mio)).not.toMatch(/Patiño/);                     // el POS no ve el nombre completo
    await api.marcarAlertaVista(mio.checkin_id);
    expect((await api.listaEspera()).find((e) => e.cliente_id === clienteId).alerta_pendiente).toBe(false);

    // se atiende: venta con cliente, línea con topping extra, regalo de 1 topping gratis, pago en efectivo
    const ventaId = await api.crearVenta({ idem: nuevaClave(), cliente: clienteId });
    const linea = await api.agregarLinea(ventaId, { producto: 'amazonas', tamano: 'pequeno', toppings: ['miel'] });
    const vouchers = await api.vouchersActivosDe(clienteId);
    expect(vouchers[0]).toMatchObject({ tipo: 'bienvenida', modalidad: 'toppings_gratis', cantidad_toppings: 1 });
    await api.aplicarVoucher(linea, vouchers[0].id);
    let v = await api.venta(ventaId);
    expect(v).toMatchObject({ subtotal_cop: 17800, descuento_cop: 1500, total_cop: 16300 });
    await api.quitarVoucher(linea);
    expect((await api.venta(ventaId)).total_cop).toBe(17800);
    await api.aplicarVoucher(linea, vouchers[0].id);

    // el cliente ve su compra "por pagar" desde su celular
    await api.confirmarVenta(ventaId);
    const enCurso = await cliente.rpc('mi_compra_en_curso');
    expect(enCurso.data).toMatchObject({ estado: 'confirmada', total_cop: 16300 });

    const pago = await api.pagarVenta(ventaId, 'efectivo', 20000);
    expect(pago).toMatchObject({ cambio_cop: 3700, puntos_acreditados: 16, qr_token: null });
    expect((await cliente.rpc('mi_saldo')).data).toBe(16);
    expect((await clienteApi.catalogo()).productos.length).toBeGreaterThan(0);   // el catálogo es público

    // "repetir lo de la última vez"
    const ultima = await api.ultimaCompraDe(clienteId);
    expect(ultima.lineas[0]).toMatchObject({ producto: 'amazonas', tamano: 'pequeno', toppings: ['miel'] });

    await api.marcarSeFue(mio.checkin_id).catch(() => {});                   // ya estaba atendido: no falla
    expect((await api.listaEspera()).some((e) => e.cliente_id === clienteId)).toBe(false);
  });

  it('descartar y cancelar funcionan con los nombres reales de las funciones', async () => {
    const a = await api.crearVenta({ idem: nuevaClave(), cliente: null });
    const l = await api.agregarLinea(a, { producto: 'espresso' });
    await api.quitarLinea(l);
    await api.agregarLinea(a, { producto: 'latte' });
    await api.descartarVenta(a);
    expect((await api.venta(a)).estado).toBe('cancelada');

    const b = await api.crearVenta({ idem: nuevaClave(), cliente: null });
    await api.agregarLinea(b, { producto: 'latte' });
    await api.confirmarVenta(b);
    await api.cancelarVenta(b, 'prueba de integración');
    expect((await api.venta(b)).estado).toBe('cancelada');
  });

  it('caja: el cierre y las ventas del día cargan; cerrar la caja es idempotente', async () => {
    const c = await api.cierreDeCaja();
    expect(c.por_medio.length).toBeGreaterThan(0);
    expect(Array.isArray(await api.ventasDelDia())).toBe(true);
    const x = await api.cerrarCaja();
    expect(x.cerrado).toBe(true);
    expect((await api.cerrarCaja()).ya_estaba_cerrada).toBe(true);
  });

  it('lo que es del dueño existe y el cajero recibe un rechazo del servidor (no "función inexistente")', async () => {
    for (const llamada of [
      () => api.anularVenta(nuevaClave(), 'x', '1234'),
      () => api.listaAlertas(),
      () => api.resolverAlerta(1, 'x'),
      () => api.reporteVentas('2026-01-01', '2026-01-02'),
      () => api.reporteCanjes('2026-01-01', '2026-01-02'),
    ]) {
      const e = await llamada().then(() => null, (err) => err);
      expect(e).toBeInstanceOf(ErrorServidor);
      expect(e.codigo).toBe('42501');
    }
  });

  it('un cliente no puede usar el POS: ni crear ventas ni ver la lista de espera', async () => {
    for (const llamada of [() => clienteApi.listaEspera(), () => clienteApi.crearVenta({ idem: nuevaClave(), cliente: null }), () => clienteApi.cierreDeCaja()]) {
      const e = await llamada().then(() => null, (err) => err);
      expect(e).toBeInstanceOf(ErrorServidor);
      expect(e.codigo).toBe('42501');
    }
    const ventas = await cliente.from('ventas').select('id');
    expect(ventas.data).toEqual([]);                                       // ni leer ventas directo
  });
});
