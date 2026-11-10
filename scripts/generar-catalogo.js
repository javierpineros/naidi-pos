// Uso: pnpm catalogo:generar   (reescribe supabase/seeds/catalogo.sql desde referencia/index.html)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraerCatalogo, generarSql } from './catalogo.js';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destino = resolve(raiz, 'supabase/seeds/catalogo.sql');

const catalogo = extraerCatalogo(readFileSync(resolve(raiz, 'referencia/index.html'), 'utf8'));
mkdirSync(dirname(destino), { recursive: true });
writeFileSync(destino, generarSql(catalogo), 'utf8');
console.log('Catálogo generado: ' + catalogo.productos.length + ' productos, ' + catalogo.toppings.length + ' toppings, ' +
  catalogo.tamanos.length + ' tamaños, ' + catalogo.bases.length + ' bases -> supabase/seeds/catalogo.sql');
