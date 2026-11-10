// Capa fina entre /cuenta y Supabase. Todo lo que la cuenta del cliente necesita pasa por aquí: la interfaz no conoce
// nombres de funciones SQL y las pruebas pueden sustituir esta capa. El cliente nunca envía puntos ni totales: el servidor los calcula.
import { traducirError, ErrorRed, ErrorServidor } from '../lib/errores.js';

export function crearApiCuenta(client, opciones) {
  const o = opciones || {};
  const origen = o.origen || (() => window.location.origin);

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

  // Los errores de Auth vienen en inglés: se cambian por mensajes claros en español.
  async function auth(llamada, mensajes) {
    let res;
    try {
      res = await llamada();
    } catch (e) {
      throw new ErrorRed();
    }
    if (res.error) {
      const msg = String(res.error.message || '');
      if (!res.error.status && !res.error.code) throw new ErrorRed();
      if (res.error.status === 429 || /rate limit|too many/i.test(msg)) {
        throw new ErrorServidor('Pediste varios códigos seguidos. Espera un momento e inténtalo de nuevo.', 'rate_limit');
      }
      throw new ErrorServidor(mensajes.defecto, res.error.code);
    }
    return res.data;
  }

  return {
    async sesion() {
      const { data } = await client.auth.getSession();
      const s = data && data.session;
      return s ? { id: s.user.id, email: s.user.email || '' } : null;
    },
    enviarCodigo: (correo) =>
      auth(() => client.auth.signInWithOtp({ email: correo, options: { shouldCreateUser: true } }),
        { defecto: 'No pudimos enviar el código. Revisa tu correo e inténtalo de nuevo.' }),
    verificarCodigo: (correo, codigo) =>
      auth(() => client.auth.verifyOtp({ email: correo, token: codigo, type: 'email' }),
        { defecto: 'El código no es válido o ya venció. Pide uno nuevo.' }),
    entrarConGoogle: () =>
      auth(() => client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: origen() + '/cuenta/' } }),
        { defecto: 'No pudimos abrir Google. Prueba con tu correo.' }),
    async salir() { await client.auth.signOut(); },

    perfil: () => rpc('mi_perfil'),
    reglas: () => rpc('reglas_fidelizacion'),
    saldo: () => rpc('mi_saldo'),
    movimientos: (limite) => rpc('mis_movimientos', { p_limite: limite || 50 }),
    compras: (limite) => rpc('mis_compras', { p_limite: limite || 30 }),
    vouchers: () => rpc('mis_vouchers'),
    compraEnCurso: () => rpc('mi_compra_en_curso'),
    miCheckin: () => rpc('mi_checkin'),

    hacerCheckin: (token) => rpc('hacer_checkin', { p_token: token }),
    reclamarQr: (token) => rpc('reclamar_qr_posventa', { p_token: token }),
    canjear: (tamano) => rpc('canjear_premio', { p_tamano: tamano }),
    reportarPedido: (venta, nota) => rpc('reportar_pedido', { p_venta: venta, p_nota: nota || null }),
    actualizarPerfil: (celular, cumpleanos) => rpc('actualizar_mi_perfil', { p_celular: celular || null, p_cumpleanos: cumpleanos || null }),
    consentir: (tipo, version, acepta) => rpc('registrar_consentimiento', { p_tipo: tipo, p_version: version, p_acepta: !!acepta }),
  };
}
