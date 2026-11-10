import './cuenta.css';
import { crearClienteSupabase } from '../lib/supabase.js';
import { crearApiCuenta } from './api.js';
import { crearCuenta } from './app.js';

// El token del QR llega en el fragmento (#entrada= o #qr=). PKCE deja el fragmento libre para el inicio con Google.
const cliente = crearClienteSupabase(undefined, { flowType: 'pkce', detectSessionInUrl: true });
const api = crearApiCuenta(cliente);

// El QR pendiente vive en sessionStorage: sobrevive al ir y volver de Google o al escribir el código, y se borra al cerrar la pestaña.
const almacen = {
  leer: (k) => { try { return window.sessionStorage.getItem(k) || window.localStorage.getItem(k); } catch (e) { return null; } },
  escribir: (k, v) => {
    try { if (k.indexOf('descartado') > -1) window.localStorage.setItem(k, v); else window.sessionStorage.setItem(k, v); } catch (e) { /* ok */ }
  },
  borrar: (k) => { try { window.sessionStorage.removeItem(k); } catch (e) { /* ok */ } },
};

crearCuenta({
  raiz: document.getElementById('app'),
  api,
  almacen,
  googleActivo: import.meta.env.VITE_LOGIN_GOOGLE === '1',
}).iniciar();
