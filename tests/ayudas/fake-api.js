// Servidor simulado para probar los flujos del POS en jsdom. Imita lo esencial de las funciones SQL
// (los cálculos reales se prueban en supabase/tests con pgTAP y en tests/integracion contra la base local).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extraerCatalogo } from '../../scripts/catalogo.js';
import { crearCatalogo, precioLinea } from '../../src/lib/precio.js';
import { ErrorRed, ErrorServidor } from '../../src/lib/errores.js';

export function catalogoReal() {
  const c = extraerCatalogo(readFileSync(resolve(__dirname, '../../referencia/index.html'), 'utf8'));
  const act = (l) => l.map((x) => ({ ...x, activo: true }));
  return { productos: act(c.productos), tamanos: act(c.tamanos), toppings: act(c.toppings), bases: act(c.bases), presentaciones: c.presentaciones };
}

export function crearFakeApi(opciones) {
  const o = opciones || {};
  const datos = catalogoReal();
  const cat = crearCatalogo(datos);
  const s = {
    red: true,
    sesion: o.sesion || null,
    rol: o.rol || 'cajero',
    nivel: o.nivel || 'aal1',
    factor: o.factor || null,
    tienePerfil: o.tienePerfil !== false,
    espera: o.espera || [],
    reportes: o.reportes || [],
    vouchers: o.vouchers || {},
    ultima: o.ultima || {},
    ventas: new Map(),
    offline: new Map(),
    rappi: new Map(),
    llamadas: [],
    pinOk: true,
    seq: 0,
    cierre: o.cierre || { fecha: '2026-11-10', cerrado: false, por_medio: [], total_cop: 0, ventas: 0, anuladas: { ventas: 0, total_cop: 0 }, canceladas: 0, sin_pagar: [] },
    ventasDia: o.ventasDia || [],
    alertas: o.alertas || [],
    suscritos: [],
    pedidos: o.pedidos || [],
    suscritosPedidos: [],
  };
  const red = () => { if (!s.red) throw new ErrorRed(); };
  const reg = (n, a) => s.llamadas.push([n, a]);
  const recalc = (v) => {
    v.subtotal_cop = v.venta_lineas.reduce((a, l) => a + l.cantidad * l.precio_unitario_cop, 0);
    const dl = v.venta_lineas.reduce((a, l) => a + l.descuento_cop, 0);
    const pct = v.compra_pct ? Math.round((v.subtotal_cop - dl) * v.compra_pct / 100) : 0;
    v.descuento_cop = dl + pct;
    v.total_cop = v.subtotal_cop - v.descuento_cop;
  };
  const venta = (id) => { const v = s.ventas.get(id); if (!v) throw new ErrorServidor('La venta no existe.'); return v; };
  const copia = (x) => JSON.parse(JSON.stringify(x));

  const api = {
    _s: s,
    async sesion() { return s.sesion ? { ...s.sesion, nivel: s.nivel, siguiente: s.nivel } : null; },
    async enviarCodigo(email) { red(); reg('enviarCodigo', email); s.pendienteCorreo = email; },
    async verificarCodigo(email, token) {
      red();
      if (token !== '123456') throw new ErrorServidor('El código no es correcto o ya venció.');
      s.sesion = { id: 'u-1', email };
    },
    async miPerfilDePersonal() { return s.tienePerfil ? { rol: s.rol, nombre: 'Persona', activo: true } : null; },
    async mfaFactor() { return s.factor; },
    async mfaEnrolar() { return { id: 'f-1', qr: 'data:image/svg+xml;base64,PHN2Zy8+', secreto: 'ABCDEF' }; },
    async mfaVerificar(id, code) { if (code !== '654321') throw new ErrorServidor('Código incorrecto.'); s.nivel = 'aal2'; s.factor = id; },
    async salir() { s.sesion = null; s.nivel = 'aal1'; },
    async catalogo() { red(); return copia(datos); },
    async destinoTransferencia() { return { tipo: 'bre-b', valor: '@naidi.fit' }; },

    async listaEspera() { red(); return copia(s.espera); },
    async marcarAlertaVista(id) { red(); reg('marcarAlertaVista', id); s.espera.forEach((e) => { if (e.checkin_id === id) e.alerta_pendiente = false; }); },
    async marcarSeFue(id) { red(); reg('marcarSeFue', id); s.espera = s.espera.filter((e) => e.checkin_id !== id); },
    async reportesAbiertos() { red(); return copia(s.reportes); },
    async resolverReporte(id, nota) { red(); reg('resolverReporte', id, nota); s.reportes = s.reportes.filter((r) => r.id !== id); },
    suscribirEspera(cb) { s.suscritos.push(cb); return () => {}; },

    // ---- Pedidos web. El código del cliente vive en _codigo (el servidor no lo manda al POS).
    async pedidosWebAbiertos() { red(); return copia(s.pedidos).map((p) => { delete p._codigo; return p; }); },
    suscribirPedidosWeb(cb) { s.suscritosPedidos.push(cb); return () => {}; },
    async cambiarEstadoPedidoWeb(id, estado) {
      red(); reg('cambiarEstadoPedidoWeb', { id, estado });
      const p = s.pedidos.find((x) => x.id === id);
      if (!p || !['recibido', 'preparando'].includes(p.estado)) throw new ErrorServidor('El pedido no se puede pasar a ' + estado + '.');
      p.estado = estado;
      return copia(p);
    },
    async entregarPedidoWeb(id, codigo, medio, efectivo) {
      red(); reg('entregarPedidoWeb', { id, codigo, medio, efectivo });
      const p = s.pedidos.find((x) => x.id === id);
      if (!p) throw new ErrorServidor('El pedido no existe.');
      if (p.estado === 'entregado') throw new ErrorServidor('Este pedido ya se entregó.');
      if (String(codigo).toUpperCase() !== p._codigo) throw new ErrorServidor('El código no coincide con el del pedido. Pídele al cliente que lo revise en su cuenta.');
      if (p.metodo_pago === 'al_recoger' && !medio) throw new ErrorServidor('Registra cómo pagó el cliente: efectivo, datáfono o transferencia.');
      if (medio === 'efectivo' && efectivo < p.total_cop) throw new ErrorServidor('El efectivo recibido no alcanza para el total de ' + p.total_cop + '.');
      p.estado = 'entregado';
      return { pedido_id: id, numero: p.numero, estado: 'entregado', total_cop: p.total_cop, medio_pago: medio || 'bold_online',
        cambio_cop: medio === 'efectivo' ? efectivo - p.total_cop : null, puntos_acreditados: Math.floor(p.total_cop / 1000) };
    },
    async marcarNoLlego(id) {
      red(); reg('marcarNoLlego', id);
      const p = s.pedidos.find((x) => x.id === id);
      p.estado = 'no_llego';
      return { estado: 'no_llego', no_llego_total: 1, cuenta_senalada: false };
    },
    async cancelarPedidoWeb(id, motivo) {
      red(); reg('cancelarPedidoWeb', { id, motivo });
      const p = s.pedidos.find((x) => x.id === id);
      p.estado = 'cancelado';
      return copia(p);
    },

    async crearVenta({ idem, cliente }) {
      red();
      for (const v of s.ventas.values()) if (v.idempotency_key === idem) return v.id;
      const id = 'v-' + (++s.seq);
      s.ventas.set(id, { id, idempotency_key: idem, estado: 'alistando', cliente_id: cliente || null, venta_lineas: [], voucher_compra_id: null, compra_pct: 0, subtotal_cop: 0, descuento_cop: 0, total_cop: 0 });
      reg('crearVenta', { idem, cliente });
      return id;
    },
    async agregarLinea(id, l) {
      red();
      const v = venta(id);
      if (v.estado !== 'alistando') throw new ErrorServidor('Solo se agregan productos mientras la venta está en alistando.');
      if (l.producto === 'agotado') throw new ErrorServidor('El producto "agotado" no está disponible.');
      const p = precioLinea(cat, l);
      const pr = cat.productos.get(l.producto);
      v.venta_lineas.push({ id: 'l-' + (++s.seq), orden: v.venta_lineas.length + 1, producto_clave: l.producto, producto_nombre: pr.nombre, categoria: pr.categoria,
        tamano: l.tamano || null, presentacion: l.presentacion || null, base: l.base || null, toppings: p.toppings, cantidad: l.cantidad || 1,
        precio_unitario_cop: p.unitario, descuento_cop: 0, voucher_id: null });
      recalc(v);
      reg('agregarLinea', l);
      return v.venta_lineas[v.venta_lineas.length - 1].id;
    },
    async quitarLinea(linea) {
      red();
      for (const v of s.ventas.values()) {
        const i = v.venta_lineas.findIndex((l) => l.id === linea);
        if (i >= 0) { v.venta_lineas.splice(i, 1); recalc(v); return; }
      }
    },
    async aplicarVoucher(linea, voucher) {
      red();
      reg('aplicarVoucher', { linea, voucher });
      for (const v of s.ventas.values()) {
        const l = v.venta_lineas.find((x) => x.id === linea);
        if (!l) continue;
        const w = (s.vouchers[v.cliente_id] || []).find((x) => x.id === voucher);
        if (!w) throw new ErrorServidor('El premio no existe.');
        if (w.modalidad === 'toppings_gratis') {
          const extras = l.toppings.filter((t) => t.extra).map((t) => t.precio_cop).sort((a, b) => b - a).slice(0, w.cantidad_toppings);
          l.descuento_cop = extras.reduce((a, b) => a + b, 0);
        } else {
          l.descuento_cop = Math.round(l.precio_unitario_cop * w.descuento_pct / 100);
        }
        l.voucher_id = voucher; w.estado = 'reservado'; recalc(v);
        return;
      }
    },
    async aplicarVoucherCompra(id, voucher) {
      red();
      reg('aplicarVoucherCompra', { id, voucher });
      const v = venta(id);
      const w = (s.vouchers[v.cliente_id] || []).find((x) => x.id === voucher);
      v.compra_pct = w.descuento_pct; v.voucher_compra_id = voucher; w.estado = 'reservado'; recalc(v);
    },
    async quitarVoucher(linea) {
      red();
      for (const v of s.ventas.values()) {
        const l = v.venta_lineas.find((x) => x.id === linea);
        if (l) { const w = (s.vouchers[v.cliente_id] || []).find((x) => x.id === l.voucher_id); if (w) w.estado = 'activo'; l.voucher_id = null; l.descuento_cop = 0; recalc(v); }
      }
    },
    async quitarVoucherCompra(id) {
      red();
      const v = venta(id);
      const w = (s.vouchers[v.cliente_id] || []).find((x) => x.id === v.voucher_compra_id);
      if (w) w.estado = 'activo';
      v.voucher_compra_id = null; v.compra_pct = 0; recalc(v);
    },
    async confirmarVenta(id) {
      red();
      const v = venta(id);
      if (v.estado !== 'alistando') throw new ErrorServidor('Solo se confirma una venta en alistando.');
      if (!v.venta_lineas.length) throw new ErrorServidor('La venta no tiene productos.');
      v.estado = 'confirmada'; reg('confirmarVenta', id);
      return { venta_id: id, total_cop: v.total_cop };
    },
    async descartarVenta(id) { red(); venta(id).estado = 'cancelada'; reg('descartarVenta', id); },
    async cancelarVenta(id, motivo) { red(); const v = venta(id); v.estado = 'cancelada'; v.motivo = motivo; reg('cancelarVenta', { id, motivo }); },
    async pagarVenta(id, medio, efectivo) {
      red();
      const v = venta(id);
      if (v.estado !== 'confirmada') throw new ErrorServidor('Solo se cobra una venta confirmada.');
      if (medio === 'efectivo' && (efectivo === undefined || efectivo === null || efectivo < v.total_cop)) throw new ErrorServidor('El efectivo recibido no alcanza.');
      v.estado = 'pagada'; v.medio_pago = medio; reg('pagarVenta', { id, medio, efectivo });
      const puntos = v.cliente_id ? Math.floor(v.total_cop / 1000) : 0;
      return {
        venta_id: id, estado: 'pagada', total_cop: v.total_cop, cambio_cop: medio === 'efectivo' ? efectivo - v.total_cop : null,
        puntos_acreditados: puntos, qr_token: v.cliente_id ? null : 'ab'.repeat(32),
      };
    },
    async anularVenta(id, motivo, pin) {
      red(); reg('anularVenta', { id, motivo, pin });
      if (!s.pinOk || pin !== '2468') return { ok: false, error: 'pin_incorrecto', intentos_restantes: 3 };
      return { ok: true, venta_id: id, estado: 'anulada', puntos_revertidos: 5 };
    },
    async vouchersActivosDe(cliente) { red(); return copia((s.vouchers[cliente] || []).filter((w) => w.estado === 'activo')); },
    async ultimaCompraDe(cliente) { red(); return copia(s.ultima[cliente] || null); },
    async registrarVentaOffline(v) {
      red();
      reg('registrarVentaOffline', v);
      if (s.offline.has(v.idem)) return { venta_id: s.offline.get(v.idem), duplicada: true };
      if (s.rechazarOffline) throw new ErrorServidor(s.rechazarOffline);
      const id = 'off-' + (++s.seq);
      s.offline.set(v.idem, id);
      return { venta_id: id, duplicada: false };
    },
    async registrarVentaRappi(v) {
      reg('registrarVentaRappi', v);
      red();
      if (s.rappi.has(v.pedido)) return { venta_id: s.rappi.get(v.pedido), duplicada: true };
      s.rappi.set(v.pedido, 'rap-' + (++s.seq));
      const total = v.lineas.reduce((a, l) => a + precioLinea(cat, l).subtotal, 0);
      return { venta_id: s.rappi.get(v.pedido), duplicada: false, total_cop: total };
    },
    async venta(id) { red(); const v = s.ventas.get(id); return v ? copia(v) : null; },

    async cierreDeCaja() { red(); return copia(s.cierre); },
    async cerrarCaja() { red(); reg('cerrarCaja'); s.cierre = { ...s.cierre, cerrado: true }; return { ...copia(s.cierre), ya_estaba_cerrada: false, alertas_creadas: s.cierre.sin_pagar.length }; },
    async ventasDelDia() { red(); return copia(s.ventasDia); },
    async listaAlertas() { red(); return copia(s.alertas); },
    async resolverAlerta(id, nota) { red(); reg('resolverAlerta', { id, nota }); s.alertas = s.alertas.filter((a) => a.id !== id); },
    async reporteVentas() {
      red();
      return { totales: { ventas: 3, total_cop: 30000, ticket_promedio_cop: 10000 }, por_sabor: [{ sabor: 'Açaí mango', unidades: 2, ingresos_cop: 25400 }],
        por_tamano: [{ tamano: 'Pequeño', unidades: 1, ingresos_cop: 16300 }], por_hora: [{ hora: 14, ventas: 3, total_cop: 30000 }] };
    },
    async reporteCanjes() {
      red();
      return { canjes: { cantidad: 1, puntos: 130 }, puntos_acreditados: 25, costo_total_cop: 10600, costo_sobre_ventas_pct: 27.9,
        costo_premios: [{ tipo: 'premio', modalidad: 'descuento_linea', usos: 1, costo_cop: 9100 }] };
    },
  };
  return api;
}
