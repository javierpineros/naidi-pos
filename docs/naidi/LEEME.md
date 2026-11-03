# Paquete de inicio: Naidi.fit POS + Fidelización

Todo vive en `docs/naidi/` y no reemplaza nada del template `fulltack-base-template`. Se conecta con una sola línea en el `CLAUDE.md` del repositorio: `@docs/naidi/CLAUDE_NAIDI.md`.

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

## Cómo empezar

1. Ten el repositorio creado desde `fulltack-base-template` en GitHub (privado). Las sesiones en la nube trabajan sobre un repositorio que ya exista.
2. Ejecuta `instalar-paquete-naidi.ps1` (viene junto a esta carpeta en el zip). Copia estos archivos a `C:\ai\projects\naidi\docs\naidi\`, agrega la línea de importación al `CLAUDE.md`, crea una rama y hace el commit. No toca la rama principal.
3. Sube la rama y abre el PR siguiendo las reglas de revisión del template.
4. Crea un proyecto de Supabase de desarrollo, separado del de producción.
5. Configura el entorno en la nube (claude.ai/code):
   - **Acceso a la red:** "Trusted" por defecto. Si la sesión debe llegar a Supabase, usa acceso personalizado y agrega `*.supabase.co`. Verifica en el panel qué trae la lista por defecto.
   - **Variables de entorno:** solo valores de desarrollo. Nunca la llave `service_role` de producción.
   - **Script de configuración:** instala las dependencias del template; el resultado se guarda en caché.
6. Abre una sesión nueva en el repositorio y pega: `Lee docs/naidi/PROMPT_INICIAL.md y sigue sus instrucciones. Entrega primero solo el plan.`
7. Revisa el plan antes de aprobar código, y cada PR con las reglas del template.

## Lo que no se pudo verificar

- Las reglas de revisión y aprobación de `fulltack-base-template`: no se tuvo acceso al repositorio. El prompt obliga a leerlas y respetarlas, pero no las reproduce.
- Que el dominio de Supabase esté en la lista de red por defecto del entorno en la nube.
- Los resultados de `prueba-ipad.html` en el iPad real.
