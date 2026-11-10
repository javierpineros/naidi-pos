// Importador del catálogo: lee el catálogo vigente de referencia/index.html y genera SQL idempotente.
// El HTML es la fuente: no se ejecuta (jsdom sin scripts); solo se leen los literales de datos.
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

const ARREGLOS = ['sizes', 'presentations', 'bases', 'toppings', 'coffees', 'products'];
const NUMEROS = ['BASE_PRICE', 'TOPPINGS_INCLUDED', 'TOPPINGS_INCLUDED_MINI', 'LITRO_PRICE'];

// Devuelve el literal ([...]) que sigue a "var nombre =", respetando cadenas y anidación.
function cortarLiteral(js, nombre) {
  const m = new RegExp('var\\s+' + nombre + '\\s*=\\s*').exec(js);
  if (!m) throw new Error('No encontré "var ' + nombre + '" en el script del catálogo.');
  const ini = m.index + m[0].length;
  const abre = js[ini];
  if (abre !== '[') throw new Error('"' + nombre + '" no es un arreglo literal.');
  let prof = 0;
  let comilla = null;
  for (let i = ini; i < js.length; i++) {
    const c = js[i];
    if (comilla) {
      if (c === '\\') i++;
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"') comilla = c;
    else if (c === '[' || c === '{') prof++;
    else if (c === ']' || c === '}') {
      prof--;
      if (prof === 0) return js.slice(ini, i + 1);
    }
  }
  throw new Error('Literal sin cerrar: ' + nombre);
}

function leerNumero(js, nombre) {
  const m = new RegExp('var\\s+' + nombre + '\\s*=\\s*(\\d+)\\s*;').exec(js);
  if (!m) throw new Error('No encontré la constante numérica ' + nombre + '.');
  return Number(m[1]);
}

function entero(valor, etiqueta, { min = 0 } = {}) {
  if (!Number.isInteger(valor) || valor < min) throw new Error(etiqueta + ' debe ser un entero >= ' + min + ' (vino ' + valor + ').');
  return valor;
}

function sinRepetidos(lista, etiqueta) {
  const vistos = new Set();
  for (const x of lista) {
    if (vistos.has(x.id)) throw new Error('Id repetido en ' + etiqueta + ': ' + x.id);
    vistos.add(x.id);
  }
}

// Extrae y valida el catálogo desde el texto de index.html.
export function extraerCatalogo(html) {
  const doc = new JSDOM(html).window.document;
  const script = [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).find((t) => t.includes('var sizes'));
  if (!script) throw new Error('No encontré el script del catálogo en el HTML.');

  const datos = {};
  for (const nombre of ARREGLOS) {
    const literal = cortarLiteral(script, nombre);
    datos[nombre] = JSON.parse(JSON.stringify(vm.runInNewContext('(' + literal + ')', {}, { timeout: 200 })));
  }
  for (const nombre of NUMEROS) datos[nombre] = leerNumero(script, nombre);

  for (const nombre of ARREGLOS) sinRepetidos(datos[nombre], nombre);
  entero(datos.BASE_PRICE, 'BASE_PRICE', { min: 1 });
  entero(datos.LITRO_PRICE, 'LITRO_PRICE', { min: 1 });
  entero(datos.TOPPINGS_INCLUDED, 'TOPPINGS_INCLUDED');
  entero(datos.TOPPINGS_INCLUDED_MINI, 'TOPPINGS_INCLUDED_MINI');

  // Solo se importa el precio real. El "precio anterior" tachado (DISCOUNT_PCT) es de presentación
  // y no entra: los puntos se calculan sobre lo realmente pagado.
  const tamanos = datos.sizes.map((s, i) => ({
    clave: s.id,
    nombre: s.label,
    precio_cop: datos.BASE_PRICE + entero(s.delta, 'delta de ' + s.id),
    toppings_incluidos: s.id === 'mini' ? datos.TOPPINGS_INCLUDED_MINI : datos.TOPPINGS_INCLUDED,
    orden: i + 1,
  }));
  const presentaciones = datos.presentations.map((p, i) => ({ clave: p.id, nombre: p.label, orden: i + 1 }));
  const bases = datos.bases.map((b, i) => ({ clave: b.id, nombre: b.label, orden: i + 1 }));
  const toppings = datos.toppings.map((t, i) => ({
    clave: t.id, nombre: t.label, precio_cop: entero(t.price, 'precio de ' + t.id, { min: 1 }), orden: i + 1,
  }));

  const productos = [];
  datos.products.forEach((p, i) => {
    productos.push({
      clave: p.id, categoria: 'bowls', tipo: 'menu', nombre: p.name, descripcion: p.desc, sabor: p.flavor,
      usa_tamanos: true, precio_fijo_cop: null, foto: p.photo, orden: i + 1,
    });
  });
  productos.push({
    clave: 'bowl-personalizado', categoria: 'bowls', tipo: 'personalizado', nombre: 'Bowl personalizado',
    descripcion: 'Arma el tuyo: elige la base, el tamaño y los toppings.', sabor: null,
    usa_tamanos: true, precio_fijo_cop: null, foto: null, orden: productos.length + 1,
  });
  datos.coffees.forEach((c, i) => {
    productos.push({
      clave: c.id, categoria: 'cafes', tipo: 'cafe', nombre: c.name, descripcion: null, sabor: null,
      usa_tamanos: false, precio_fijo_cop: entero(c.price, 'precio de ' + c.id, { min: 1 }), foto: c.photo, orden: 100 + i + 1,
    });
  });
  productos.push({
    clave: 'litro-acai', categoria: 'litro', tipo: 'litro', nombre: 'Litro de açaí (32 oz)',
    descripcion: 'Litro de açaí para llevar.', sabor: null,
    usa_tamanos: false, precio_fijo_cop: datos.LITRO_PRICE, foto: 'litro', orden: 200,
  });

  return {
    categorias: [
      { clave: 'bowls', nombre: 'Bowls y smoothies', orden: 1 },
      { clave: 'cafes', nombre: 'Cafés', orden: 2 },
      { clave: 'litro', nombre: 'Litro', orden: 3 },
    ],
    tamanos, presentaciones, bases, toppings, productos,
  };
}

// ---------------------------------------------------------------------------------------------
// SQL idempotente: upsert por clave y desactivación de lo que ya no está en la fuente.
// Salida determinista (sin fechas) para poder comprobar que el archivo versionado está al día.
// ---------------------------------------------------------------------------------------------
const q = (v) => (v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'");
const n = (v) => (v === null || v === undefined ? 'null' : String(v));

function upsert(tabla, filas, columnas, conflicto, actualizables, extra = '') {
  if (!filas.length) return '';
  const valores = filas.map((f) => '  (' + columnas.map((c) => (typeof f[c] === 'number' ? n(f[c]) : typeof f[c] === 'boolean' ? String(f[c]) : q(f[c]))).join(', ') + ')').join(',\n');
  const sets = actualizables.map((c) => c + ' = excluded.' + c).concat(extra ? [extra] : []).join(', ');
  return 'insert into public.' + tabla + ' (' + columnas.join(', ') + ') values\n' + valores +
    '\non conflict (' + conflicto + ') do update set ' + sets + ';\n';
}

function desactivar(tabla, filas, columnaClave = 'clave') {
  const lista = filas.map((f) => q(f[columnaClave])).join(', ');
  return 'update public.' + tabla + ' set activo = false, updated_at = now() where activo and ' + columnaClave + ' not in (' + lista + ');\n';
}

export function generarSql(c) {
  const partes = [
    '-- GENERADO por scripts/generar-catalogo.js a partir de referencia/index.html. No lo edites a mano:',
    '-- corrige la fuente y vuelve a correr `pnpm catalogo:generar`. Es idempotente (se puede aplicar varias veces).',
    '',
    upsert('categorias', c.categorias, ['clave', 'nombre', 'orden'], 'clave', ['nombre', 'orden']),
    upsert('tamanos', c.tamanos, ['clave', 'nombre', 'precio_cop', 'toppings_incluidos', 'orden'], 'clave',
      ['nombre', 'precio_cop', 'toppings_incluidos', 'orden'], 'activo = true, updated_at = now()'),
    desactivar('tamanos', c.tamanos),
    upsert('presentaciones', c.presentaciones, ['clave', 'nombre', 'orden'], 'clave', ['nombre', 'orden']),
    upsert('bases', c.bases, ['clave', 'nombre', 'orden'], 'clave', ['nombre', 'orden'], 'activo = true, updated_at = now()'),
    desactivar('bases', c.bases),
    upsert('toppings', c.toppings, ['clave', 'nombre', 'precio_cop', 'orden'], 'clave',
      ['nombre', 'precio_cop', 'orden'], 'activo = true, updated_at = now()'),
    desactivar('toppings', c.toppings),
    upsert('productos', c.productos,
      ['clave', 'categoria', 'tipo', 'nombre', 'descripcion', 'sabor', 'usa_tamanos', 'precio_fijo_cop', 'foto', 'orden'], 'clave',
      ['categoria', 'tipo', 'nombre', 'descripcion', 'sabor', 'usa_tamanos', 'precio_fijo_cop', 'foto', 'orden'],
      'activo = true, updated_at = now()'),
    desactivar('productos', c.productos),
  ];
  return partes.filter((p) => p !== '').join('\n');
}
