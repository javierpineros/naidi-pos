// Utilidades puras de Bold (sin red ni base de datos). Corren igual en Deno (Edge Functions) y en Node (pruebas).
// Diseño tomado del proyecto our-memories (docs/02-suscripciones-bold.md §5 y config/billing.php).

const codificador = new TextEncoder();

function aHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// base64 del cuerpo crudo (bytes), sin depender de Buffer ni de btoa con Latin-1.
function aBase64(bytes: Uint8Array): string {
  const tabla = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let salida = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    salida += tabla[(n >> 18) & 63] + tabla[(n >> 12) & 63];
    salida += i + 1 < bytes.length ? tabla[(n >> 6) & 63] : '=';
    salida += i + 2 < bytes.length ? tabla[n & 63] : '=';
  }
  return salida;
}

// Hash de integridad del Botón de pagos: SHA-256 en hexadecimal de order_id + monto + moneda + llave secreta.
// Se calcula siempre en el servidor; la llave secreta nunca llega al navegador.
export async function firmaIntegridad(orderId: string, monto: number, moneda: string, llaveSecreta: string): Promise<string> {
  const datos = codificador.encode(String(orderId) + String(monto) + String(moneda) + llaveSecreta);
  return aHex(await crypto.subtle.digest('SHA-256', datos));
}

// x-bold-signature: HMAC-SHA256 (hex) de base64(cuerpo crudo) con la llave secreta.
export async function firmaWebhook(cuerpoCrudo: string, llaveSecreta: string): Promise<string> {
  // WebCrypto no admite llaves de longitud cero; HMAC rellena la llave con ceros hasta el bloque (64 bytes), así que es equivalente.
  const bytes = llaveSecreta ? codificador.encode(llaveSecreta) : new Uint8Array(64);
  const llave = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const base64 = aBase64(codificador.encode(cuerpoCrudo));
  return aHex(await crypto.subtle.sign('HMAC', llave, codificador.encode(base64)));
}

// Comparación de tiempo constante para no filtrar información por la demora.
export function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

export async function firmaValida(cuerpoCrudo: string, cabecera: string | null, llaveSecreta: string): Promise<boolean> {
  if (!llaveSecreta || !cabecera) return false;
  const esperada = await firmaWebhook(cuerpoCrudo, llaveSecreta);
  return iguales(esperada, cabecera.trim().toLowerCase());
}

// El botón "Probar webhook" (y, probablemente, los pagos del sandbox) firma con la llave vacía. Solo se usa si el entorno
// de PRUEBAS lo permite explícitamente (ver aceptarFirmaVaciaPruebas); en producción una firma vacía es falsificable por cualquiera.
export async function firmaValidaConLlaveVacia(cuerpoCrudo: string, cabecera: string | null): Promise<boolean> {
  if (!cabecera) return false;
  return iguales(await firmaWebhook(cuerpoCrudo, ''), cabecera.trim().toLowerCase());
}

// Diagnóstico cuando la firma no coincide: dice con qué combinación de llave y cuerpo SÍ coincidiría la cabecera recibida.
// Devuelve solo verdadero/falso por combinación: nunca llaves, firmas ni datos del cuerpo (se imprime en los registros).
export async function diagnosticarFirma(
  cuerpoCrudo: string, cabecera: string | null, llaves: { secreta: string; identidad: string },
): Promise<Record<string, boolean | number>> {
  const recibida = (cabecera ?? '').trim().toLowerCase();
  const hmac = async (llave: string, mensaje: string): Promise<string> => {
    try {
      // WebCrypto no admite llaves de longitud cero; HMAC rellena la llave con ceros hasta el bloque (64 bytes), así que es equivalente.
      const bytes = llave ? codificador.encode(llave) : new Uint8Array(64);
      const k = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return aHex(await crypto.subtle.sign('HMAC', k, codificador.encode(mensaje)));
    } catch (_e) { return ''; }
  };
  const base64 = aBase64(codificador.encode(cuerpoCrudo));
  const prueba = async (llave: string, mensaje: string) => !!recibida && iguales(await hmac(llave, mensaje), recibida);
  return {
    largoCabecera: recibida.length,
    conPrefijoSha256: recibida.startsWith('sha256='),
    secretaSobreBase64: await prueba(llaves.secreta, base64),          // lo que implementamos hoy
    secretaSobreCuerpo: await prueba(llaves.secreta, cuerpoCrudo),     // HMAC del cuerpo sin base64
    vaciaSobreBase64: await prueba('', base64),                        // pruebas de Bold con llave vacía
    vaciaSobreCuerpo: await prueba('', cuerpoCrudo),
    identidadSobreBase64: await prueba(llaves.identidad, base64),
    identidadSobreCuerpo: await prueba(llaves.identidad, cuerpoCrudo),
  };
}

export interface EventoBold {
  eventoId: string;
  tipo: string;
  orderId: string;
  boldPaymentId: string | null;
  monto: number;
  moneda: string;
  medio: string | null;
}

// Aplana el evento de Bold. Devuelve null si no trae lo mínimo (id y referencia).
export function normalizarEvento(ev: any): EventoBold | null {
  if (!ev || typeof ev !== 'object') return null;
  const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
  const tipo = typeof ev.type === 'string' ? ev.type : '';
  const eventoId = typeof ev.id === 'string' && ev.id ? ev.id : (ev.subject ? String(ev.subject) + ':' + tipo : '');
  const orderId = data.metadata && typeof data.metadata.reference === 'string' ? data.metadata.reference : '';
  if (!eventoId || !orderId || !/^[A-Za-z0-9_-]{1,60}$/.test(orderId)) return null;
  const total = data.amount && data.amount.total !== undefined ? Number(data.amount.total) : NaN;
  return {
    eventoId: eventoId.slice(0, 120),
    tipo,
    orderId,
    boldPaymentId: data.payment_id !== undefined && data.payment_id !== null ? String(data.payment_id) : (ev.subject ? String(ev.subject) : null),
    monto: Number.isFinite(total) ? Math.round(total) : -1,
    moneda: data.amount && typeof data.amount.currency === 'string' ? data.amount.currency : 'COP',
    medio: typeof data.payment_method === 'string' ? data.payment_method.slice(0, 40) : null,
  };
}

// Respuesta de la consulta de respaldo (payment-voucher) -> evento equivalente, con id propio para que sea idempotente.
export function eventoDeVoucher(orderId: string, voucher: any): EventoBold | null {
  if (!voucher || typeof voucher !== 'object') return null;
  const estado = String(voucher.payment_status || '').toUpperCase();
  const tipo = estado === 'APPROVED' ? 'SALE_APPROVED' : (estado === 'REJECTED' || estado === 'FAILED') ? 'SALE_REJECTED' : estado === 'VOIDED' ? 'VOID_APPROVED' : '';
  if (!tipo) return null;
  const total = voucher.amount && voucher.amount.total !== undefined ? Number(voucher.amount.total) : Number(voucher.total);
  return {
    eventoId: 'conciliacion:' + orderId + ':' + tipo,
    tipo,
    orderId,
    boldPaymentId: voucher.payment_id !== undefined && voucher.payment_id !== null ? String(voucher.payment_id) : null,
    monto: Number.isFinite(total) ? Math.round(total) : -1,
    moneda: voucher.amount && typeof voucher.amount.currency === 'string' ? voucher.amount.currency : 'COP',
    medio: typeof voucher.payment_method === 'string' ? voucher.payment_method.slice(0, 40) : null,
  };
}
