import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { firmaIntegridad, firmaWebhook, firmaValida, iguales, normalizarEvento, eventoDeVoucher } from '../supabase/functions/_shared/bold.ts';
import { manejarCheckout, manejarWebhook, manejarConciliacion } from '../supabase/functions/_shared/manejadores.ts';

const SECRETA = 'llave-secreta-de-prueba';
const IDENTIDAD = 'llave-identidad-de-prueba';
const secretos = { identidad: IDENTIDAD, secreta: SECRETA, sitio: 'https://naidi.test', tokenConciliacion: 'tok-123' };

const eventoAprobado = (extra) => ({
  id: 'evt-1', type: 'SALE_APPROVED', subject: 'bp-1',
  data: { payment_id: 'bp-1', payment_method: 'CARD', amount: { total: 4000, currency: 'COP' }, metadata: { reference: 'NW41-abcdef0123' } },
  ...extra,
});

// Servidor simulado: guarda las llamadas a la base de datos y responde lo que se le indique.
function depsFalsas(opciones) {
  const o = opciones || {};
  const llamadas = [];
  const rpc = (quien) => async (nombre, args) => {
    llamadas.push({ quien, nombre, args });
    const r = o.respuestas && o.respuestas[nombre];
    return typeof r === 'function' ? r(args) : r || { data: { resultado: 'aprobado' }, error: null };
  };
  return {
    llamadas,
    deps: {
      secretos: { ...secretos, ...(o.secretos || {}) },
      clienteServicio: { rpc: rpc('servicio') },
      clienteUsuario: (aut) => ({ rpc: rpc('usuario:' + aut) }),
      fetch: o.fetch,
    },
  };
}

async function solicitudFirmada(ev, firma) {
  const cuerpo = typeof ev === 'string' ? ev : JSON.stringify(ev);
  const f = firma === undefined ? await firmaWebhook(cuerpo, SECRETA) : firma;
  return new Request('https://x.test/bold-webhook', { method: 'POST', body: cuerpo, headers: f ? { 'x-bold-signature': f } : {} });
}

describe('Bold: firmas', () => {
  it('el hash de integridad es SHA-256 de order_id + monto + moneda + llave secreta', async () => {
    const esperado = createHash('sha256').update('NW41-abc' + '4000' + 'COP' + SECRETA).digest('hex');
    expect(await firmaIntegridad('NW41-abc', 4000, 'COP', SECRETA)).toBe(esperado);
  });

  it('la firma del webhook es HMAC-SHA256 hex de base64(cuerpo crudo), también con tildes y emoji', async () => {
    for (const cuerpo of ['{"a":1}', '{"nombre":"Açaí ñandú 🍇"}', '']) {
      const esperado = createHmac('sha256', SECRETA).update(Buffer.from(cuerpo, 'utf8').toString('base64')).digest('hex');
      expect(await firmaWebhook(cuerpo, SECRETA)).toBe(esperado);
    }
  });

  it('acepta la firma correcta (aunque venga en mayúsculas o con espacios) y rechaza lo demás', async () => {
    const cuerpo = JSON.stringify(eventoAprobado());
    const f = await firmaWebhook(cuerpo, SECRETA);
    expect(await firmaValida(cuerpo, f, SECRETA)).toBe(true);
    expect(await firmaValida(cuerpo, ' ' + f.toUpperCase() + ' ', SECRETA)).toBe(true);
    expect(await firmaValida(cuerpo + ' ', f, SECRETA)).toBe(false);
    expect(await firmaValida(cuerpo, f.slice(1) + '0', SECRETA)).toBe(false);
    expect(await firmaValida(cuerpo, null, SECRETA)).toBe(false);
    expect(await firmaValida(cuerpo, f, '')).toBe(false);
    expect(await firmaValida(cuerpo, f, 'otra-llave')).toBe(false);
    expect(iguales('abc', 'abd')).toBe(false);
  });
});

describe('Bold: lectura de eventos', () => {
  it('aplana un evento de venta aprobada', () => {
    expect(normalizarEvento(eventoAprobado())).toEqual({ eventoId: 'evt-1', tipo: 'SALE_APPROVED', orderId: 'NW41-abcdef0123', boldPaymentId: 'bp-1', monto: 4000, moneda: 'COP', medio: 'CARD' });
  });
  it('sin id usa subject + tipo; sin referencia válida lo descarta', () => {
    expect(normalizarEvento(eventoAprobado({ id: undefined })).eventoId).toBe('bp-1:SALE_APPROVED');
    expect(normalizarEvento(eventoAprobado({ data: { metadata: { reference: 'malo ref!' }, amount: { total: 1 } } }))).toBeNull();
    expect(normalizarEvento(null)).toBeNull();
    expect(normalizarEvento({ type: 'SALE_APPROVED' })).toBeNull();
  });
  it('un monto ausente queda en -1 (la base de datos lo rechaza como distinto)', () => {
    expect(normalizarEvento(eventoAprobado({ data: { metadata: { reference: 'NW1-a' } } })).monto).toBe(-1);
  });
  it('convierte la consulta de respaldo en un evento con id propio', () => {
    const e = eventoDeVoucher('NW41-a', { payment_status: 'approved', payment_id: 'bp-9', amount: { total: 4000 }, payment_method: 'PSE' });
    expect(e).toMatchObject({ eventoId: 'conciliacion:NW41-a:SALE_APPROVED', tipo: 'SALE_APPROVED', monto: 4000, boldPaymentId: 'bp-9' });
    expect(eventoDeVoucher('NW41-a', { payment_status: 'REJECTED' }).tipo).toBe('SALE_REJECTED');
    expect(eventoDeVoucher('NW41-a', { payment_status: 'VOIDED' }).tipo).toBe('VOID_APPROVED');
    expect(eventoDeVoucher('NW41-a', { payment_status: 'PROCESSING' })).toBeNull();
  });
});

describe('Bold: webhook', () => {
  it('con firma válida entrega el evento a la base de datos y responde 200', async () => {
    const { deps, llamadas } = depsFalsas();
    const r = await manejarWebhook(await solicitudFirmada(eventoAprobado()), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ resultado: 'aprobado' });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toMatchObject({ quien: 'servicio', nombre: 'aplicar_evento_bold', args: { p_evento_id: 'evt-1', p_tipo: 'SALE_APPROVED', p_order_id: 'NW41-abcdef0123', p_monto: 4000, p_moneda: 'COP' } });
  });

  it('con firma inválida, ausente o de otro cuerpo responde 401 y no toca la base de datos', async () => {
    const { deps, llamadas } = depsFalsas();
    expect((await manejarWebhook(await solicitudFirmada(eventoAprobado(), 'f'.repeat(64)), deps)).status).toBe(401);
    expect((await manejarWebhook(await solicitudFirmada(eventoAprobado(), null), deps)).status).toBe(401);
    const otraFirma = await firmaWebhook(JSON.stringify(eventoAprobado({ id: 'otro' })), SECRETA);
    expect((await manejarWebhook(await solicitudFirmada(eventoAprobado(), otraFirma), deps)).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it('sin llave secreta configurada rechaza todo', async () => {
    const { deps, llamadas } = depsFalsas({ secretos: { secreta: '' } });
    expect((await manejarWebhook(await solicitudFirmada(eventoAprobado()), deps)).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it('con la bandera apagada la ruta responde 404', async () => {
    const { deps } = depsFalsas({ respuestas: { aplicar_evento_bold: { data: { resultado: 'bandera_apagada' }, error: null } } });
    expect((await manejarWebhook(await solicitudFirmada(eventoAprobado()), deps)).status).toBe(404);
  });

  it('si la base de datos falla responde 500 para que Bold reintente', async () => {
    const { deps } = depsFalsas({ respuestas: { aplicar_evento_bold: { data: null, error: { message: 'caída' } } } });
    expect((await manejarWebhook(await solicitudFirmada(eventoAprobado()), deps)).status).toBe(500);
  });

  it('un cuerpo que no es JSON o sin referencia responde 400; otros métodos 405; cuerpos enormes 413', async () => {
    const { deps } = depsFalsas();
    expect((await manejarWebhook(await solicitudFirmada('no es json'), deps)).status).toBe(400);
    expect((await manejarWebhook(await solicitudFirmada({ id: 'x', type: 'SALE_APPROVED', data: {} }), deps)).status).toBe(400);
    expect((await manejarWebhook(new Request('https://x.test', { method: 'GET' }), deps)).status).toBe(405);
    expect((await manejarWebhook(new Request('https://x.test', { method: 'POST', body: 'x'.repeat(200001) }), deps)).status).toBe(413);
  });
});

describe('Bold: checkout', () => {
  const peticion = (cuerpo, aut) => new Request('https://x.test/bold-checkout', { method: 'POST', body: JSON.stringify(cuerpo), headers: aut ? { Authorization: aut } : {} });
  const iniciar = { iniciar_pago_pedido_web: { data: { order_id: 'NW41-abcdef0123', monto_cop: 4000, moneda: 'COP', descripcion: 'Pedido web #41 · Naidí' }, error: null } };

  it('devuelve los datos del botón con el hash calculado en el servidor, usando la sesión de quien llama', async () => {
    const { deps, llamadas } = depsFalsas({ respuestas: iniciar });
    const r = await manejarCheckout(peticion({ pedido_id: 'p-1' }, 'Bearer jwt-cliente'), deps);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ apiKey: IDENTIDAD, orderId: 'NW41-abcdef0123', amount: 4000, currency: 'COP', redirectionUrl: 'https://naidi.test/tienda/' });
    expect(j.integritySignature).toBe(createHash('sha256').update('NW41-abcdef0123' + '4000' + 'COP' + SECRETA).digest('hex'));
    expect(JSON.stringify(j)).not.toContain(SECRETA);
    expect(llamadas).toEqual([{ quien: 'usuario:Bearer jwt-cliente', nombre: 'iniciar_pago_pedido_web', args: { p_pedido: 'p-1' } }]);
  });

  it('Bold exige https: con un sitio http (desarrollo en localhost) no se envía URL de retorno', async () => {
    const { deps } = depsFalsas({ respuestas: iniciar, secretos: { sitio: 'http://localhost:5173' } });
    const j = await (await manejarCheckout(peticion({ pedido_id: 'p-1' }, 'Bearer j'), deps)).json();
    expect(j.redirectionUrl).toBeNull();
  });

  it('ignora cualquier monto que mande el cliente: solo pasa el id del pedido', async () => {
    const { deps, llamadas } = depsFalsas({ respuestas: iniciar });
    await manejarCheckout(peticion({ pedido_id: 'p-1', monto: 1, amount: 1 }, 'Bearer j'), deps);
    expect(Object.keys(llamadas[0].args)).toEqual(['p_pedido']);
  });

  it('sin sesión 401; sin llaves configuradas 503; sin pedido 400; bandera apagada 404; otro error 400', async () => {
    expect((await manejarCheckout(peticion({ pedido_id: 'p' }), depsFalsas().deps)).status).toBe(401);
    expect((await manejarCheckout(peticion({ pedido_id: 'p' }, 'Bearer j'), depsFalsas({ secretos: { secreta: '' } }).deps)).status).toBe(503);
    expect((await manejarCheckout(peticion({}, 'Bearer j'), depsFalsas({ respuestas: iniciar }).deps)).status).toBe(400);
    const apagada = depsFalsas({ respuestas: { iniciar_pago_pedido_web: { data: null, error: { message: 'El pago en línea todavía no está disponible.' } } } }).deps;
    expect((await manejarCheckout(peticion({ pedido_id: 'p' }, 'Bearer j'), apagada)).status).toBe(404);
    const ajeno = depsFalsas({ respuestas: { iniciar_pago_pedido_web: { data: null, error: { message: 'No encontramos ese pedido.' } } } }).deps;
    expect((await manejarCheckout(peticion({ pedido_id: 'p' }, 'Bearer j'), ajeno)).status).toBe(400);
  });

  it('responde a la verificación previa del navegador (CORS)', async () => {
    const r = await manejarCheckout(new Request('https://x.test', { method: 'OPTIONS' }), depsFalsas().deps);
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Headers')).toContain('authorization');
  });
});

describe('Bold: conciliación', () => {
  const llamar = (token) => new Request('https://x.test/bold-conciliar', { method: 'POST', headers: token ? { 'x-conciliacion-token': token } : {} });

  it('exige su token', async () => {
    const { deps, llamadas } = depsFalsas();
    expect((await manejarConciliacion(llamar(), deps)).status).toBe(401);
    expect((await manejarConciliacion(llamar('malo'), deps)).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it('consulta cada pago pendiente en Bold y aplica el resultado como un evento propio', async () => {
    const consultas = [];
    const fetchFalso = async (url, init) => {
      consultas.push({ url, auth: init.headers.Authorization });
      return url.endsWith('NW1-a') ? new Response(JSON.stringify({ payment_status: 'APPROVED', payment_id: 'bp-7', amount: { total: 4000 } }), { status: 200 })
        : url.endsWith('NW2-b') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ payment_status: 'PROCESSING' }), { status: 200 });
    };
    const { deps, llamadas } = depsFalsas({
      fetch: fetchFalso,
      respuestas: { pagos_bold_por_conciliar: { data: [{ order_id: 'NW1-a' }, { order_id: 'NW2-b' }, { order_id: 'NW3-c' }], error: null } },
    });
    const r = await manejarConciliacion(llamar('tok-123'), deps);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.resumen).toEqual({ 'NW1-a': 'aprobado', 'NW2-b': 'sin_voucher_404', 'NW3-c': 'sin_cambio' });
    expect(consultas[0]).toEqual({ url: 'https://payments.api.bold.co/v2/payment-voucher/NW1-a', auth: 'x-api-key ' + IDENTIDAD });
    const aplicadas = llamadas.filter((l) => l.nombre === 'aplicar_evento_bold');
    expect(aplicadas).toHaveLength(1);
    expect(aplicadas[0].args).toMatchObject({ p_evento_id: 'conciliacion:NW1-a:SALE_APPROVED', p_tipo: 'SALE_APPROVED', p_monto: 4000 });
  });

  it('una caída de red con Bold no tumba el resto', async () => {
    const { deps } = depsFalsas({
      fetch: async () => { throw new Error('sin red'); },
      respuestas: { pagos_bold_por_conciliar: { data: [{ order_id: 'NW1-a' }], error: null } },
    });
    const j = await (await manejarConciliacion(llamar('tok-123'), deps)).json();
    expect(j.resumen).toEqual({ 'NW1-a': 'error_red' });
  });
});
