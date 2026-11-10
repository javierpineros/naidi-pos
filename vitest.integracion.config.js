import { defineConfig } from 'vitest/config';

// Pruebas de integración contra el Supabase local (requieren `supabase start`). No corren con `pnpm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integracion/**/*.test.js'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
