import './pos.css';
import { crearClienteSupabase } from '../lib/supabase.js';
import { crearApi } from './api.js';
import { crearPos } from './app.js';
import { crearCola, almacenLocal } from './cola.js';
import { crearSonido } from './sonido.js';

const cliente = crearClienteSupabase();
const api = crearApi(cliente);
const cola = crearCola({ almacen: almacenLocal(window.localStorage, 'naidi.pos.cola') });

const cacheCatalogo = {
  leer() {
    try { return JSON.parse(window.localStorage.getItem('naidi.pos.catalogo')); } catch (e) { return null; }
  },
  escribir(datos) {
    try { window.localStorage.setItem('naidi.pos.catalogo', JSON.stringify(datos)); } catch (e) { /* sin espacio: no pasa nada */ }
  },
};

// La venta abierta (confirmada sin pagar o en edición) se recuerda para retomarla si el POS se recarga.
const CLAVE_VENTA = 'naidi.pos.venta_abierta';
const almacenVenta = {
  // Guarda el id de una venta del servidor (texto) o los datos de una venta local (objeto); lo viejo, texto suelto, sigue valiendo.
  leer() {
    try {
      const x = window.localStorage.getItem(CLAVE_VENTA);
      if (!x) return null;
      try { const o = JSON.parse(x); return o && typeof o === 'object' ? o : x; } catch (e) { return x; }
    } catch (e) { return null; }
  },
  escribir(dato) { try { window.localStorage.setItem(CLAVE_VENTA, typeof dato === 'string' ? dato : JSON.stringify(dato)); } catch (e) { /* ok */ } },
  borrar() { try { window.localStorage.removeItem(CLAVE_VENTA); } catch (e) { /* ok */ } },
};

const pos = crearPos({ raiz: document.getElementById('app'), api, cola, sonido: crearSonido(), cacheCatalogo, almacenVenta });
pos.iniciar();

// Respaldo para recargar sin internet: guarda la página y sus archivos al verlos.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw-pos.js').catch(() => {});
}
