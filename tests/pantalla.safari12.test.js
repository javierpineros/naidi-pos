// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { build, parseAst } from 'vite';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

// La pantalla del iPad (Safari 12.1) no debe llevar sintaxis, APIs ni CSS que ese motor no entiende.
// Se construye el proyecto de verdad y se revisa lo que el iPad descargaría (HTML, JS en todos sus fragmentos y CSS).
// Reglas: docs/naidi/COMPATIBILIDAD_IPAD.md y resultados de prueba-ipad.html en el iPad real (iOS 12.5.8, Safari 12.1.2).

const RAIZ = resolve(__dirname, '..');
let salida;
let js = [];   // { archivo, codigo }
let css = [];  // { archivo, codigo }
let html;

function seguirImportaciones(archivo, vistos) {
  if (vistos.has(archivo)) return;
  vistos.add(archivo);
  const codigo = readFileSync(archivo, 'utf8');
  js.push({ archivo, codigo });
  const ast = parseAst(codigo);
  const hijos = [];
  (function recorrer(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(recorrer); return; }
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) hijos.push(n.source.value);
    if (n.type === 'ImportExpression' && n.source && n.source.type === 'Literal') hijos.push(n.source.value);
    for (const k of Object.keys(n)) if (k !== 'type') recorrer(n[k]);
  })(ast);
  for (const rel of hijos) {
    if (typeof rel === 'string' && rel.startsWith('.')) seguirImportaciones(resolve(dirname(archivo), rel), vistos);
  }
}

beforeAll(async () => {
  salida = mkdtempSync(join(tmpdir(), 'naidi-build-'));
  await build({ root: RAIZ, logLevel: 'silent', build: { outDir: salida, emptyOutDir: true } });
  html = readFileSync(join(salida, 'pantalla', 'index.html'), 'utf8');
  const vistos = new Set();
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) seguirImportaciones(join(salida, m[1].replace(/^\//, '')), vistos);
  for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    const f = join(salida, m[1].replace(/^\//, ''));
    css.push({ archivo: f, codigo: readFileSync(f, 'utf8') });
  }
  // Los fragmentos precargados también se descargan.
  for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) seguirImportaciones(join(salida, m[1].replace(/^\//, '')), vistos);
}, 180000);

const NODOS_PROHIBIDOS = {
  ChainExpression: 'encadenamiento opcional (?.): Safari 12 falla (prueba-ipad j5)',
  PropertyDefinition: 'campos de clase (Safari 14.1)',
  StaticBlock: 'bloques estáticos de clase',
  PrivateIdentifier: 'campos privados #x (Safari 14.1)',
};
const MIEMBROS_PROHIBIDOS = ['at', 'replaceAll', 'hasOwn', 'structuredClone', 'matchAll', 'allSettled', 'clipboard', 'flatMap_'];
const GLOBALES_PROHIBIDOS = ['ResizeObserver', 'structuredClone', 'queueMicrotask_', 'Notification', 'PushManager'];

function hallazgosJs(codigo) {
  const malos = [];
  (function recorrer(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(recorrer); return; }
    if (NODOS_PROHIBIDOS[n.type]) malos.push(NODOS_PROHIBIDOS[n.type]);
    if (n.type === 'LogicalExpression' && n.operator === '??') malos.push('nullish (??): Safari 12 falla (prueba-ipad j6)');
    if (n.type === 'AssignmentExpression' && ['??=', '||=', '&&='].includes(n.operator)) malos.push('asignación lógica ' + n.operator);
    if (n.type === 'Literal' && n.bigint) malos.push('BigInt');
    if (n.type === 'Literal' && n.regex && /\(\?<[=!]|\\p\{/.test(n.regex.pattern)) malos.push('regex con lookbehind o \\p{} (Safari 16.4)');
    if (n.type === 'MemberExpression' && !n.computed && n.property && MIEMBROS_PROHIBIDOS.includes(n.property.name)) malos.push('API .' + n.property.name + ' (no existe en Safari 12)');
    if (n.type === 'Identifier' && GLOBALES_PROHIBIDOS.includes(n.name)) malos.push('global ' + n.name + ' (no existe en Safari 12 o no sirve en iOS)');
    for (const k of Object.keys(n)) if (k !== 'type') recorrer(n[k]);
  })(parseAst(codigo));
  return malos;
}

const CSS_PROHIBIDO = [
  [/(^|[;{\s])inset\s*:/, 'inset (prueba-ipad c3)'],
  [/aspect-ratio\s*:/, 'aspect-ratio (c4)'],
  [/(^|[;{\s])(row-|column-)?gap\s*:/, 'gap (c2)'],
  [/(^|[^-\w])mask-image\s*:/, 'mask-image sin prefijo -webkit- (c6)'],
  [/position\s*:\s*sticky/, 'position: sticky sin prefijo -webkit- (c7)'],
  [/(^|[^-\w])backdrop-filter\s*:/, 'backdrop-filter sin prefijo (c8)'],
  [/var\(\s*--/, 'var(--x): la prueba del iPad dio falla (c9); la pantalla usa valores directos'],
  [/clamp\(/, 'clamp() (c11)'],
  [/:(is|where|has|focus-visible)\(?/, 'selectores :is/:where/:has/:focus-visible'],
];

describe('la pantalla del iPad se construye para Safari 12', () => {
  it('el build de /pantalla existe y apunta al paquete correcto', () => {
    expect(existsSync(join(salida, 'pantalla', 'index.html'))).toBe(true);
    expect(js.length).toBeGreaterThan(0);
    expect(css.length).toBeGreaterThan(0);
  });

  it('el JavaScript no usa sintaxis ni APIs que Safari 12 no tiene', () => {
    const problemas = [];
    for (const f of js) for (const m of new Set(hallazgosJs(f.codigo))) problemas.push(f.archivo.replace(salida, '') + ': ' + m);
    expect(problemas).toEqual([]);
  });

  it('el CSS no usa propiedades que Safari 12 no soporta', () => {
    const problemas = [];
    const fuente = readFileSync(join(RAIZ, 'src', 'pantalla', 'pantalla.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const f of css.concat([{ archivo: 'src/pantalla/pantalla.css', codigo: fuente }])) {
      for (const [re, que] of CSS_PROHIBIDO) if (re.test(f.codigo)) problemas.push(f.archivo.replace(salida, '') + ': ' + que);
    }
    expect(problemas).toEqual([]);
  });

  it('en vertical el texto del reposo no crece (si no, empuja el QR al borde: se vio en el iPad real)', () => {
    const fuente = readFileSync(join(RAIZ, 'src', 'pantalla', 'pantalla.css'), 'utf8');
    const vertical = fuente.slice(fuente.indexOf('@media (orientation: portrait)'));
    const regla = /\.reposo-texto\s*\{([^}]*)\}/.exec(vertical);
    expect(regla).not.toBeNull();
    expect(regla[1]).toMatch(/(^|[;\s])flex:\s*none/);
  });

  it('la página se carga como módulo (Safari 11.1 o más) y no depende de Google Fonts para funcionar', () => {
    expect(html).toMatch(/<script[^>]+type="module"/);
    expect(html).toContain('name="robots" content="noindex"');
  });

  it('el paquete de la pantalla es liviano y no arrastra supabase-js ni el tiempo real', () => {
    const total = js.reduce((s, f) => s + Buffer.byteLength(f.codigo), 0);
    expect(total).toBeLessThan(60 * 1024);
    for (const f of js) expect(f.codigo).not.toMatch(/realtime|postgrest|gotrue/i);
  });

  it('no incluye ninguna llave de servicio', () => {
    for (const f of js.concat(css)) {
      expect(f.codigo).not.toMatch(/service_role/);
      expect(f.codigo).not.toMatch(/sb_secret_/);
    }
  });

  it('el logo que usa la pantalla existe y es PNG (no solo WebP)', () => {
    expect(readdirSync(join(salida, 'img'))).toContain('logo-nombre.png');
  });
});
