import '../pos/pos.css';
import './panel.css';
import { crearClienteSupabase } from '../lib/supabase.js';
import { crearApiPanel } from './api.js';
import { crearPanel } from './app.js';

const api = crearApiPanel(crearClienteSupabase());
// El enlace de activación del iPad debe apuntar al sitio compilado (Safari 12 no corre el servidor de desarrollo).
// En producción es el mismo sitio; en desarrollo se fija con VITE_PANTALLA_ORIGEN.
const origenPantalla = String(import.meta.env.VITE_PANTALLA_ORIGEN || '').replace(/\/+$/, '');
crearPanel({ raiz: document.getElementById('app'), api, origen: origenPantalla ? () => origenPantalla : undefined }).iniciar();
