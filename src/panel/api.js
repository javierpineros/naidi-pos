// Capa fina entre el panel del dueño y Supabase. La seguridad real está en el servidor (rol de dueño con segundo factor
// y PIN en las decisiones sensibles); esto solo nombra las funciones para que la interfaz no las conozca.
import { crearApi } from '../pos/api.js';
import { traducirError, ErrorRed } from '../lib/errores.js';

export function crearApiPanel(client) {
  const base = crearApi(client);

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

  return {
    // ---- Acceso (el mismo del POS: correo + código, segundo factor y rol)
    sesion: base.sesion,
    enviarCodigo: base.enviarCodigo,
    verificarCodigo: base.verificarCodigo,
    mfaFactor: base.mfaFactor,
    mfaEnrolar: base.mfaEnrolar,
    mfaVerificar: base.mfaVerificar,
    miPerfilDePersonal: base.miPerfilDePersonal,
    salir: base.salir,

    // ---- PIN del dueño. fijarPin devuelve { ok:false, error } si el PIN actual falla.
    tengoPin: () => rpc('tengo_pin'),
    fijarPin: (nuevo, actual) => rpc('fijar_pin', { p_nuevo: nuevo, p_actual: actual || null }),
    // Recuperación: sin PIN actual, pero el servidor exige haber confirmado el segundo factor hace pocos minutos.
    restablecerPin: (nuevo) => rpc('restablecer_pin', { p_nuevo: nuevo }),

    // ---- Alertas y cuentas
    listaAlertas: (resueltas) => rpc('lista_alertas', { p_resueltas: !!resueltas }),
    resolverAlerta: (id, nota) => rpc('resolver_alerta', { p_id: id, p_nota: nota }),
    cuentasRestringidas: () => rpc('cuentas_restringidas'),
    // modo: 'prepago' | 'bloqueo' | null (quita la restricción). Devuelve { ok:false, error } si el PIN falla.
    restringirCuenta: (cliente, modo, motivo, pin) =>
      rpc('restringir_pedidos_web', { p_cliente: cliente, p_modo: modo, p_motivo: motivo || null, p_pin: pin }),

    // ---- Pantallas del iPad
    listarPantallas: () => rpc('listar_dispositivos'),
    emitirPantalla: (nombre, pin) => rpc('emitir_llave_dispositivo', { p_nombre: nombre, p_pin: pin }),
    revocarPantalla: (id, pin) => rpc('revocar_dispositivo', { p_id: id, p_pin: pin }),

    // ---- Pagos Bold
    pagosBold: () => rpc('pagos_bold_resumen'),

    // ---- Reportes (los mismos del POS)
    reporteVentas: base.reporteVentas,
    reporteCanjes: base.reporteCanjes,

    // ---- Reglas y banderas (lectura directa: las políticas dejan ver a todo el personal; escribir exige dueño con PIN)
    listarReglas: async () => {
      const { data, error } = await client.from('reglas_negocio').select('clave, version, valor, descripcion, publica, vigente_desde, vigente_hasta')
        .order('clave', { ascending: true }).order('version', { ascending: false });
      if (error) throw traducirError(error);
      return data;
    },
    cambiarRegla: (clave, valor, pin) => rpc('cambiar_regla', { p_clave: clave, p_valor: valor, p_pin: pin }),
    listarBanderas: async () => {
      const { data, error } = await client.from('banderas').select('clave, activa, desde, hasta, descripcion').order('clave', { ascending: true });
      if (error) throw traducirError(error);
      return data;
    },
    cambiarBandera: (clave, activa, desde, hasta, pin) => rpc('cambiar_bandera', { p_clave: clave, p_activa: activa, p_desde: desde, p_hasta: hasta, p_pin: pin }),

    // ---- QR de entrada
    puntoDeVenta: async () => {
      const { data, error } = await client.from('punto_venta').select('token, rotado_en').eq('id', 1).maybeSingle();
      if (error) throw traducirError(error);
      return data;
    },
    rotarTokenEntrada: (pin) => rpc('rotar_token_entrada', { p_pin: pin }),

    // ---- Auditoría
    auditoria: (limite) => rpc('auditoria_reciente', { p_limite: limite || 200 }),
  };
}
