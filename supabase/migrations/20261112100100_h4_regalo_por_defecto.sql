-- Regalo de bienvenida por defecto, decidido por Javier: 1 topping gratis en la primera compra.
-- (Versión nueva de la regla; la anterior, 20% de la compra, se cierra.) La cantidad o el tipo los cambia el dueño desde el panel.
update public.reglas_negocio set vigente_hasta = now() where clave = 'bienvenida.regalo' and vigente_hasta is null;
insert into public.reglas_negocio (clave, version, valor, descripcion, publica, vigente_desde) values
  ('bienvenida.regalo', 3, '{"tipo":"toppings_gratis","cantidad":1,"toppings":null}'::jsonb,
   'Regalo de bienvenida (una vez por cuenta): {"tipo":"toppings_gratis","cantidad":N,"toppings":null|[claves]}, {"tipo":"descuento_compra","descuento_pct":N} o {"tipo":"descuento_linea","descuento_pct":N,"tamanos":[...]}.',
   true, now());
