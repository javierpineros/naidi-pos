# Naidi.fit POS + Fidelización

Repositorio: https://github.com/javierpineros/naidi-pos (un repositorio por proyecto; independiente del prototipo de catálogo).

@docs/naidi/CLAUDE_NAIDI.md

## Mapa del repositorio

- `docs/naidi/` — especificación, decisiones, compatibilidad iPad y prompt inicial. Empieza por `LEEME.md`.
- `referencia/` — **solo referencia de diseño** (no es código de producción). `referencia/index.html` es el catálogo prototipo de Naidí con la identidad visual vigente; ábrelo en el navegador para ver colores, tipografías y componentes.

## Stack y entorno local

- Supabase completo (Postgres, Auth, RLS, Realtime, funciones del servidor). Front estático con Vite; sin NestJS ni Prisma.
- Requiere Docker Desktop (motor WSL2 activo) y Supabase CLI. Desde la raíz: `supabase start`, `supabase status`, `supabase db reset`, `supabase stop`.
- `supabase/migrations/` — esquema versionado en SQL. Studio local: http://127.0.0.1:54323.
- Front: `pnpm install`, `pnpm dev`, `pnpm build` (target Safari 12). Pruebas: `pnpm test` (Vitest + jsdom) y `pnpm test:db` (pgTAP en `supabase/tests/`, requiere `supabase start`).
- Variables en `.env.local` (ver `.env.example`); la `service_role` nunca va en el front ni en el repo.
- El repo no usa `fullstack-base-template`.

## Identidad visual (tomada de `referencia/`)

- Colores de marca: púrpura `#59358C` y verde `#95C23D`, más neutros crema/blanco.
- Títulos: Bohemian Soul Regular (embebida en base64 en `referencia/index.html`), fallback Fraunces. Texto: Montserrat. Precios/puntos/datos: Space Mono.
- Logos: `referencia/images/logo/` (logo-nombre, logo-simbolo, logo-acai).
- Texto visible en español colombiano, con tuteo.

## Flujo de trabajo

- Una rama y un PR por hito; no se empuja a `main` ni se hace merge sin aprobación de Javier.
- Los archivos de diseño pesados (`.psd`, imágenes originales) no van al repositorio.
