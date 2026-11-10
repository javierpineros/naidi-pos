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
- Integración con Bold: existe, pero no se sabe si está activa en el plan vigente. En la Fase 1 el pago con datáfono se registra a mano.
- El juego "Arma el bowl" es opcional, desactivable, sin azar y de habilidad.

## Pendientes

- ¿Los cafés y el litro suman puntos con la misma regla? (propuesto: sí)
- ¿El pago de los pedidos web es en tienda al recoger?
- Vencimiento de los puntos y vigencia exacta del voucher (propuesto: 30 a 45 días).
- Resultados de la página de diagnóstico en el iPad.
- Términos de Rappi para la tarjeta con QR en las bolsas.
- Confirmación del contador sobre la DIAN y revisión legal del juego.
- Protección de la rama `main` en GitHub (PR obligatorio): configurarla.
