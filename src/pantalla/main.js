import './pantalla.css';
import { crearApiPantalla } from './api.js';
import { crearPantalla } from './app.js';
import { qrSvg } from '../lib/qr.js';

const CLAVE = 'naidi.pantalla.llave';

// La llave vive en localStorage. Si el navegador lo bloquea (modo privado), vive en memoria hasta que se recargue.
let enMemoria = null;
const almacen = {
  leer() {
    try { return window.localStorage.getItem(CLAVE) || enMemoria; } catch (e) { return enMemoria; }
  },
  guardar(valor) {
    enMemoria = valor;
    try { window.localStorage.setItem(CLAVE, valor); } catch (e) { /* ok */ }
  },
  borrar() {
    enMemoria = null;
    try { window.localStorage.removeItem(CLAVE); } catch (e) { /* ok */ }
  },
};

const env = import.meta.env;
const api = crearApiPantalla({ url: env.VITE_SUPABASE_URL, anon: env.VITE_SUPABASE_ANON_KEY });
const pantalla = crearPantalla({
  raiz: document.getElementById('app'),
  api,
  almacen,
  qr: (url) => qrSvg(url, 6),
});
pantalla.iniciar();
