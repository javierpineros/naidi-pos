// Servidor simulado para probar los flujos de /tienda en jsdom. Imita lo esencial de las funciones SQL
// (el cálculo real y las reglas se prueban en supabase/tests con pgTAP y en tests/integracion contra la base local).
import { catalogoReal } from './fake-api.js';
import { crearCatalogo, precioLinea } from '../../src/lib/precio.js';
import { ErrorRed, ErrorServidor } from '../../src/lib/errores.js';

const copia = (x) => JSON.parse(JSON.stringify(x));

export function crearFakeTienda(opciones) {
  const o = opciones || {};
  const datos = catalogoReal();
  const cat = crearCatalogo(datos);
  const s = {
    red: true,
    sesion: o.sesion === undefined ? null : o.sesion,
    perfil: Object.assign({ nombre: 'Laura Patiño Ruiz', privacidad_version: '2026-11-v1', acepta_datos: true }, o.perfil || {}),
    estado: Object.assign({
      abierta: true,
      pagos: { al_recoger: true, en_linea: false },
      ventana: { min_anticipacion_min: 20, max_anticipacion_horas: 3, max_duracion_min: 60 },
      max_abiertos: 2,
      cortesia: { activo: true, cantidad: 1 },
    }, o.estado || {}),
    mia: Object.assign({ cortesia_disponible: true, abiertos: 0, max_abiertos: 2, restriccion: null }, o.mia || {}),
    pedidos: o.pedidos || [],
    llamadas: [],
    seq: 0,
    codigoValido: '123456',
  };
  const red = () => { if (!s.red) throw new ErrorRed(); };
  const reg = (n, a) => s.llamadas.push([n, a]);
  const cliente = () => { if (!s.sesion) throw new ErrorServidor('Inicia sesión con tu cuenta para continuar.', '42501'); };

  const api = {
    _s: s,
    async sesion() { return s.sesion; },
    async enviarCodigo(correo) { red(); reg('enviarCodigo', correo); },
    async verificarCodigo(correo, codigo) {
      red(); reg('verificarCodigo', { correo, codigo });
      if (codigo !== s.codigoValido) throw new ErrorServidor('El código no es válido o ya venció. Pide uno nuevo.');
      s.sesion = { id: 'u-1', email: correo };
    },
    async entrarConGoogle() { reg('entrarConGoogle'); },
    async salir() { reg('salir'); s.sesion = null; },
    async perfil() { red(); cliente(); return copia(s.perfil); },
    async consentir(tipo, version, acepta) { red(); reg('consentir', { tipo, version, acepta }); if (tipo === 'datos') s.perfil.acepta_datos = !!acepta; },
    async catalogo() { red(); return copia(datos); },
    async estado() { red(); return copia(s.estado); },
    async miTienda() { red(); cliente(); return copia(s.mia); },
    async crearPedido(p) {
      reg('crearPedido', p);
      red();
      cliente();
      const previo = s.pedidos.find((x) => x._idem === p.idem);
      if (previo) return copia(previo);
      if (!s.estado.abierta) throw new ErrorServidor('Por ahora no estamos recibiendo pedidos en línea. Puedes pedir directamente en la tienda.');
      let total = 0;
      const lineas = p.lineas.map((l) => {
        const pr = cat.productos.get(l.producto);
        const pl = precioLinea(cat, { producto: l.producto, tamano: l.tamano, presentacion: l.presentacion, base: l.base, toppings: l.toppings, cantidad: l.cantidad });
        total += pl.subtotal;
        return { producto_clave: l.producto, producto_nombre: pr.nombre, categoria: pr.categoria, tamano: l.tamano, presentacion: l.presentacion, base: l.base,
          toppings: pl.toppings, cantidad: l.cantidad, precio_unitario_cop: pl.unitario };
      });
      const pedido = {
        id: 'pw-' + (++s.seq), numero: 40 + s.seq, estado: 'recibido', metodo_pago: p.pago,
        pago_en_linea_estado: p.pago === 'en_linea' ? 'pendiente' : 'no_aplica', codigo: 'K7P2',
        ventana_inicio: p.ventanaInicio, ventana_fin: p.ventanaFin, en_camino_en: null,
        cortesia_toppings: (p.cortesia || []).map((c) => ({ clave: c, nombre: cat.toppings.get(c).nombre })),
        nota: p.nota, subtotal_cop: total, total_cop: total, creado_en: '2026-11-10T15:00:00Z', lineas, _idem: p.idem,
      };
      s.pedidos.unshift(pedido);
      s.mia.abiertos += 1;
      return { ...copia(pedido), repetido: false };
    },
    async misPedidos() { red(); cliente(); return copia(s.pedidos); },
    async voyEnCamino(id) { red(); reg('voyEnCamino', id); const p = s.pedidos.find((x) => x.id === id); p.en_camino_en = '2026-11-10T16:00:00Z'; return copia(p); },
    async cancelarPedido(id) {
      red(); reg('cancelarPedido', id);
      const p = s.pedidos.find((x) => x.id === id);
      if (p.estado !== 'recibido') throw new ErrorServidor('Tu pedido ya está en preparación o cerrado; habla con el personal para cambiarlo.');
      p.estado = 'cancelado';
      s.mia.abiertos -= 1;
      return copia(p);
    },
  };
  return api;
}
