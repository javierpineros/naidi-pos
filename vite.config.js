import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { PAGINAS } from './paginas.config.js';

export default defineConfig({
  build: {
    // Compatibilidad con el iPad mini 2 (Safari 12): ver docs/naidi/COMPATIBILIDAD_IPAD.md.
    // Se aplica a todo el build hasta que /pantalla tenga su propio paquete (H6).
    target: 'safari12',
    rollupOptions: {
      input: Object.fromEntries(
        Object.entries(PAGINAS).map(([nombre, ruta]) => [nombre, resolve(__dirname, ruta)])
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    exclude: ['tests/integracion/**', 'node_modules/**'],
  },
});
