import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { PAGINAS } from '../paginas.config.js';

describe('páginas de cada superficie', () => {
  for (const [nombre, ruta] of Object.entries(PAGINAS)) {
    it(`${nombre}: existe, está en español y tiene título`, () => {
      const archivo = resolve(__dirname, '..', ruta);
      expect(existsSync(archivo)).toBe(true);
      const dom = new JSDOM(readFileSync(archivo, 'utf8'));
      const doc = dom.window.document;
      expect(doc.documentElement.lang).toBe('es');
      expect(doc.title.trim().length).toBeGreaterThan(0);
      expect(doc.querySelector('meta[name="viewport"]')).not.toBeNull();
    });
  }

  it('las páginas del personal y del iPad no se indexan', () => {
    for (const nombre of ['pos', 'pantalla', 'cuenta', 'panel']) {
      const doc = new JSDOM(readFileSync(resolve(__dirname, '..', PAGINAS[nombre]), 'utf8')).window.document;
      expect(doc.querySelector('meta[name="robots"][content="noindex"]')).not.toBeNull();
    }
  });

  it('la raíz lleva a /tienda/ cuando Bold devuelve a la persona allí, conservando la consulta', () => {
    const html = readFileSync(resolve(__dirname, '..', PAGINAS.inicio), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    const correr = (search) => {
      const destinos = [];
      const location = { search, replace: (u) => destinos.push(u) };
      new Function('location', script)(location);
      return destinos;
    };
    expect(correr('?bold-order-id=NW35-abc&bold-tx-status=approved')).toEqual(['/tienda/?bold-order-id=NW35-abc&bold-tx-status=approved']);
    expect(correr('')).toEqual([]);
    expect(correr('?otra=1')).toEqual([]);
  });
});
