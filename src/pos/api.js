// Capa fina entre el POS y Supabase. Todo lo que el POS necesita del servidor pasa por aquí,
// así las pruebas pueden sustituirla y la UI no conoce nombres de funciones SQL.
import { traducirError, ErrorRed } from '../lib/errores.js';

export function crearApi(client) {
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

  async function tabla(nombre, columnas, ajustar) {
    let q = client.from(nombre).select(columnas || '*');
    if (ajustar) q = ajustar(q);
    let res;
    try {
      res = await q;
    } catch (e) {
      throw new ErrorRed();
    }
    if (res.error) throw traducirError(res.error);
    return res.data;
  }

  return {
    // ---- Sesión
    async sesion() {
      const { data } = await client.auth.getSession();
      const s = data && data.session;
      if (!s) return null;
      const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      return {
        id: s.user.id,
        email: s.user.email,
        nivel: aal.data ? aal.data.currentLevel : 'aal1',
        siguiente: aal.data ? aal.data.nextLevel : 'aal1',
      };
    },
    async enviarCodigo(email) {
      const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) throw traducirError(error);
    },
    async verificarCodigo(email, token) {
      const { error } = await client.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw traducirError(error);
    },
    async mfaFactor() {
      const { data, error } = await client.auth.mfa.listFactors();
      if (error) throw traducirError(error);
      const f = (data.totp || []).find((x) => x.status === 'verified');
      return f ? f.id : null;
    },
    async mfaEnrolar() {
      const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw traducirError(error);
      return { id: data.id, qr: data.totp.qr_code, secreto: data.totp.secret };
    },
    async mfaVerificar(factorId, code) {
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
      if (error) throw traducirError(error);
    },
    async salir() {
      await client.auth.signOut();
    },
    async miPerfilDePersonal(userId) {
      const filas = await tabla('staff', 'rol,nombre,activo', (q) => q.eq('user_id', userId));
      return filas && filas[0] && filas[0].activo ? filas[0] : null;
    },

    // ---- Catálogo y reglas
    async catalogo() {
      const [productos, tamanos, toppings, bases, presentaciones] = await Promise.all([
        tabla('productos', '*', (q) => q.order('orden')),
        tabla('tamanos', '*', (q) => q.order('orden')),
        tabla('toppings', '*', (q) => q.order('orden')),
        tabla('bases', '*', (q) => q.order('orden')),
        tabla('presentaciones', '*', (q) => q.order('orden')),
      ]);
      return { productos, tamanos, toppings, bases, presentaciones };
    },
    async destinoTransferencia() {
      const filas = await tabla('reglas_negocio', 'valor', (q) => q.eq('clave', 'transferencia.destino').is('vigente_hasta', null));
      return filas && filas[0] ? filas[0].valor : null;
    },

    // ---- Reportes del cliente ("esto no es lo que pedí")
    reportesAbiertos: () => rpc('reportes_abiertos'),
    resolverReporte: (id, nota) => rpc('resolver_reporte', { p_id: id, p_nota: nota || null }),

    // ---- Lista de espera
    listaEspera: () => rpc('lista_espera'),
    marcarAlertaVista: (checkin) => rpc('marcar_alerta_vista', { p_checkin: checkin }),
    marcarSeFue: (checkin) => rpc('marcar_se_fue', { p_checkin: checkin }),
    suscribirEspera(cuandoCambie) {
      const canal = client
        .channel('espera-pos')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, () => cuandoCambie())
        .subscribe();
      return () => client.removeChannel(canal);
    },

    // ---- Pedidos web (tienda)
    pedidosWebAbiertos: () => rpc('pedidos_web_abiertos'),
    estadoPedidosWeb: () => rpc('tienda_estado'),
    fijarPedidosWeb: (abierta) => rpc('fijar_pedidos_web', { p_abierta: !!abierta }),
    cambiarEstadoPedidoWeb: (pedido, estado) => rpc('cambiar_estado_pedido_web', { p_pedido: pedido, p_estado: estado }),
    entregarPedidoWeb: (pedido, codigo, medio, efectivo) =>
      rpc('entregar_pedido_web', { p_pedido: pedido, p_codigo: codigo, p_medio: medio || null, p_efectivo_recibido: efectivo === undefined ? null : efectivo }),
    marcarNoLlego: (pedido) => rpc('marcar_no_llego', { p_pedido: pedido }),
    cancelarPedidoWeb: (pedido, motivo) => rpc('cancelar_pedido_web', { p_pedido: pedido, p_motivo: motivo }),
    suscribirPedidosWeb(cuandoCambie) {
      const canal = client
        .channel('pedidos-web-pos')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos_web' }, () => cuandoCambie())
        .subscribe();
      return () => client.removeChannel(canal);
    },

    // ---- Venta
    crearVenta: ({ idem, cliente }) => rpc('crear_venta', { p_idem: idem, p_cliente: cliente || null }),
    asignarCliente: (venta, cliente) => rpc('asignar_cliente', { p_venta: venta, p_cliente: cliente }),
    agregarLinea: (venta, l) =>
      rpc('agregar_linea', {
        p_venta: venta,
        p_producto: l.producto,
        p_tamano: l.tamano || null,
        p_presentacion: l.presentacion || null,
        p_base: l.base || null,
        p_toppings: l.toppings || [],
        p_cantidad: l.cantidad || 1,
      }),
    quitarLinea: (linea) => rpc('quitar_linea', { p_linea: linea }),
    aplicarVoucher: (linea, voucher) => rpc('aplicar_voucher', { p_linea: linea, p_voucher: voucher }),
    aplicarVoucherCompra: (venta, voucher) => rpc('aplicar_voucher_compra', { p_venta: venta, p_voucher: voucher }),
    quitarVoucher: (linea) => rpc('quitar_voucher', { p_linea: linea }),
    quitarVoucherCompra: (venta) => rpc('quitar_voucher_compra', { p_venta: venta }),
    confirmarVenta: (venta) => rpc('confirmar_venta', { p_venta: venta }),
    descartarVenta: (venta) => rpc('descartar_venta', { p_venta: venta }),
    cancelarVenta: (venta, motivo) => rpc('cancelar_venta', { p_venta: venta, p_motivo: motivo }),
    pagarVenta: (venta, medio, efectivo) =>
      rpc('pagar_venta', { p_venta: venta, p_medio: medio, p_efectivo_recibido: efectivo === undefined ? null : efectivo }),
    anularVenta: (venta, motivo, pin) => rpc('anular_venta', { p_venta: venta, p_motivo: motivo, p_pin: pin }),
    vouchersActivosDe: (cliente) => rpc('vouchers_activos_de', { p_cliente: cliente }),
    ultimaCompraDe: (cliente) => rpc('ultima_compra_de', { p_cliente: cliente }),
    registrarVentaOffline: (v) =>
      rpc('registrar_venta_offline', {
        p_idem: v.idem,
        p_creada_en: v.creada_en,
        p_lineas: v.lineas,
        p_medio: v.medio,
        p_efectivo_recibido: v.efectivo_recibido === undefined ? null : v.efectivo_recibido,
      }),
    registrarVentaRappi: (v) =>
      rpc('registrar_venta_rappi', { p_idem: v.idem, p_pedido: v.pedido, p_lineas: v.lineas, p_creada_en: v.creada_en || null }),
    async venta(id) {
      const filas = await tabla('ventas', '*, venta_lineas(*)', (q) => q.eq('id', id));
      if (!filas || !filas[0]) return null;
      const v = filas[0];
      v.venta_lineas.sort((a, b) => a.orden - b.orden);
      return v;
    },

    // ---- Caja, alertas y reportes
    cierreDeCaja: (fecha) => rpc('cierre_de_caja', { p_fecha: fecha || null }),
    cerrarCaja: (fecha) => rpc('cerrar_caja', { p_fecha: fecha || null }),
    ventasDelDia: (fecha) => rpc('ventas_del_dia', { p_fecha: fecha || null }),
    listaAlertas: () => rpc('lista_alertas'),
    resolverAlerta: (id, nota) => rpc('resolver_alerta', { p_id: id, p_nota: nota }),
    reporteVentas: (desde, hasta) => rpc('reporte_ventas', { p_desde: desde, p_hasta: hasta }),
    reporteCanjes: (desde, hasta) => rpc('reporte_canjes', { p_desde: desde, p_hasta: hasta }),
  };
}
