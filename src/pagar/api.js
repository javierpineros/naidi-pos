// Capa fina entre /pagar y las Edge Functions de Bold. La persona no tiene cuenta: solo aporta el código del QR.
// El monto lo decide el servidor con el total guardado de la venta; esta página nunca lo envía ni confirma un pago.
import { ErrorRed, ErrorServidor } from '../lib/errores.js';

export function crearApiPagar(client) {
  async function invocar(nombre, codigo, mensajeBase) {
    let res;
    try {
      res = await client.functions.invoke(nombre, { body: { codigo } });
    } catch (e) {
      throw new ErrorRed();
    }
    if (res.error) {
      let mensaje = mensajeBase;
      try { const j = await res.error.context.json(); if (j && j.error) mensaje = j.error; } catch (e) { if (!res.error.context) throw new ErrorRed(); }
      throw new ErrorServidor(mensaje);
    }
    return res.data;
  }
  return {
    // Datos firmados del botón de Bold.
    iniciarPago: (codigo) => invocar('bold-checkout-venta', codigo, 'No pudimos iniciar el pago. Inténtalo de nuevo.'),
    // Le pregunta a Bold (desde el servidor) por los intentos pendientes y devuelve cómo quedó la compra:
    // { estado: 'abierta' | 'pagada' | 'actualizando' | 'cerrada' | 'invalido', total_cop }.
    estado: (codigo) => invocar('bold-verificar-venta', codigo, 'No pudimos revisar tu pago todavía.'),
  };
}
