-- H3 (3/3): reglas nuevas. Propuestas editables; ver docs/naidi/DECISIONES.md.

insert into public.reglas_negocio (clave, version, valor, descripcion, publica) values
  ('bienvenida.regalo', 1, '{"descuento_pct":20,"tamanos":["mini","pequeno","mediano","grande"]}'::jsonb,
     'PROVISIONAL, por confirmar con Javier: el regalo de bienvenida es un descuento sobre un bowl de la primera compra. Una vez por cuenta.', true),
  ('antifraude.max_reclamos_qr_dia', 1, '5'::jsonb,
     'Máximo de QR posteriores a la venta que un cliente puede reclamar por día (hora de Bogotá).', false);
