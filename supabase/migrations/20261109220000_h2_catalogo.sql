-- H2: catálogo (categorías, tamaños, bases, presentaciones, toppings y productos).
-- Lectura pública (también para el iPad y la tienda sin sesión); sin escritura desde el navegador.
-- Los datos los carga el importador (supabase/seeds/catalogo.sql, generado desde referencia/index.html).
-- Los precios son los realmente cobrados; el "precio anterior" tachado de la web no se guarda.

create table public.categorias (
  clave  text primary key check (clave ~ '^[a-z0-9-]+$'),
  nombre text not null,
  orden  smallint not null default 0
);
comment on table public.categorias is 'Las claves son las que usa la regla puntos.categorias_que_suman.';

create table public.tamanos (
  clave              text primary key check (clave ~ '^[a-z0-9-]+$'),
  nombre             text not null,
  precio_cop         integer not null check (precio_cop > 0),
  toppings_incluidos smallint not null check (toppings_incluidos >= 0),
  orden              smallint not null default 0,
  activo             boolean not null default true,
  updated_at         timestamptz not null default now()
);

create table public.presentaciones (
  clave  text primary key check (clave ~ '^[a-z0-9-]+$'),
  nombre text not null,
  orden  smallint not null default 0
);

create table public.bases (
  clave      text primary key check (clave ~ '^[a-z0-9-]+$'),
  nombre     text not null,
  orden      smallint not null default 0,
  activo     boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.toppings (
  clave      text primary key check (clave ~ '^[a-z0-9-]+$'),
  nombre     text not null,
  precio_cop integer not null check (precio_cop > 0),
  orden      smallint not null default 0,
  activo     boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.productos (
  clave           text primary key check (clave ~ '^[a-z0-9-]+$'),
  categoria       text not null references public.categorias (clave),
  tipo            text not null check (tipo in ('menu', 'personalizado', 'cafe', 'litro')),
  nombre          text not null,
  descripcion     text,
  sabor           text,
  usa_tamanos     boolean not null,
  precio_fijo_cop integer check (precio_fijo_cop > 0),
  foto            text,
  orden           smallint not null default 0,
  activo          boolean not null default true,
  updated_at      timestamptz not null default now(),
  -- Con tamaños, el precio sale del tamaño; sin tamaños, el producto tiene precio fijo.
  constraint productos_precio_coherente check (usa_tamanos = (precio_fijo_cop is null))
);
create index productos_categoria_idx on public.productos (categoria);

-- RLS: lectura pública de lo activo; el personal ve además lo desactivado. Nadie escribe directo.
alter table public.categorias     enable row level security;
alter table public.tamanos        enable row level security;
alter table public.presentaciones enable row level security;
alter table public.bases          enable row level security;
alter table public.toppings       enable row level security;
alter table public.productos      enable row level security;

revoke all on public.categorias, public.tamanos, public.presentaciones, public.bases, public.toppings, public.productos
  from anon, authenticated;
grant select on public.categorias, public.tamanos, public.presentaciones, public.bases, public.toppings, public.productos
  to anon, authenticated;

create policy categorias_ver     on public.categorias     for select to anon, authenticated using (true);
create policy presentaciones_ver on public.presentaciones for select to anon, authenticated using (true);

-- Lo activo lo ve cualquiera (anon no evalúa funciones internas); el personal ve además lo desactivado.
create policy tamanos_ver        on public.tamanos        for select to anon, authenticated using (activo);
create policy bases_ver          on public.bases          for select to anon, authenticated using (activo);
create policy toppings_ver       on public.toppings       for select to anon, authenticated using (activo);
create policy productos_ver      on public.productos      for select to anon, authenticated using (activo);
create policy tamanos_ver_staff   on public.tamanos   for select to authenticated using ((select private.es_staff()));
create policy bases_ver_staff     on public.bases     for select to authenticated using ((select private.es_staff()));
create policy toppings_ver_staff  on public.toppings  for select to authenticated using ((select private.es_staff()));
create policy productos_ver_staff on public.productos for select to authenticated using ((select private.es_staff()));
