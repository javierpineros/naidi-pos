import { createClient } from '@supabase/supabase-js';

// URL y llave pública (anon) por variables de Vite. La seguridad la da el RLS, no el secreto de estas llaves.
export function crearClienteSupabase(env, opcionesAuth) {
  const e = env || import.meta.env;
  if (!e.VITE_SUPABASE_URL || !e.VITE_SUPABASE_ANON_KEY) {
    throw new Error('Faltan VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (ver .env.example).');
  }
  return createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY, {
    auth: Object.assign({ persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }, opcionesAuth || {}),
  });
}
