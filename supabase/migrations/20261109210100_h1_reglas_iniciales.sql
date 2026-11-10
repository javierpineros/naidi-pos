-- H1: valores iniciales de reglas y banderas (propuestas editables; ver docs/naidi/DECISIONES.md).
-- Son datos de configuración, no datos de clientes: van en migración para que existan en todos los entornos.

insert into public.reglas_negocio (clave, version, valor, descripcion, publica) values
  ('puntos.cop_por_punto',          1, '1000'::jsonb,
     '1 punto por cada $1.000 pagados, sobre el precio realmente pagado.', true),
  ('puntos.categorias_que_suman',   1, '["bowls","cafes","litro"]'::jsonb,
     'Categorías que suman puntos (cafés y litro por confirmar).', true),
  ('puntos.vencimiento_meses',      1, 'null'::jsonb,
     'Meses sin actividad para que venzan los puntos; null = no vencen (Fase 1).', true),
  ('premio.descuento_pct',          1, '50'::jsonb,
     'Descuento del premio sobre el bowl.', true),
  ('premio.umbrales_puntos',        1, '{"pequeno":120,"mediano":130,"grande":140}'::jsonb,
     'Puntos para canjear el premio por tamaño de bowl. El Mini no entra.', true),
  ('voucher.vigencia_dias',         1, '45'::jsonb,
     'Vigencia del voucher de canje, en días.', true),
  ('checkin.vigencia_min',          1, '30'::jsonb,
     'Minutos que dura un check-in en espera.', false),
  ('qr_posventa.vigencia_min',      1, '30'::jsonb,
     'Minutos de vigencia del QR posterior a la venta.', false),
  ('pedidos_web.max_abiertos',      1, '2'::jsonb,
     'Máximo de pedidos web abiertos por cuenta.', false),
  ('pedidos_web.no_llego_alerta',   1, '3'::jsonb,
     'Con este número de "No llegó" se señala la cuenta en el panel y el dueño decide (prepago o bloqueo).', false),
  ('transferencia.destino',         1, '{"tipo":"bre-b","valor":""}'::jsonb,
     'Número de celular o llave Bre-B que se muestra junto al total. Se completa desde el panel.', true);

insert into public.banderas (clave, activa, descripcion) values
  ('pago_en_linea_bold',    false, 'Pago en línea con Bold (pedidos web y pago en tienda). Apagada por defecto.'),
  ('login_apple',           false, 'Fase 2: inicio de sesión con Apple.'),
  ('referidos',             false, 'Fase 2: programa de referidos.'),
  ('recordatorios',         false, 'Fase 2: recordatorios por correo y WhatsApp.'),
  ('resenas_google',        false, 'Fase 2: invitación a reseñar en Google Maps (sin recompensa).'),
  ('wallet',                false, 'Fase 2: tarjeta en Wallet.'),
  ('tarjetas_rappi',        false, 'Fase 2: tarjetas con QR para las bolsas de Rappi.'),
  ('menciones_sociales',    false, 'Fase 3: puntos por menciones en redes.'),
  ('juego_arma_el_bowl',    false, 'Fase 2: juego "Arma el bowl" (de habilidad, sin azar).');
