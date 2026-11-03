# Naidi.fit: fidelización con POS interno (especificación)

## Resumen y objetivo

Naidi.fit une, sobre Supabase, el POS interno, el programa de puntos, la pantalla del cliente en el iPad y los pedidos web, para que quien compra en la tienda se registre sin esfuerzo, vuelva y acumule hacia un premio.

Hoy casi todas las ventas son en la tienda física y el resto llega por Rappi. Las ventas se registran en un Excel y no hay backend: el catálogo y el carrito viven en el `index.html` de la página web de Naidi.

El sistema busca tres cosas: identificar al cliente sin fricción, darle un motivo concreto para volver y dejar datos de ventas limpios para decidir. La métrica de experiencia que manda es la tasa de reclamo: el porcentaje de ventas cuyos puntos terminan acreditados a un cliente.

## Las piezas del sistema

Supabase es el único punto de contacto: el POS, el iPad, la cuenta del cliente, la tienda web y el panel del dueño leen y escriben solo a través de él. Servicios de Supabase: base de datos, funciones controladas, login, tiempo real y una tarea diaria (recordatorios).

| Pieza | Quién la usa | Qué hace |
| --- | --- | --- |
| POS interno (`/pos`) | Vendedor y dueño | Muestra los clientes en espera, registra lo alistado, totaliza y registra el pago; reemplaza el Excel. Solo control interno, sin facturación |
| Pantalla del cliente (`/pantalla`) | Cliente, en el iPad | Muestra el QR de entrada y, al confirmar la venta, el total y las formas de pago |
| Cuenta del cliente (`/cuenta`) | Cliente, en su celular | Saldo, progreso hacia el premio, detalle de la compra, vouchers, historial, link de referidos y cumpleaños |
| Tienda web | Cliente | Catálogo y carrito; el pedido queda guardado en Supabase |
| Panel del dueño | Dueño | Ventas, canjes, costo de premios, reglas, banderas y auditoría |

El iPad solo lee. El cliente pasa del iPad a su cuenta escaneando el QR con su celular, y los recordatorios salen de una tarea diaria hacia correo y WhatsApp.

## Flujos principales

### Venta en tienda

1. El vendedor empieza a alistar el pedido según lo que el cliente le va indicando.
2. Mientras tanto, el cliente escanea el QR de entrada con la cámara de su celular y se registra o inicia sesión (Google o correo con código). Si es un registro nuevo, el POS emite una señal audible y resalta al cliente: tiene un regalo de bienvenida.
3. Al terminar de alistar, el vendedor abre el POS y ve la lista de clientes en espera, con nombre de pila, inicial, foto y hora de llegada. Confirma de palabra cuál es.
4. Registra los productos alistados, aplica el regalo o el premio activado si los hay, y confirma el pedido. El POS totaliza.
5. En ese momento el cliente ve en su celular el detalle y el total, con el estado "Por pagar".
6. El cliente paga en efectivo, con datáfono Bold o por transferencia. El vendedor registra el medio de pago al verificar que el pago entró.
7. Al marcar la venta como Pagada, el servidor acredita los puntos y el cliente ve "Pagado" con sus puntos nuevos.
8. El cumpleaños y el celular se piden después, con un motivo claro.

### Estados de la venta y pagos

Alistando, Confirmada (total informado, por pagar) y Pagada. Los puntos se acreditan solo al pasar a Pagada, para no dar puntos por ventas que no se cobraron.

- El vendedor puede cancelar una venta confirmada y no pagada, con un motivo. Una venta pagada solo la anula el dueño con PIN.
- Las transferencias se hacen al número de celular o a la llave Bre-B de Naidi, que el cliente ve junto al total; se verifican en la app del banco, no con capturas de pantalla.
- El cierre de caja separa efectivo, datáfono Bold y transferencia, para conciliarlos con el reporte de Bold y el extracto bancario. Una venta confirmada que sigue sin pagar al cierre se marca para que el dueño la resuelva.

### El QR de entrada

Lleva un token del punto de venta, distinto del enlace que se usa desde la web, para que la lista del vendedor solo incluya a quien escaneó en la tienda. Un enlace fijo se puede compartir, así que el control real es la confirmación verbal del vendedor. El dueño puede rotar el token desde el panel si se filtra; más adelante, un QR rotativo en el iPad lo hará caducar solo. Hay un solo check-in activo por cuenta y vence a los 30 minutos.

### Respaldos

- Si el cliente no se registró mientras le alistaban el pedido o no tiene celular, la venta se hace sin cliente y se ofrece un QR posterior a la venta (de un solo uso, vigente 30 minutos) para reclamar los puntos después.
- Si no hay internet, la venta se guarda localmente sin cliente y se sincroniza después. Nunca se bloquea la venta.

### Canje de premios

1. El cliente activa su premio desde su cuenta y se le descuentan los puntos; queda un voucher de un solo uso con vigencia de 30 a 45 días.
2. Cuando hace check-in, el POS muestra junto a su nombre que tiene un premio listo.
3. El vendedor lo aplica al armar la venta y el voucher queda consumido.

### Pedido web para recoger en tienda

1. El cliente entra con su cuenta y pide desde la web; el pedido se guarda en Supabase. WhatsApp deja de ser el canal del pedido y queda como aviso opcional y botón de contacto.
2. El POS recibe el pedido en tiempo real, con sonido, y consulta cada 20 a 30 segundos como respaldo.
3. Estados: Recibido, Preparando, Listo, Entregado, o No llegó.
4. Como el bowl se derrite, el cliente elige una ventana de recogida y toca "Voy en camino" para que se arme a tiempo.
5. Se reclama con un QR y un código corto de 4 caracteres; el vendedor verifica nombre y contenido y marca "Entregado" una sola vez.
6. Los puntos y el topping extra se acreditan solo cuando el pedido está pagado y marcado como "Entregado".
7. Contra pedidos falsos: login obligatorio, máximo uno o dos pedidos abiertos por cuenta y un contador de "no llegó" que exige prepago o bloquea tras varios casos.

### Otros canales

- **Recordatorios de regreso:** solo a clientes registrados y con consentimiento, por correo o WhatsApp. Una tarea diaria aplica reglas (sin comprar hace X días y con saldo, premio por vencer, cumpleaños), con tope de un mensaje de marketing cada 14 días y opción de darse de baja.
- **Referidos:** el premio llega al invitador y al invitado cuando el invitado hace su primera compra pagada, con tope mensual.
- **Reseñas de Google Maps:** se invita a todos por igual, sin puntos ni premios, porque Google lo prohíbe.
- **Redes sociales:** puntos por mencionar o etiquetar a @naidibowl, validados por el vendedor o un revisor y con tope mensual. Los likes no se pueden verificar, así que se descartan.
- **Rappi:** no entrega datos de esos clientes. La vía es una tarjeta con QR en la bolsa que invite a registrarse en Naidi.fit, sujeta a los términos de Rappi.

## Reglas de puntos

Cada bowl suma 1 punto por cada $1.000 pagados y los premios cuestan cerca del 7% de lo que el cliente gastó. Los puntos se acreditan cuando la venta pasa a Pagada. Todos los valores son propuestas editables.

| Concepto | Valor propuesto |
| --- | --- |
| Puntos por compra | 1 por cada $1.000 pagados (Mini 7, Pequeño 16, Mediano 18, Grande 19) |
| Premio: 50% en bowl Pequeño | 120 pts (≈ $8.150 de costo) |
| Premio: 50% en bowl Mediano | 130 pts (≈ $9.100 de costo) |
| Premio: 50% en bowl Grande | 140 pts (≈ $9.950 de costo) |
| Costo para Naidi | ≈ 7% de lo gastado (≈ $70 por punto) |
| Vigencia del check-in y del QR posterior a la venta | 30 minutos |
| Vigencia del voucher de canje | 30 a 45 días |
| Vencimiento de puntos | Por definir (por ejemplo, 6 a 12 meses sin actividad) |

Los umbrales por tamaño hacen que el costo sea parejo. El Mini no entra en el premio.

Todo vive en una tabla de configuración versionada con fecha de vigencia: premios, umbrales, categorías que suman (bowls, cafés, litro), vigencias, topes y banderas. Cada movimiento de puntos guarda con qué versión de la regla se calculó. Los puntos se calculan sobre el precio realmente pagado, no sobre el "precio anterior" tachado de la web.

## Juego "Arma el bowl" (opcional)

Una opción que el dueño enciende o apaga: premia con puntos extra según el desempeño, nunca según la suerte. El prototipo está en `docs/naidi/anexos/naidi-arma-el-bowl.html`.

- **Mecánica:** llega un pedido (base y de 3 a 6 toppings) y hay 25 segundos para armarlo igual. Cada error quita 2 segundos; cada nivel suma un topping y resta 3 segundos, hasta un mínimo de 14.
- **Premio:** de 1 a 3 estrellas y un bono máximo del 15% de los puntos de la compra (parametrizable, mínimo 1 punto).
- **Control:** una partida por venta pagada, ligada a esa venta. La semilla del pedido, el tiempo mínimo y el bono los valida el servidor.
- **Desactivación:** una bandera en la configuración, programable por fechas. Al apagarla se anulan las partidas pendientes. Además hay un tope diario de puntos de bono que apaga el juego si se alcanza.
- **Dónde se juega:** por defecto en el celular del cliente cuando la venta queda pagada; en el iPad solo si no hay fila.
- **Arte:** los emojis del prototipo se reemplazan por ilustraciones de los toppings en el estilo de la marca.

**Consideración legal.** En Colombia, los juegos de suerte y azar con premios para promocionar un negocio requieren autorización de Coljuegos o de la autoridad territorial competente. Por eso el diseño es de habilidad y no usa azar ni rankings con premios. Un abogado debe revisar el diseño antes de lanzarlo.

## Seguridad y privacidad

- **Identificación:** Google y correo con código (sin contraseña) para clientes; Apple como complemento posterior. Cuentas individuales para el personal, nunca compartidas.
- **Control de acceso:** tres roles (cliente, cajero, dueño) guardados en el servidor, donde el usuario no puede editarlos. Permisos activados y denegados por defecto en todas las tablas; la escritura solo pasa por funciones controladas. La llave `service_role` nunca va en el navegador.
- **POS:** `/pos` exige iniciar sesión y los permisos se verifican en el servidor. El cajero vende y consulta; anular ventas pagadas, hacer descuentos manuales y cambiar reglas son del dueño.
- **Dueño:** verificación en dos pasos y un PIN para acciones sensibles. El PIN es del personal, se guarda cifrado y tiene límite de intentos.
- **Puntos:** libro de movimientos inmutable. Se acreditan solo cuando la venta pasa a Pagada y las anulaciones revierten con un movimiento contrario. El QR posterior a la venta es aleatorio, de un solo uso, vigente 30 minutos y solo existe con la venta cobrada.
- **Check-in:** el QR de entrada lleva un token del punto de venta que el dueño puede rotar. Un solo check-in activo por cuenta, con vencimiento a los 30 minutos. El POS muestra solo nombre de pila e inicial y la señal audible tiene límite de frecuencia.
- **Control interno:** como el vendedor digita la venta, el cliente ve el detalle y el total en su celular y puede reportar "esto no es lo que pedí". Reasignar un cliente o anular una venta pagada requiere el PIN del dueño. El panel alerta por clientes con muchas compras al día.
- **Regalo de bienvenida:** una vez por cuenta, junto con la primera venta confirmada.
- **Pagos:** las transferencias se verifican en la app del banco. El cierre de caja separa efectivo, datáfono Bold y transferencia.
- **Antifraude:** topes de reclamos por cliente y por día, límite de intentos en códigos cortos y alertas en el panel.
- **iPad:** dispositivo de solo lectura con llave revocable, sin sesión del personal, mostrando solo el nombre de pila.
- **Datos personales:** consentimiento explícito para el tratamiento de datos y para los mensajes (Ley 1581), política de privacidad y recolección mínima por etapas.
- **Auditoría y respaldo:** registro de anulaciones, descuentos, reasignaciones y cambios de reglas, y copias de seguridad de la base.
- **Antes de lanzar:** probar los permisos intentando, desde cada rol, hacer lo que no deberían poder.

## Tecnología y compatibilidad

- **Backend:** Supabase (Postgres, login, permisos por fila, tiempo real y funciones del servidor).
- **POS:** responsive para celular y PC, con modo sin internet: las ventas se guardan localmente y se sincronizan después.
- **Pantalla del cliente:** página aparte, de solo lectura, para el iPad mini 2 con iOS 12.5.8. Ver `COMPATIBILIDAD_IPAD.md`.

## Fases

1. **Fase 0, reglas del juego.** Cerrar puntos, umbrales, vencimiento, topes y textos legales de datos personales, y correr la prueba en el iPad real. No requiere programar.
2. **Fase 1, núcleo.** Registro con Google y correo con código, check-in con QR de entrada, venta con registro de pago, puntos, canje con voucher, cuenta del cliente, POS interno, pantalla del iPad, panel del dueño y pedidos web con topping extra.
3. **Fase 2, crecimiento.** Inicio de sesión con Apple, referidos, recordatorios por correo y WhatsApp, invitación a reseñar en Google Maps, tarjeta en Wallet, tarjetas con QR para las bolsas de Rappi y el juego Arma el bowl.
4. **Fase 3, profundización.** Puntos por menciones en redes, niveles, retos y cruce con los datos de Instagram.

Desde la Fase 1 quedan creadas las tablas y reglas que necesitan las fases siguientes (sesiones de juego, bono máximo, topes, banderas), para no rehacer nada después.

## Fuera de alcance

- Facturación electrónica: un POS interno no sustituye lo que exige la DIAN a los negocios obligados. El contador debe confirmar si Naidi lo está.
- Inventario, propinas, multi-sucursal, pago en línea, pago mixto e integración automática con Bold.
- Juegos con azar, rankings con premios, notificaciones push web y domicilios (los pedidos web son solo para recoger).
