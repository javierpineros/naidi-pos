// Precio de una línea. Es una VISTA PREVIA para mostrar el total antes de enviar y para vender sin internet;
// el servidor recalcula siempre con el catálogo vigente y es quien manda (migración H3, private.precio_linea).

export function crearCatalogo({ productos, tamanos, toppings, bases, presentaciones }) {
  const por = (lista) => new Map((lista || []).map((x) => [x.clave, x]));
  return {
    lista: { productos: productos || [], tamanos: tamanos || [], toppings: toppings || [], bases: bases || [], presentaciones: presentaciones || [] },
    productos: por(productos), tamanos: por(tamanos), toppings: por(toppings), bases: por(bases), presentaciones: por(presentaciones),
  };
}

// linea: { producto, tamano?, presentacion?, base?, toppings?: [claves], cantidad? }
export function precioLinea(cat, linea) {
  const pr = cat.productos.get(linea.producto);
  if (!pr) throw new Error('El producto no está disponible.');
  const cantidad = linea.cantidad || 1;
  const tops = linea.toppings || [];
  if (!pr.usa_tamanos) {
    if (linea.tamano || tops.length) throw new Error('"' + pr.nombre + '" no lleva tamaño ni toppings.');
    return { unitario: pr.precio_fijo_cop, subtotal: pr.precio_fijo_cop * cantidad, toppings: [] };
  }
  const tm = cat.tamanos.get(linea.tamano);
  if (!tm) throw new Error('Elige un tamaño para "' + pr.nombre + '".');
  if (pr.tipo === 'personalizado' && !cat.bases.get(linea.base)) throw new Error('Elige una base para el bowl personalizado.');
  let unitario = tm.precio_cop;
  const detalle = tops.map((clave, i) => {
    const t = cat.toppings.get(clave);
    if (!t) throw new Error('El topping "' + clave + '" no está disponible.');
    const extra = pr.tipo === 'menu' || i + 1 > tm.toppings_incluidos;
    if (extra) unitario += t.precio_cop;
    return { clave: t.clave, nombre: t.nombre, precio_cop: t.precio_cop, extra };
  });
  return { unitario, subtotal: unitario * cantidad, toppings: detalle };
}

export function totalCarrito(cat, lineas) {
  return lineas.reduce((acc, l) => acc + precioLinea(cat, l).subtotal, 0);
}
