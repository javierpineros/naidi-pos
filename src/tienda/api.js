// Capa fina entre la tienda web y Supabase. La tienda nunca envía precios ni totales: manda qué pidió la persona
// y el servidor calcula todo con el catálogo vigente. Las pruebas pueden sustituir esta capa.
import { traducirError, ErrorRed, ErrorServidor } from '../lib/errores.js';
import { crearApiCuenta } from '../cuenta/api.js';

export function crearApiTienda(client, opciones) {
  const auth = crearApiCuenta(client, opciones);

  async function rpc(nombre, args) {
    let res;
    try {
      res = await client.rpc(nombre, args || {});
    } catch (e) {
      throw new ErrorRed();
    }
    if (res.error) throw traducirError(res.error);
    return res.data;
  }

  async function tabla(nombre) {
    let res;
    try {
      res = await client.from(nombre).select('*').order('orden');
    } catch (e) {
      throw new ErrorRed();
    }
    if (res.error) throw traducirError(res.error);
    return res.data;
  }

  return {
    // Inicio de sesión y consentimiento: la misma cuenta que /cuenta.
    sesion: auth.sesion,
    enviarCodigo: auth.enviarCodigo,
    verificarCodigo: auth.verificarCodigo,
    entrarConGoogle: auth.entrarConGoogle,
    salir: auth.salir,
    perfil: auth.perfil,
    consentir: auth.consentir,

    // Públicos (sin sesión)
    async catalogo() {
      const [productos, tamanos, toppings, bases, presentaciones] = await Promise.all(
        ['productos', 'tamanos', 'toppings', 'bases', 'presentaciones'].map(tabla));
      return { productos, tamanos, toppings, bases, presentaciones };
    },
    estado: () => rpc('tienda_estado'),

    // Con sesión
    miTienda: () => rpc('mi_tienda'),
    crearPedido: (p) =>
      rpc('crear_pedido_web', {
        p_idem: p.idem,
        p_lineas: p.lineas,
        p_ventana_inicio: p.ventanaInicio,
        p_ventana_fin: p.ventanaFin,
        p_pago: p.pago,
        p_cortesia: p.cortesia || [],
        p_nota: p.nota || null,
      }),
    misPedidos: (limite) => rpc('mis_pedidos_web', { p_limite: limite || 20 }),
    // Datos firmados del Botón de pagos de Bold. El monto lo decide el servidor con el pedido guardado.
    async iniciarPagoBold(pedido) {
      let res;
      try {
        res = await client.functions.invoke('bold-checkout', { body: { pedido_id: pedido } });
      } catch (e) {
        throw new ErrorRed();
      }
      if (res.error) {
        let mensaje = 'No pudimos iniciar el pago. Inténtalo de nuevo.';
        try { const j = await res.error.context.json(); if (j && j.error) mensaje = j.error; } catch (e) { if (!res.error.context) throw new ErrorRed(); }
        throw new ErrorServidor(mensaje);
      }
      return res.data;
    },
    voyEnCamino: (pedido) => rpc('voy_en_camino', { p_pedido: pedido }),
    cancelarPedido: (pedido) => rpc('cancelar_mi_pedido_web', { p_pedido: pedido }),
  };
}
