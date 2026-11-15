import './pagar.css';
import { crearClienteSupabase } from '../lib/supabase.js';
import { crearApiPagar } from './api.js';
import { crearPagar } from './app.js';

crearPagar({ raiz: document.getElementById('app'), api: crearApiPagar(crearClienteSupabase()) }).iniciar();
