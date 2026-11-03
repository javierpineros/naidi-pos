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
