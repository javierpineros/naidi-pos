# Prompt inicial para Claude Code

Construye "Naidi.fit POS + Fidelización", un sistema para la heladería Naidi (bowls de açaí y copoazú) en Bogotá que reemplaza el Excel de ventas, identifica al cliente mientras le alistan el pedido y le da puntos canjeables por premios.

## PRIMERO: reglas del repositorio

Este repositorio es independiente (no usa ninguna plantilla). Antes de planear nada:

1. Lee el `CLAUDE.md` del repositorio y `docs/naidi/CLAUDE_NAIDI.md`. Resúmeme en pocas líneas las reglas que encontraste.
2. Si algo de este documento contradice esas reglas, dímelo y no lo resuelvas por tu cuenta.
3. Una rama y un PR por hito. No hagas merge ni empujes a la rama principal; espera mi revisión.
4. Diagnóstico antes de cambiar. Valida la sintaxis después de cada edición. Escribe pruebas de integración con jsdom para los flujos del front.
5. Agrupa tus preguntas aclaratorias y hazlas antes de empezar a programar.
6. Trabaja contra el Supabase local (`supabase start`, Docker Desktop): escribe las migraciones en `supabase/migrations/` y pruébalas con `supabase db reset`. Las variables del front son `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` (ver `.env.example`). No pidas ni guardes llaves de producción ni datos reales de clientes.

Lee también `docs/naidi/CLAUDE_NAIDI.md`, `docs/naidi/ESPECIFICACION.md`, `docs/naidi/DECISIONES.md` y `docs/naidi/COMPATIBILIDAD_IPAD.md`.

## Contexto

- Casi todas las ventas son en la tienda física; el resto llega por Rappi. Hoy se registran en un Excel.
- No hay backend. El catálogo y el carrito viven en `referencia/index.html` (copia del catálogo actual de Naidi: sitio estático, JavaScript sin framework). Extrae de ahí sabores, tamaños (Mini, Pequeño, Mediano, Grande), toppings y precios.
- Backend nuevo: Supabase (Postgres, Auth, Row Level Security, Realtime, funciones del servidor, tareas programadas).
- El POS es solo de control interno: sin facturación electrónica.
- Todo el texto visible va en español colombiano, con tuteo.

## Dispositivos y compatibilidad (obligatorio)

- Vendedor: celular o PC modernos. El POS es responsive.
- Cliente: su propio celular con navegador moderno, sin instalar nada.
- Pantalla del cliente: iPad mini 2 con iOS 12.5.8 (Safari 12) en el mostrador. Todo lo que corra ahí debe cumplir `docs/naidi/COMPATIBILIDAD_IPAD.md`.
- No des por buena ninguna pantalla del iPad sin revisarla contra los resultados de `docs/naidi/anexos/prueba-ipad.html`, que te entregaré.

## Flujo de venta en tienda (check-in)

1. El vendedor empieza a alistar el pedido según lo que el cliente le va indicando.
2. Mientras tanto, el cliente escanea el QR de entrada con la cámara de su celular y se registra o inicia sesión. Fase 1: Google y correo con código (sin contraseña). Deja la autenticación lista para sumar Apple después. Si el registro es nuevo, el POS emite una señal audible y resalta al cliente: tiene un regalo de bienvenida.
3. Al terminar de alistar, el vendedor abre el POS y ve la lista de clientes en espera (nombre de pila, inicial, foto y hora de llegada, ordenados por llegada). Confirma de palabra cuál es.
4. Registra los productos alistados, aplica el regalo o el premio activado si los hay, y confirma el pedido. El POS totaliza.
5. En ese momento, en tiempo real, el cliente ve en su celular el detalle y el total con el estado "Por pagar". La pantalla del iPad muestra el total y las formas de pago.
6. El cliente paga en efectivo, con datáfono Bold o por transferencia. El vendedor registra el medio de pago al verificar que el pago entró (las transferencias van al número de celular o a la llave Bre-B de Naidi, que se muestra junto al total y es parametrizable; se verifican en la app del banco, no con capturas de pantalla).
7. Al marcar la venta como Pagada, el servidor acredita los puntos y el cliente ve "Pagado" con sus puntos nuevos.

## Reglas del check-in

- El QR de entrada lleva un token del punto de venta, distinto del enlace que se usa desde la web, para que la lista del POS solo incluya a quien escaneó en la tienda. El dueño puede rotar ese token desde el panel. Deja el diseño listo para pasar después a un QR rotativo mostrado en el iPad.
- Un solo check-in activo por cuenta. Vence a los 30 minutos (parametrizable) y el vendedor puede marcar "ya se fue".
- El POS muestra solo nombre de pila e inicial. La señal audible tiene límite de frecuencia y siempre va acompañada de una alerta visual que queda marcada en la lista. Incluye un botón "Activar sonido" al abrir el turno, porque los navegadores bloquean el audio hasta que el usuario interactúa.
- Si un cliente tiene un pedido web listo, la lista lo muestra para unir ambos orígenes.

## Respaldos (la venta nunca se bloquea)

- Si el cliente no hizo check-in o no tiene celular, la venta se hace sin cliente y se ofrece un QR posterior a la venta (token aleatorio de al menos 128 bits, de un solo uso, vigente 30 minutos, que solo existe con la venta pagada) para reclamar los puntos después. El servidor calcula los puntos; el celular nunca envía cuántos le tocan.
- Si no hay internet, el POS guarda la venta localmente sin cliente y sincroniza después.

## Módulos de la Fase 1

1. **POS (`/pos`):** lista de clientes en espera, registro de lo alistado, regalo o premio, confirmación y total, registro del medio de pago (efectivo con cálculo de cambio, datáfono Bold, transferencia). Estados de venta: Alistando, Confirmada, Pagada. El vendedor puede cancelar una venta confirmada y no pagada con un motivo; una pagada solo la anula el dueño con PIN. Atajos de productos y "repetir lo de la última vez" por cliente. Reportes: cierre de caja diario separado por medio de pago (para conciliar con el reporte de Bold y el extracto bancario), ventas por sabor, tamaño y hora, canjes y costo de premios. Las ventas confirmadas que siguen sin pagar al cierre se marcan para el dueño.
2. **Pantalla del cliente (`/pantalla`):** página aparte, de solo lectura, para el iPad. Muestra el QR de entrada y, al confirmar la venta, el total y las formas de pago. Se conecta con una llave de dispositivo revocable, sin sesión del personal, y consulta cada 2 o 3 segundos (el tiempo real es solo respaldo en este equipo).
3. **Cuenta del cliente (`/cuenta`):** saldo, barra de progreso hacia el premio, detalle y total de la compra en curso con botón "esto no es lo que pedí", premios con vigencia, historial, cumpleaños y celular opcionales (se piden después, con motivo claro).
4. **Fidelización:** ver reglas abajo.
5. **Tienda web:** el carrito guarda el pedido en Supabase antes de cualquier aviso. Solo para recoger en tienda, con login, ventana de recogida y botón "Voy en camino". Estados: Recibido, Preparando, Listo, Entregado, No llegó. Se reclama con QR y código corto de 4 caracteres. El POS recibe el pedido en tiempo real con sonido y consulta cada 20 a 30 segundos como respaldo.
6. **Panel del dueño:** ventas, canjes, costo de premios, reglas, banderas, rotación del token del QR de entrada y registro de auditoría.

## Reglas de negocio (todas parametrizables en una tabla versionada con fecha de vigencia)

- **Puntos:** 1 por cada $1.000 pagados, calculados sobre el precio realmente pagado (no sobre el precio anterior tachado de la web). Se acreditan solo cuando la venta pasa a Pagada. Categorías que suman: bowls; cafés y litro por confirmar.
- **Premio:** 50% en un bowl Pequeño, Mediano o Grande, con umbrales propuestos de 120, 130 y 140 puntos. El Mini no entra en el premio.
- **Canje:** el cliente activa el premio desde su cuenta, se descuentan los puntos y queda un voucher de un solo uso con vigencia de 30 a 45 días. En el check-in, el POS muestra que tiene un premio listo y el vendedor lo aplica al armar la venta.
- **Regalo de bienvenida:** una vez por cuenta, junto con la primera venta confirmada.
- **Libro de puntos inmutable:** cada movimiento (suma, canje, anulación, bono) es una fila nueva con la versión de regla usada. Una restricción única garantiza una sola suma por venta, aun con reclamos simultáneos. El saldo se calcula desde el libro.
- **Pedido web:** los puntos y el topping extra se acreditan solo cuando el pedido está pagado y marcado como Entregado. Máximo uno o dos pedidos abiertos por cuenta; contador de "no llegó" que exija prepago o bloquee tras varios casos.
- **Anulaciones:** invalidan el QR posterior y, si ya se acreditaron puntos, los revierten con un movimiento contrario.

## Seguridad (obligatorio)

- Roles cliente, cajero y dueño guardados en el servidor, que el usuario no pueda editar. Row Level Security activado y con denegación por defecto en todas las tablas; los clientes no leen ni escriben directamente ventas, tokens ni puntos: todo pasa por funciones del servidor con `search_path` fijo. La llave `service_role` nunca llega al navegador.
- Cuentas individuales para el personal, nunca compartidas. Dueño con verificación en dos pasos y un PIN para acciones sensibles (anular ventas pagadas, reasignar un cliente, descuentos manuales, cambiar reglas); el PIN va cifrado y con límite de intentos.
- Control interno: como el vendedor digita la venta, el cliente ve el detalle y el total en su celular y puede reportar un error. El panel alerta por clientes con muchas compras al día.
- Antifraude: topes de reclamos por cliente y por día, límite de intentos en códigos cortos y alertas en el panel.
- Datos personales: consentimiento explícito para el tratamiento de datos y para mensajes (Ley 1581), recolección mínima por etapas, política de privacidad.
- Registro de auditoría de anulaciones, descuentos, reasignaciones y cambios de reglas.

## Prepara sin activar (Fases 2 y 3)

Crea las tablas y banderas necesarias, pero no construyas las funciones: inicio de sesión con Apple, referidos, recordatorios por correo y WhatsApp, invitación a reseñar en Google Maps (sin recompensa), tarjeta en Wallet, tarjetas con QR para Rappi, puntos por menciones en redes, y el juego "Arma el bowl" (sesiones de juego, bono máximo, tope diario, bandera de activación).

## Fuera de alcance

Facturación electrónica, inventario, propinas, multi-sucursal, pago en línea, pago mixto, integración automática con Bold (por verificar con el plan vigente), domicilios, juegos con azar y notificaciones push web.

## Forma de trabajo y entregables

1. Primero entrega solo un plan: arquitectura, modelo de datos (tablas, relaciones, políticas RLS por rol), máquina de estados de la venta y lista de hitos. Espera mi aprobación antes de escribir código.
2. Antes de asumir, hazme las preguntas abiertas que sigan pendientes en `docs/naidi/DECISIONES.md`.
3. Luego implementa por hitos, con una rama y un PR por hito: migraciones SQL con RLS, funciones del servidor, importador del catálogo desde `index.html`, POS, pantalla del cliente, cuenta del cliente, tienda web y panel.
4. Pruebas obligatorias: libro de puntos (suma al pasar a Pagada, canje, anulación), un solo check-in activo por cuenta y vencimiento, token del QR posterior de un solo uso con reclamos simultáneos, permisos por rol intentando lo que cada rol no debe poder, venta sin cliente con y sin internet, sincronización sin internet del POS, y que la pantalla del iPad funciona sin las propiedades de CSS y JavaScript no soportadas por Safari 12.
5. Al cerrar cada hito, muestra las pruebas pasando y lista lo que quede pendiente o con riesgo.
