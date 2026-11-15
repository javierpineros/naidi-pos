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
  leer() { try { return window.localStorage.getItem(CLAVE_VENTA); } catch (e) { return null; } },
  escribir(id) { try { window.localStorage.setItem(CLAVE_VENTA, id); } catch (e) { /* ok */ } },
  borrar() { try { window.localStorage.removeItem(CLAVE_VENTA); } catch (e) { /* ok */ } },
};

const pos = crearPos({ raiz: document.getElementById('app'), api, cola, sonido: crearSonido(), cacheCatalogo, almacenVenta });
pos.iniciar();

// Respaldo para recargar sin internet: guarda la página y sus archivos al verlos.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw-pos.js').catch(() => {});
}
