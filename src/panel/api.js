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
  };
}
