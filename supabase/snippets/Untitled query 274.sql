insert into public.staff (user_id, rol, nombre)
select id, 'cajero', 'Yo' from auth.users where email = 'yo@prueba.test';

update public.banderas set activa = true where clave = 'pedidos_web';