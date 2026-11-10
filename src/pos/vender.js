// Cobro de una venta SIN cliente. Con conexión va por el servidor (confirma, cobra y entrega el QR para reclamar
// puntos después). Si el primer contacto con el servidor falla por red, la venta se guarda en la cola local y se
// sincroniza luego. Una vez que el servidor ya conoce la venta, solo se continúa por el servidor (reanudable):
// así nunca queda la misma venta en los dos lados.
import { esErrorRed } from '../lib/errores.js';

export function nuevaClave() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // respaldo para navegadores sin crypto.randomUUID
  const b = new Uint8Array(16);
  (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
}

// venta: { idem, lineas:[{producto,tamano,presentacion,base,toppings,cantidad}], medio, efectivo_recibido?, total_estimado, progreso? }
// Devuelve { modo:'servidor', resultado } o { modo:'cola' }. Lanza ErrorRed si se cae la conexión a medio camino
// (la venta conserva su progreso: se vuelve a llamar con el mismo objeto para continuar).
export async function cobrarSinCliente({ api, cola, venta, enLinea }) {
  const hayRed = enLinea || (() => true);
  const p = venta.progreso || (venta.progreso = { ventaId: null });

  async function aLaCola() {
    await cola.encolar({
      idem: venta.idem,
      lineas: venta.lineas,
      medio: venta.medio,
      efectivo_recibido: venta.efectivo_recibido,
      total_estimado: venta.total_estimado,
    });
    return { modo: 'cola' };
  }

  let reanudando = true;
  if (!p.ventaId) {
    reanudando = false;
    if (!hayRed()) return aLaCola();
    try {
      p.ventaId = await api.crearVenta({ idem: venta.idem, cliente: null });
    } catch (e) {
      if (esErrorRed(e)) return aLaCola();
      throw e;
    }
  }

  let estado = 'alistando';
  let enviadas = 0;
  if (reanudando) {
    const v = await api.venta(p.ventaId);
    if (!v) throw new Error('No encuentro la venta en el servidor.');
    estado = v.estado;
    enviadas = v.venta_lineas.length;
  }
  if (estado === 'alistando') {
    for (let i = enviadas; i < venta.lineas.length; i++) await api.agregarLinea(p.ventaId, venta.lineas[i]);
    await api.confirmarVenta(p.ventaId);
    estado = 'confirmada';
  }
  if (estado === 'confirmada') {
    const resultado = await api.pagarVenta(p.ventaId, venta.medio, venta.medio === 'efectivo' ? venta.efectivo_recibido : undefined);
    return { modo: 'servidor', resultado };
  }
  if (estado === 'pagada') return { modo: 'servidor', yaPagada: true, resultado: null };
  throw new Error('La venta quedó en estado "' + estado + '" y no se puede cobrar.');
}
