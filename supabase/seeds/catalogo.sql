-- GENERADO por scripts/generar-catalogo.js a partir de referencia/index.html. No lo edites a mano:
-- corrige la fuente y vuelve a correr `pnpm catalogo:generar`. Es idempotente (se puede aplicar varias veces).
insert into public.categorias (clave, nombre, orden) values
  ('bowls', 'Bowls y smoothies', 1),
  ('cafes', 'Cafés', 2),
  ('litro', 'Litro', 3)
on conflict (clave) do update set nombre = excluded.nombre, orden = excluded.orden;

insert into public.tamanos (clave, nombre, precio_cop, toppings_incluidos, orden) values
  ('mini', 'Mini', 7000, 3, 1),
  ('pequeno', 'Pequeño', 16300, 5, 2),
  ('mediano', 'Mediano', 18200, 5, 3),
  ('grande', 'Grande', 19900, 5, 4)
on conflict (clave) do update set nombre = excluded.nombre, precio_cop = excluded.precio_cop, toppings_incluidos = excluded.toppings_incluidos, orden = excluded.orden, activo = true, updated_at = now();

update public.tamanos set activo = false, updated_at = now() where activo and clave not in ('mini', 'pequeno', 'mediano', 'grande');

insert into public.presentaciones (clave, nombre, orden) values
  ('bowl', 'Bowl', 1),
  ('smoothie', 'Smoothie', 2)
on conflict (clave) do update set nombre = excluded.nombre, orden = excluded.orden;

insert into public.bases (clave, nombre, orden) values
  ('banano', 'Açaí banano', 1),
  ('fresa', 'Açaí fresa', 2),
  ('mango', 'Açaí mango', 3),
  ('copoazu', 'Copoazú', 4),
  ('acai-copoazu', 'Açaí copoazú', 5)
on conflict (clave) do update set nombre = excluded.nombre, orden = excluded.orden, activo = true, updated_at = now();

update public.bases set activo = false, updated_at = now() where activo and clave not in ('banano', 'fresa', 'mango', 'copoazu', 'acai-copoazu');

insert into public.toppings (clave, nombre, precio_cop, orden) values
  ('banano', 'Banano', 1000, 1),
  ('fresa', 'Fresa', 1000, 2),
  ('mango', 'Mango', 1000, 3),
  ('arandanos', 'Arándanos', 2000, 4),
  ('kiwi', 'Kiwi', 1500, 5),
  ('granola-frutos-rojos', 'Granola frutos rojos', 1000, 6),
  ('granola-fit', 'Granola Fit', 1000, 7),
  ('avena', 'Avena', 1000, 8),
  ('chia', 'Chía', 1500, 9),
  ('mantequilla-mani', 'Mantequilla maní', 1500, 10),
  ('mantequilla-avellanas', 'Mantequilla avellanas', 1500, 11),
  ('miel', 'Miel', 1500, 12),
  ('leche-condensada', 'Leche condensada', 1000, 13),
  ('leche-polvo', 'Leche en polvo', 1000, 14),
  ('hojuelas-maiz', 'Hojuelas de maíz', 1000, 15),
  ('coco-sin-azucar', 'Coco sin azúcar', 1500, 16),
  ('almendra-laminada', 'Almendra laminada', 1500, 17),
  ('galletas-oreo', 'Galletas oreo', 1000, 18),
  ('yogurt-griego', 'Yogurt griego', 1500, 19),
  ('chips-chocolate', 'Chips de chocolate', 1500, 20),
  ('quinua-pop', 'Quinua pop', 1000, 21),
  ('quinua-pop-chocolate', 'Quinua pop chocolate', 1000, 22),
  ('biscoff-creamy', 'Biscoff creamy', 2500, 23),
  ('biscoff-crunchy', 'Biscoff crunchy', 2500, 24)
on conflict (clave) do update set nombre = excluded.nombre, precio_cop = excluded.precio_cop, orden = excluded.orden, activo = true, updated_at = now();

update public.toppings set activo = false, updated_at = now() where activo and clave not in ('banano', 'fresa', 'mango', 'arandanos', 'kiwi', 'granola-frutos-rojos', 'granola-fit', 'avena', 'chia', 'mantequilla-mani', 'mantequilla-avellanas', 'miel', 'leche-condensada', 'leche-polvo', 'hojuelas-maiz', 'coco-sin-azucar', 'almendra-laminada', 'galletas-oreo', 'yogurt-griego', 'chips-chocolate', 'quinua-pop', 'quinua-pop-chocolate', 'biscoff-creamy', 'biscoff-crunchy');

insert into public.productos (clave, categoria, tipo, nombre, descripcion, sabor, usa_tamanos, precio_fijo_cop, foto, orden) values
  ('amazonas', 'bowls', 'menu', 'Amazonas', 'Açaí, mango, banano, granola frutos rojos, leche en polvo y leche condensada.', 'Açaí mango', true, null, 'amazonas', 1),
  ('carioca', 'bowls', 'menu', 'Carioca', 'Açaí, Mango, banano, fresa, hojuelas de maíz, avena y mantequilla de maní.', 'Açaí mango', true, null, 'carioca', 2),
  ('selva', 'bowls', 'menu', 'Selva', 'Açaí, Mango, fresa, coco rallado, avena, granola frutos rojos y mantequilla de avellanas.', 'Açaí mango', true, null, 'selva', 3),
  ('cacao', 'bowls', 'menu', 'Cacao', 'Açaí, Banano, granola Fit, chips de chocolate y mantequilla de avellanas.', 'Açaí banano', true, null, 'cacao', 4),
  ('fit', 'bowls', 'menu', 'FIT', 'Açaí, Mango, banano, fresa, arándanos, granola Fit, avena y chía.', 'Açaí mango', true, null, 'fit', 5),
  ('manaos', 'bowls', 'menu', 'Manaos', 'Açaí, Banano, arándanos, galletas oreo, yogurt griego y coco rallado.', 'Açaí banano', true, null, 'manaos', 6),
  ('tucano', 'bowls', 'menu', 'Tucano', 'Açaí, Fresa, kiwi, chía, avena, miel y almendra laminada.', 'Açaí fresa', true, null, 'tucano', 7),
  ('fruta-intensa', 'bowls', 'menu', 'Fruta Intensa', 'Açaí, Banano, fresa, mango, arándanos, kiwi y coco rallado.', 'Açaí frutal', true, null, 'frutal', 8),
  ('bowl-personalizado', 'bowls', 'personalizado', 'Bowl personalizado', 'Arma el tuyo: elige la base, el tamaño y los toppings.', null, true, null, null, 9),
  ('espresso', 'cafes', 'cafe', 'Café espresso', null, null, false, 2500, 'espresso', 101),
  ('americano', 'cafes', 'cafe', 'Café americano', null, null, false, 3000, 'americano', 102),
  ('latte', 'cafes', 'cafe', 'Café latte', null, null, false, 4000, 'latte', 103),
  ('litro-acai', 'litro', 'litro', 'Litro de açaí (32 oz)', 'Litro de açaí para llevar.', null, false, 53000, 'litro', 200)
on conflict (clave) do update set categoria = excluded.categoria, tipo = excluded.tipo, nombre = excluded.nombre, descripcion = excluded.descripcion, sabor = excluded.sabor, usa_tamanos = excluded.usa_tamanos, precio_fijo_cop = excluded.precio_fijo_cop, foto = excluded.foto, orden = excluded.orden, activo = true, updated_at = now();

update public.productos set activo = false, updated_at = now() where activo and clave not in ('amazonas', 'carioca', 'selva', 'cacao', 'fit', 'manaos', 'tucano', 'fruta-intensa', 'bowl-personalizado', 'espresso', 'americano', 'latte', 'litro-acai');
