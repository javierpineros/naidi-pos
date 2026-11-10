# Compatibilidad con el iPad mini 2 (iOS 12.5.8, Safari 12)

Aplica a la pantalla del cliente (`/pantalla`) y a cualquier código que corra en ese equipo. Safari 12 es el motor de todos los navegadores en ese iPad: instalar Chrome no cambia nada.

## Evitar

- `aspect-ratio`, `inset` y `gap` en flexbox. Usa alto fijo, `top/right/bottom/left` y márgenes.
- `mask-image` sin prefijo. Usa `-webkit-mask-image`.
- Sintaxis `?.` y `??` sin compilar. Compila para Safari 12 (en Vite, `build.target: 'safari12'`).
- WebP como único formato.
- Emojis recientes (kiwi, coco, maní, mango, arándanos). Usa ilustraciones propias.
- Notificaciones push web.
- `position: sticky` sin el prefijo `-webkit-sticky`.

## Hacer

- Imágenes con `<picture>`: WebP y un JPG liviano de respaldo (miniaturas de unos 480 px, zooms de unos 1000 px), sin depender de JavaScript ni de `onerror`.
- Aplicar el `border-radius` directamente a la `<img>` y sin transición del radio.
- Consultar el estado cada 2 o 3 segundos; el tiempo real por WebSocket es solo respaldo.
- Verificar cada pantalla del iPad con `anexos/prueba-ipad.html` y registrar los resultados.

## Hipótesis por confirmar con la página de diagnóstico

- Sin WebP, el sitio actual carga los originales de `images/ant/...` (24 archivos, probablemente muy pesados): sospecha principal de que no todas las fotos carguen.
- Las esquinas cuadradas vienen probablemente de combinar `border-radius`, `overflow:hidden` y una transición del radio.

## Resultados de `prueba-ipad.html` en el iPad real (2026-11-10)

iPad mini 2, iOS 12.5.8, Safari 12.1.2 (`Version/12.1.2`), abierto desde `https://naidi.fit`.

| Prueba | Resultado | Qué hace la pantalla |
| --- | --- | --- |
| CSS Grid, `object-fit` | Funcionan | Se pueden usar |
| `gap` en flexbox, `inset`, `aspect-ratio` | Fallan | No se usan (márgenes, `top/right/bottom/left`, alto fijo) |
| `mask-image`, `position: sticky`, `backdrop-filter` | Solo con prefijo `-webkit-` | No se usan; si hicieran falta, con prefijo |
| `clamp()` | Falla | No se usa |
| Variables CSS | "Falla" en la prueba | Probable falso negativo (`CSS.supports('(--a:0)')`); la pantalla no usa `var()` por precaución |
| `?.` y `??` | Fallan | `build.target: 'safari12'` y una prueba que revisa el JS construido |
| `fetch`, `Promise`, `async/await`, `WebSocket`, `AbortController`, `Object.fromEntries`, `Array.flat`, IndexedDB, `localStorage` | Funcionan | Se pueden usar |
| `ResizeObserver`, portapapeles, notificaciones web | Fallan | No se usan |
| WebP | No soporta | La pantalla no usa fotos; el logo es PNG |
| `<picture>` con respaldo | Elige el PNG sin JavaScript | Funciona |
| Esquinas A, B y C | Redondas | `border-radius` directo, sin problema |
| Emoji de arándanos | Falta | No se usan emojis recientes |
| Supabase HTTPS (298 ms) y WebSocket (509 ms) | Funcionan | La consulta cada 2,5 s es viable |
| Memoria: 11 imágenes de 1600×1200 | 11 de 11 | Sin riesgo para esta pantalla |
| Imágenes del sitio `images/ant` | 20 de 24 cargaron (41,3 MB); 4 dan 404: `Cacao.png`, `Manaos.png`, `frutal.jpg`, `tucano.jpg` | Es del sitio web actual, no de la pantalla: faltan sus respaldos JPG/PNG |

La prueba automática `tests/pantalla.safari12.test.js` construye el proyecto y revisa lo que el iPad descarga (sintaxis, APIs y CSS) contra esta tabla.

## Activar la pantalla en el iPad

1. El dueño emite una llave desde el panel (`emitir_llave_dispositivo`, con PIN) y la copia: se muestra una sola vez.
2. En el iPad, abre `https://<dominio>/pantalla/#llave=<llave>`. La llave se guarda y desaparece de la barra de direcciones.
3. Ajustes > Pantalla y brillo > Bloqueo automático > Nunca, y deja Safari abierto en la pantalla (o usa Acceso guiado).
4. Si se pierde el iPad, el dueño revoca la llave: la pantalla se apaga en la siguiente consulta.
