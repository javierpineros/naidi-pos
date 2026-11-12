update public.banderas set activa = true where clave in ('pedidos_web', 'pago_en_linea_bold');
update public.pedidos_web_interruptor set abierta = true where id = 1;