# Paquete de inicio: Naidi.fit POS + Fidelización

Todo vive en `docs/naidi/`. Se conecta con una sola línea en el `CLAUDE.md` del repositorio: `@docs/naidi/CLAUDE_NAIDI.md`. El proyecto es independiente: usa Supabase completo y se trabaja en local.

## Contenido

| Archivo | Para qué sirve |
| --- | --- |
| `CLAUDE_NAIDI.md` | Contexto y reglas del proyecto. Se importa desde el `CLAUDE.md` del repo |
| `PROMPT_INICIAL.md` | Prompt que Claude Code lee al empezar. Pide primero un plan, no código |
| `ESPECIFICACION.md` | Especificación completa del sistema |
| `DECISIONES.md` | Decisiones tomadas y pendientes |
| `COMPATIBILIDAD_IPAD.md` | Reglas de código para el iPad mini 2 (Safari 12) |
| `anexos/prueba-ipad.html` | Página de diagnóstico para abrir en el iPad (subir al dominio del sitio) |
| `anexos/naidi-arma-el-bowl.html` | Prototipo jugable del juego (referencia, no es código de producción) |

## Requisitos locales (Windows)

- Node, pnpm y git.
- Docker Desktop con el motor WSL2 activo (`docker info` debe responder).
- Supabase CLI (`scoop install supabase` o `scoop update supabase`).

## Cómo empezar

1. Clona o abre el repositorio `https://github.com/javierpineros/naidi-pos`.
2. Inicia Docker Desktop y espera a "Engine running".
3. Desde la raíz del repo: `supabase start`. Imprime la URL y las claves locales; la URL y la `anon key` van en `.env.local` (ver `.env.example`).
4. Crea en supabase.com el proyecto de desarrollo `naidi-pos-dev` (separado del de producción) y enlázalo con `supabase link --project-ref <ref>`.
5. Abre una sesión local de Claude Code en la raíz del repo y pega: `Lee docs/naidi/PROMPT_INICIAL.md y sigue sus instrucciones. Entrega primero solo el plan.`
6. Revisa el plan antes de aprobar código. Una rama y un PR por hito; nada se fusiona a `main` sin tu aprobación.

## Lo que no se pudo verificar

- Los resultados de `prueba-ipad.html` en el iPad real.
- Que el cliente `supabase-js` y el bundler elegidos generen código compatible con Safari 12.
