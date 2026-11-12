// Manejadores HTTP de las Edge Functions de Bold. Reciben sus dependencias (secretos, clientes de Supabase, fetch)
// para que las mismas funciones corran en Deno y en las pruebas de Node. Las llaves de Bold salen solo de los secretos.
import { diagnosticarFirma, eventoDeVoucher, firmaIntegridad, firmaValida, firmaValidaConLlaveVacia, normalizarEvento } from './bold.ts';

export interface Secretos {
  identidad: string;        // llave de identidad (pública: va en el botón)
  secreta: string;          // llave secreta (firma el hash y valida el webhook)
  sitio: string;            // https://tienda... sin barra final: a dónde vuelve el cliente tras pagar
  tokenConciliacion: string;
  aceptarFirmaVaciaPruebas?: boolean;   // solo entornos de pruebas/locales: acepta además la firma hecha con llave vacía (sandbox de Bold)
}

export interface Dependencias {
  secretos: Secretos;
  clienteServicio: { rpc: (nombre: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };
  clienteUsuario: (autorizacion: string) => { rpc: (nombre: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };
  fetch?: typeof fetch;
}

const CABECERAS_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(cuerpo: unknown, estado = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'Content-Type': 'application/json', ...extra } });
}

// ------------------------------------------------------------------ Checkout: datos firmados para el Botón de pagos
export async function manejarCheckout(req: Request, d: Dependencias): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CABECERAS_CORS });
  const cors = CABECERAS_CORS;
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, cors);
  const autorizacion = req.headers.get('Authorization') || '';
  if (!autorizacion.toLowerCase().startsWith('bearer ')) return json({ error: 'Inicia sesión para pagar.' }, 401, cors);
  if (!d.secretos.identidad || !d.secretos.secreta) return json({ error: 'El pago en línea todavía no está disponible.' }, 503, cors);

  let pedido = '';
  try { pedido = String((await req.json()).pedido_id || ''); } catch (_e) { /* cuerpo inválido */ }
  if (!pedido) return json({ error: 'Falta el pedido.' }, 400, cors);

  // El monto lo decide la base de datos con el pedido guardado; el cliente solo dice cuál pedido.
  const { data, error } = await d.clienteUsuario(autorizacion).rpc('iniciar_pago_pedido_web', { p_pedido: pedido });
  if (error) {
    const msg = String(error.message || 'No se pudo iniciar el pago.');
    return json({ error: msg }, /no está disponible/i.test(msg) ? 404 : 400, cors);
  }
  const firma = await firmaIntegridad(data.order_id, data.monto_cop, data.moneda, d.secretos.secreta);
  return json({
    apiKey: d.secretos.identidad,
    orderId: data.order_id,
    amount: data.monto_cop,
    currency: data.moneda,
    integritySignature: firma,
    description: data.descripcion,
    // Bold solo acepta URLs de retorno https. En desarrollo con http://localhost se omite y la persona vuelve a la tienda por su cuenta.
    redirectionUrl: d.secretos.sitio.startsWith('https://') ? d.secretos.sitio + '/tienda/' : null,
  }, 200, cors);
}

// ------------------------------------------------------------------ Webhook: la firma se verifica con el cuerpo crudo
export async function manejarWebhook(req: Request, d: Dependencias): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
  const crudo = await req.text();
  if (crudo.length > 200000) return json({ error: 'Cuerpo muy grande.' }, 413);
  const cabeceraFirma = req.headers.get('x-bold-signature');
  let firmaOk = await firmaValida(crudo, cabeceraFirma, d.secretos.secreta);
  if (!firmaOk && d.secretos.aceptarFirmaVaciaPruebas && await firmaValidaConLlaveVacia(crudo, cabeceraFirma)) {
    console.warn('[bold-webhook] aceptada firma con llave vacía (modo pruebas): no uses esto en producción');
    firmaOk = true;
  }
  if (!firmaOk) {
    // Rastro para depurar (sin datos del cuerpo ni llaves): permite distinguir "no llegó" de "llegó y la firma no coincide".
    console.warn('[bold-webhook] firma no válida', { cabecera: !!req.headers.get('x-bold-signature'), bytes: crudo.length });
    // Con qué llave/cuerpo habría coincidido (solo verdadero/falso): sirve para aclarar cómo firma Bold en pruebas.
    try {
      console.warn('[bold-webhook] diagnóstico de firma',
        await diagnosticarFirma(crudo, req.headers.get('x-bold-signature'), { secreta: d.secretos.secreta, identidad: d.secretos.identidad }));
    } catch (_e) { /* el diagnóstico nunca debe cambiar la respuesta */ }
    return json({ error: 'Firma no válida.' }, 401);
  }
  let ev: any = null;
  try { ev = JSON.parse(crudo); } catch (_e) { /* inválido */ }
  const e = normalizarEvento(ev);
  if (!e) return json({ error: 'Evento sin id o sin referencia.' }, 400);

  // El sandbox de Bold manda las ventas aprobadas con amount.total en 0, y un pago real nunca es 0 (mínimo $1.000).
  // Sin un monto utilizable el evento solo sirve de aviso: el monto y el estado salen del comprobante que Bold devuelve
  // a nuestra llave del servidor, y la base de datos los valida contra el intento igual que siempre.
  if (e.tipo === 'SALE_APPROVED' && e.monto <= 0) {
    const r = await conciliarOrden(d, e.orderId);
    console.info('[bold-webhook] evento sin monto utilizable; se confirma con el comprobante de Bold', e.orderId, r);
    if (r === 'bandera_apagada') return json({ error: 'No encontrado.' }, 404);
    if (r === 'error' || r === 'error_red' || r.startsWith('sin_voucher')) return json({ error: 'No se pudo confirmar el pago todavía.' }, 500);   // Bold reintenta
    return json({ resultado: r }, 200);
  }

  const { data, error } = await d.clienteServicio.rpc('aplicar_evento_bold', {
    p_evento_id: e.eventoId, p_tipo: e.tipo, p_order_id: e.orderId, p_bold_payment_id: e.boldPaymentId,
    p_monto: e.monto, p_moneda: e.moneda, p_medio: e.medio, p_crudo: ev,
  });
  if (error) { console.error('[bold-webhook] error al aplicar el evento', e.tipo, e.orderId); return json({ error: 'No se pudo procesar el evento.' }, 500); }   // Bold reintenta
  console.info('[bold-webhook] evento aplicado', e.tipo, e.orderId, data && data.resultado);
  // Si el monto no cuadra, deja a la vista cómo mandó Bold los montos (solo importes y moneda, sin datos de la persona).
  if (data && data.resultado === 'monto_distinto') {
    const a = ev && ev.data && typeof ev.data.amount === 'object' ? ev.data.amount : null;
    console.warn('[bold-webhook] monto distinto: forma del monto en el evento', { leido: e.monto, amount: a, claves: Object.keys((ev && ev.data) || {}) });
  }
  // Con la bandera apagada la ruta no existe para el mundo exterior.
  if (data && data.resultado === 'bandera_apagada') return json({ error: 'No encontrado.' }, 404);
  return json({ resultado: data && data.resultado }, 200);
}

// ------------------------------------------------------------------ Conciliación: respaldo si el webhook no llegó
export async function manejarConciliacion(req: Request, d: Dependencias): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
  const token = req.headers.get('x-conciliacion-token') || '';
  if (!d.secretos.tokenConciliacion || token !== d.secretos.tokenConciliacion) return json({ error: 'No autorizado.' }, 401);
  if (!d.secretos.identidad) return json({ error: 'El pago en línea todavía no está disponible.' }, 503);

  const { data: pendientes, error } = await d.clienteServicio.rpc('pagos_bold_por_conciliar', { p_minutos: 15 });
  if (error) return json({ error: 'No se pudo leer los pagos pendientes.' }, 500);
  const resumen: Record<string, string> = {};
  for (const p of (pendientes || [])) resumen[p.order_id] = await conciliarOrden(d, p.order_id);
  return json({ revisados: Object.keys(resumen).length, resumen }, 200);
}

// Pregunta a Bold por el estado real de una referencia y lo aplica como un evento propio (idempotente en la base de datos).
async function conciliarOrden(d: Dependencias, orderId: string): Promise<string> {
  const llamar = d.fetch || fetch;
  try {
    const r = await llamar('https://payments.api.bold.co/v2/payment-voucher/' + encodeURIComponent(orderId), {
      headers: { Authorization: 'x-api-key ' + d.secretos.identidad, 'Content-Type': 'application/json' },
    });
    if (r.status !== 200) return 'sin_voucher_' + r.status;
    const e = eventoDeVoucher(orderId, await r.json());
    if (!e) return 'sin_cambio';
    const { data, error: err } = await d.clienteServicio.rpc('aplicar_evento_bold', {
      p_evento_id: e.eventoId, p_tipo: e.tipo, p_order_id: e.orderId, p_bold_payment_id: e.boldPaymentId,
      p_monto: e.monto, p_moneda: e.moneda, p_medio: e.medio, p_crudo: { origen: 'conciliacion' },
    });
    return err ? 'error' : String(data && data.resultado);
  } catch (_e) {
    return 'error_red';
  }
}

// ------------------------------------------------------------------ Verificación del cliente: "ya pagué, ¿llegó?"
// Con la sesión del cliente se leen las referencias pendientes de SU pedido y se le pregunta a Bold (con la llave del servidor).
// El cliente no aporta ningún dato del pago: lo que se aplica sale de la respuesta de Bold, validada por la base de datos.
export async function manejarVerificacion(req: Request, d: Dependencias): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CABECERAS_CORS });
  const cors = CABECERAS_CORS;
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, cors);
  const autorizacion = req.headers.get('Authorization') || '';
  if (!autorizacion.toLowerCase().startsWith('bearer ')) return json({ error: 'Inicia sesión para continuar.' }, 401, cors);
  if (!d.secretos.identidad) return json({ error: 'El pago en línea todavía no está disponible.' }, 503, cors);
  let pedido = '';
  try { pedido = String((await req.json()).pedido_id || ''); } catch (_e) { /* cuerpo inválido */ }
  if (!pedido) return json({ error: 'Falta el pedido.' }, 400, cors);
  const { data, error } = await d.clienteUsuario(autorizacion).rpc('mis_pagos_bold_pendientes', { p_pedido: pedido });
  if (error) return json({ error: String(error.message || 'No se pudo verificar el pago.') }, 400, cors);
  const resumen: Record<string, string> = {};
  for (const p of (data || [])) resumen[p.order_id] = await conciliarOrden(d, p.order_id);
  return json({ revisados: Object.keys(resumen).length, resumen }, 200, cors);
}
