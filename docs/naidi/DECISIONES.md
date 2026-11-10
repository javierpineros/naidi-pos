# Decisiones

## Tomadas

- Backend en Supabase completo (Postgres, Auth, RLS, Realtime, funciones del servidor). Sin NestJS, sin Prisma y sin `fullstack-base-template`.
- Desarrollo local con Supabase CLI y Docker Desktop; proyecto remoto `naidi-pos-dev` para desarrollo y otro aparte para producción. Sin sesiones de Claude Code en la nube.
- Flujo de venta con check-in: el cliente escanea el QR de entrada mientras le alistan el pedido; el vendedor lo elige en el POS, registra lo alistado y confirma; el cliente paga después (efectivo, datáfono Bold o transferencia); los puntos se acreditan al marcar la venta como Pagada.
- Registro de clientes en la Fase 1: Google y correo con código (sin contraseña). Apple queda para la Fase 2.
- Puntos: 1 por cada $1.000 pagados, parametrizable. Premios de 50% con umbrales propuestos de 120, 130 y 140 puntos.
- Check-in en espera: 30 minutos.
- Transferencias: se muestra el número de celular o la llave Bre-B de Naidi (parametrizable).
- Pago mixto: queda fuera de la Fase 1.
- El juego "Arma el bowl" es opcional, desactivable, sin azar y de habilidad.
- Plan de hitos aprobado por Javier (2026-11-09): H1 cimientos, H2 catálogo, H3 ventas y libro de puntos, H4 auth y check-in, H5 POS, H6 pantalla del iPad, H7 cuenta del cliente, H8 tienda web, H8b pago en línea con Bold, H9 panel del dueño, H10 endurecimiento.
- Pedidos web: máximo 2 pedidos abiertos por cuenta y, al llegar a 3 marcados "No llegó", se señala la cuenta en el panel y el dueño decide (prepago o bloqueo). Ambos valores viven en la tabla de reglas y se pueden cambiar sin tocar código.
- Pago en línea con Bold, **incluido en la Fase 1 pero apagado por defecto** (bandera `pago_en_linea_bold`; con la bandera apagada ninguna ruta de pago en línea responde). Reemplaza la decisión anterior de dejar la integración con Bold por verificar.
  - Alcance: pedidos web y también pago en tienda (por ejemplo, un link de pago para el total de una venta Confirmada).
  - Es un cobro puntual: sin cobro recurrente ni tarjetas guardadas. Quien decide qué está pagado es la base de datos, nunca la pasarela ni la redirección del navegador.
  - Diseño tomado del proyecto `our-memories` (`docs/02-suscripciones-bold.md`, `php-version/config/billing.php`, `php-version/billing/`): Botón de pagos o Link de pagos con hash de integridad `SHA-256(order_id + monto + moneda + llave_secreta)` calculado en el servidor; webhook con firma `x-bold-signature` (HMAC-SHA256 hex de `base64(cuerpo crudo)`), idempotente por id de evento, que valida monto y moneda contra la venta o el pedido; eventos `SALE_APPROVED`, `SALE_REJECTED` y `VOID_APPROVED`; reconciliación por consulta de las transacciones pendientes de más de 15 minutos.
  - Las llaves de Bold (identidad y secreta) viven solo como secretos de Supabase para Edge Functions; nunca en el navegador ni en el repo.
  - El monto lo calcula siempre el servidor; el cliente nunca lo envía. Los puntos se siguen acreditando solo con la venta Pagada (y, en pedidos web, Entregado).
  - Pruebas: simulador local de webhooks firmados (firma válida, inválida, repetido, fuera de orden, monto distinto, bandera apagada) y una prueba de punta a punta contra Bold con llaves de pruebas.
  - Javier tiene cuenta de Bold y pedirá las llaves. Javier ya probó la integración en `our-memories` y confirmó que, al configurar las llaves de pruebas, Bold pregunta si se quieren usar webhooks (es decir, el ambiente de pruebas sí admite webhooks).
- Supuestos de trabajo adoptados (ajustables desde la tabla de reglas): los cafés y el litro suman con la misma regla; los puntos no vencen en la Fase 1; el voucher de canje dura 45 días; el PIN es solo del dueño; el Excel actual no se migra y se empieza desde cero.

## Pendientes

- Confirmar con Bold si el plan de Naidi incluye la API de pagos en línea y los montos mínimos y máximos por método (preguntas ya redactadas en `our-memories/docs/02-suscripciones-bold.md` §10). Verificar en la prueba real el nombre de la cabecera de firma y el esquema del webhook en pruebas.
- Resultados de la página de diagnóstico en el iPad.
- Términos de Rappi para la tarjeta con QR en las bolsas.
- Confirmación del contador sobre la DIAN y revisión legal del juego.
- Protección de la rama `main` en GitHub (PR obligatorio): configurarla.
- Actualizar `ESPECIFICACION.md` y `PROMPT_INICIAL.md`, que todavía listan el pago en línea y la integración con Bold como fuera de alcance.
