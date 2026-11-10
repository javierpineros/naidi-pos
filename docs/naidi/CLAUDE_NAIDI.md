# Naidi.fit POS + Fidelización: contexto del proyecto

Este archivo se importa desde el `CLAUDE.md` del repositorio con `@docs/naidi/CLAUDE_NAIDI.md`.

## Reglas que prevalecen

1. **Stack: Supabase completo.** Postgres, Auth, RLS, Realtime y funciones del servidor; el front es estático (Vite, JavaScript sin framework pesado) y habla solo con Supabase. Sin NestJS, sin Prisma y sin auth propia. Las migraciones son SQL en `supabase/migrations/` y se prueban en local con el Supabase CLI (`supabase start`, `supabase db reset`). El proyecto no usa `fullstack-base-template`.
2. **Nada se fusiona sin aprobación.** Una rama y un PR por hito. No hagas merge ni empujes a la rama principal. Espera la revisión de Javier.
3. **Respeta el flujo de trabajo de Javier:** diagnóstico antes de cambiar; valida la sintaxis después de cada edición; pruebas de integración con jsdom para los flujos del front; agrupa las preguntas aclaratorias y hazlas antes de empezar a programar; un repositorio por proyecto.

## Qué es

Sistema para la heladería Naidi (bowls de açaí y copoazú, Bogotá) que une sobre Supabase un POS interno, un programa de puntos, una pantalla del cliente en un iPad y pedidos web para recoger en tienda. Lee `docs/naidi/ESPECIFICACION.md` y `docs/naidi/DECISIONES.md`.

## Reglas de dominio que no se negocian

- El POS es solo de control interno: sin facturación electrónica.
- Los puntos se acreditan solo cuando la venta pasa a Pagada.
- Los puntos los calcula el servidor a partir de las líneas de la venta, nunca el cliente.
- Libro de puntos inmutable: cada movimiento es una fila nueva; las anulaciones revierten con un movimiento contrario.
- Todas las reglas de negocio (puntos, umbrales, vigencias, topes, banderas) viven en una tabla versionada con fecha de vigencia, no en el código.
- La venta nunca se bloquea: sin cliente o sin internet se vende igual.
- Seguridad: RLS activado y con denegación por defecto; los clientes no leen ni escriben directamente ventas, tokens ni puntos; la llave `service_role` nunca llega al navegador ni al repositorio.
- Texto visible en español colombiano, con tuteo.

## Compatibilidad

Todo lo que corra en el iPad (pantalla del cliente) debe cumplir `docs/naidi/COMPATIBILIDAD_IPAD.md`.

## Secretos

No guardes llaves, tokens ni datos reales de clientes en el repositorio. Usa variables de entorno y un `.env.example` sin valores.
