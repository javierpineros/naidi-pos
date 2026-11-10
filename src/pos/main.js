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

const pos = crearPos({ raiz: document.getElementById('app'), api, cola, sonido: crearSonido(), cacheCatalogo });
pos.iniciar();

// Respaldo para recargar sin internet: guarda la página y sus archivos al verlos.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw-pos.js').catch(() => {});
}
