import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extraerCatalogo, generarSql } from '../scripts/catalogo.js';

const leer = (ruta) => readFileSync(resolve(__dirname, '..', ruta), 'utf8');
const catalogo = extraerCatalogo(leer('referencia/index.html'));

describe('importador del catálogo desde referencia/index.html', () => {
  it('extrae los tamaños con el precio real (base 7.000 + diferencia)', () => {
    const precios = Object.fromEntries(catalogo.tamanos.map((t) => [t.clave, t.precio_cop]));
    expect(precios).toEqual({ mini: 7000, pequeno: 16300, mediano: 18200, grande: 19900 });
  });

  it('el Mini incluye 3 toppings y los demás 5', () => {
    const incluidos = Object.fromEntries(catalogo.tamanos.map((t) => [t.clave, t.toppings_incluidos]));
    expect(incluidos).toEqual({ mini: 3, pequeno: 5, mediano: 5, grande: 5 });
  });

  it('los puntos por tamaño coinciden con la especificación (1 por cada $1.000 pagados)', () => {
    const puntos = Object.fromEntries(catalogo.tamanos.map((t) => [t.clave, Math.floor(t.precio_cop / 1000)]));
    expect(puntos).toEqual({ mini: 7, pequeno: 16, mediano: 18, grande: 19 });
  });

  it('trae 8 bowls de menú, el personalizado, 3 cafés y el litro', () => {
    const porTipo = (tipo) => catalogo.productos.filter((p) => p.tipo === tipo);
    expect(porTipo('menu')).toHaveLength(8);
    expect(porTipo('personalizado')).toHaveLength(1);
    expect(porTipo('cafe').map((p) => p.precio_fijo_cop)).toEqual([2500, 3000, 4000]);
    expect(porTipo('litro')[0].precio_fijo_cop).toBe(53000);
  });

  it('trae 24 toppings con precio entero positivo y 5 bases', () => {
    expect(catalogo.toppings).toHaveLength(24);
    expect(catalogo.toppings.every((t) => Number.isInteger(t.precio_cop) && t.precio_cop > 0)).toBe(true);
    expect(catalogo.bases.map((b) => b.clave)).toEqual(['banano', 'fresa', 'mango', 'copoazu', 'acai-copoazu']);
  });

  it('no importa el "precio anterior" tachado: ningún tamaño usa el precio inflado', () => {
    // Con DISCOUNT_PCT = 0.30 el precio anterior del Pequeño sería ~23.286; el real es 16.300.
    expect(catalogo.tamanos.some((t) => t.precio_cop === Math.round(16300 / 0.7))).toBe(false);
  });

  it('las claves de categoría cubren las que suman puntos según la regla inicial', () => {
    const migracion = leer('supabase/migrations/20261109210100_h1_reglas_iniciales.sql');
    const m = /'puntos\.categorias_que_suman'[^']*'(\[[^\]]*\])'/.exec(migracion);
    const suman = JSON.parse(m[1]);
    const claves = catalogo.categorias.map((c) => c.clave);
    for (const c of suman) expect(claves).toContain(c);
  });

  it('cada producto es coherente: con tamaños no tiene precio fijo y sin tamaños sí', () => {
    for (const p of catalogo.productos) expect(p.usa_tamanos).toBe(p.precio_fijo_cop === null);
  });
});

describe('SQL generado', () => {
  it('el archivo versionado coincide con lo que genera la fuente (sin desfase)', () => {
    // Git en Windows puede convertir los fines de línea al descargar; el contenido es lo que importa.
    expect(leer('supabase/seeds/catalogo.sql').replace(/
/g, '
')).toBe(generarSql(catalogo));
  });

  it('es idempotente: todo insert tiene on conflict y se desactiva lo que ya no está', () => {
    const sql = generarSql(catalogo);
    const inserts = sql.match(/^insert into/gm).length;
    expect(sql.match(/^on conflict/gm).length).toBe(inserts);
    expect(sql).toMatch(/update public\.productos set activo = false/);
  });

  it('escapa las comillas simples', () => {
    const raro = structuredClone(catalogo);
    raro.productos[0].nombre = "L'açaí";
    expect(generarSql(raro)).toContain("'L''açaí'");
  });
});

describe('validaciones del importador', () => {
  it('falla con claridad si falta el script del catálogo', () => {
    expect(() => extraerCatalogo('<html><body>nada</body></html>')).toThrow(/script del catálogo/);
  });

  it('falla si un precio no es entero positivo', () => {
    const html = leer('referencia/index.html').replace("{id:'banano', label:'Banano', price:1000}", "{id:'banano', label:'Banano', price:0}");
    expect(() => extraerCatalogo(html)).toThrow(/precio de banano/);
  });
});
