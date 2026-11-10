import './tienda.css';
import { crearClienteSupabase } from '../lib/supabase.js';
import { crearApiTienda } from './api.js';
import { crearTienda } from './app.js';

// PKCE deja el fragmento de la URL libre para el inicio con Google.
const cliente = crearClienteSupabase(undefined, { flowType: 'pkce', detectSessionInUrl: true });
const api = crearApiTienda(cliente);

// Solo una comodidad: el carrito sobrevive a una recarga. Si el navegador no deja guardar, no pasa nada.
const almacen = {
  leer: (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  escribir: (k, v) => { try { window.localStorage.setItem(k, v); } catch (e) { /* ok */ } },
  borrar: (k) => { try { window.localStorage.removeItem(k); } catch (e) { /* ok */ } },
};

crearTienda({
  raiz: document.getElementById('app'),
  api,
  almacen,
  googleActivo: import.meta.env.VITE_LOGIN_GOOGLE === '1',
}).iniciar();
