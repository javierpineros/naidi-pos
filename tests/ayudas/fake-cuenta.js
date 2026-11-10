// Servidor simulado para probar los flujos de /cuenta en jsdom. Imita lo esencial de las funciones SQL
// (los cálculos reales se prueban en supabase/tests con pgTAP y en tests/integracion contra la base local).
import { ErrorRed, ErrorServidor } from '../../src/lib/errores.js';
import { crearCuenta } from '../../src/cuenta/app.js';
import { esperar } from './montar.js';

export const TOKEN_ENTRADA = 'ab'.repeat(24);
export const TOKEN_QR = 'cd'.repeat(32);
const copia = (x) => JSON.parse(JSON.stringify(x));

export function crearFakeCuenta(opciones) {
  const o = opciones || {};
  const s = {
    red: true,
    sesion: o.sesion === undefined ? null : o.sesion,
    esPersonal: !!o.esPersonal,
    perfil: Object.assign({ nombre: 'Laura Patiño Ruiz', nombre_pila: 'Laura', foto_url: null, celular: null, cumpleanos: null,
      privacidad_version: '2026-11-v1', acepta_datos: false, acepta_mensajes: false, compras_pagadas: 0 }, o.perfil || {}),
    reglas: { umbrales: { pequeno: 120, mediano: 130, grande: 140 }, descuento_pct: 50, cop_por_punto: 1000, voucher_dias: 45, checkin_min: 30 },
    saldo: o.saldo === undefined ? 0 : o.saldo,
    vouchers: o.vouchers || [],
    movimientos: o.movimientos || [],
    compras: o.compras || [],
    compra: o.compra || null,
    checkin: o.checkin || null,
    codigoValido: '123456',
    llamadas: [],
    fallos: {},
  };
  const reg = (n, ...a) => s.llamadas.push([n, ...a]);
  const red = () => { if (!s.red) throw new ErrorRed(); };
  const falla = (n) => { if (s.fallos[n]) throw new ErrorServidor(s.fallos[n]); };
  const cliente = () => { if (s.esPersonal) throw new ErrorServidor('Inicia sesión con tu cuenta de cliente para continuar.', '42501'); };

  const api = {
    async sesion() { return s.sesion; },
    async enviarCodigo(correo) { red(); reg('enviarCodigo', correo); falla('enviarCodigo'); },
    async verificarCodigo(correo, codigo) {
      red(); reg('verificarCodigo', correo, codigo);
      if (codigo !== s.codigoValido) throw new ErrorServidor('El código no es válido o ya venció. Pide uno nuevo.');
      s.sesion = { id: 'u-1', email: correo };
    },
    async entrarConGoogle() { reg('entrarConGoogle'); },
    async salir() { reg('salir'); s.sesion = null; },
    async perfil() { red(); cliente(); return copia(s.perfil); },
    async reglas() { red(); return copia(s.reglas); },
    async saldo() { red(); return s.saldo; },
    async movimientos() { red(); return copia(s.movimientos); },
    async compras() { red(); return copia(s.compras); },
    async vouchers() { red(); return copia(s.vouchers); },
    async compraEnCurso() { red(); return copia(s.compra); },
    async miCheckin() { red(); return copia(s.checkin); },
    async hacerCheckin(token) {
      red(); reg('hacerCheckin', token); falla('hacerCheckin');
      s.checkin = { checkin_id: 'ck-1', llegada_en: '2026-11-10T19:05:00Z', vence_en: '2026-11-10T19:35:00Z', cliente_nuevo: !!o.clienteNuevo };
      return { ...s.checkin, ya_estaba: false };
    },
    async reclamarQr(token) { red(); reg('reclamarQr', token); falla('reclamarQr'); s.saldo += 25; return { venta_id: 'v-9', puntos_acreditados: 25 }; },
    async canjear(tamano) {
      red(); reg('canjear', tamano); falla('canjear');
      const meta = s.reglas.umbrales[tamano];
      if (s.saldo < meta) throw new ErrorServidor('Te faltan ' + (meta - s.saldo) + ' puntos para este premio.');
      s.saldo -= meta;
      s.vouchers.push({ id: 'w-1', tipo: 'premio', modalidad: 'descuento_linea', descuento_pct: 50, tamanos: [tamano], estado: 'activo', vence_en: '2026-12-25T12:00:00Z' });
      return { voucher_id: 'w-1', tamano, puntos_descontados: meta, vence_en: '2026-12-25T12:00:00Z' };
    },
    async reportarPedido(venta, nota) { red(); reg('reportarPedido', venta, nota); falla('reportarPedido'); return { ok: true, ya_reportado: false }; },
    async actualizarPerfil(celular, cumple) { red(); reg('actualizarPerfil', celular, cumple); if (celular) s.perfil.celular = celular; if (cumple) s.perfil.cumpleanos = cumple; },
    async consentir(tipo, version, acepta) {
      red(); reg('consentir', tipo, version, acepta);
      if (tipo === 'datos') s.perfil.acepta_datos = acepta;
      if (tipo === 'mensajes') s.perfil.acepta_mensajes = acepta;
    },
  };
  api._s = s;
  return api;
}

export const COMPRA_POR_PAGAR = {
  venta_id: 'v-1', estado: 'confirmada', subtotal_cop: 31000, descuento_cop: 3100, total_cop: 27900, medio_pago: null, puntos_ganados: 0,
  lineas: [
    { producto: 'Amazonas', tamano: 'pequeno', presentacion: 'bowl', toppings: [{ clave: 'miel', nombre: 'Miel' }], cantidad: 1, precio_unitario_cop: 24000, descuento_cop: 3100 },
    { producto: 'Café espresso', tamano: null, presentacion: null, toppings: [], cantidad: 2, precio_unitario_cop: 3500, descuento_cop: 0 },
  ],
};

export async function montarCuenta(api, opciones) {
  const o = opciones || {};
  document.body.innerHTML = '<div id="app"></div>';
  const raiz = document.getElementById('app');
  const mem = new Map(o.almacen || []);
  const almacen = { leer: (k) => (mem.has(k) ? mem.get(k) : null), escribir: (k, v) => mem.set(k, v), borrar: (k) => mem.delete(k) };
  const hash = { v: o.hash || '' };
  const temporizadores = [];
  const cuenta = crearCuenta({
    raiz, api, almacen, sinEventos: true, googleActivo: !!o.googleActivo,
    leerHash: () => hash.v, limpiarHash: () => { hash.v = ''; },
    ahora: () => new Date('2026-11-10T20:00:00Z'),
    setInterval: (fn, ms) => { temporizadores.push({ fn, ms }); return temporizadores.length; },
    clearInterval: () => {},
  });
  await cuenta.iniciar();
  await esperar(12);
  return { cuenta, raiz, almacen: mem, hash, temporizadores };
}
