import '../pos/pos.css';
import './panel.css';
import { crearClienteSupabase } from '../lib/supabase.js';
import { crearApiPanel } from './api.js';
import { crearPanel } from './app.js';

const api = crearApiPanel(crearClienteSupabase());
crearPanel({ raiz: document.getElementById('app'), api }).iniciar();
