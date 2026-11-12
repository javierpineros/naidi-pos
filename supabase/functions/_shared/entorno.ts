// Arma las dependencias reales en Deno (Edge Functions). Los secretos vienen de las variables de entorno del proyecto:
//   BOLD_IDENTITY_KEY, BOLD_SECRET_KEY, SITE_URL, BOLD_RECONCILE_TOKEN  (supabase secrets set ...; nunca en el repositorio)
//   BOLD_ACEPTAR_FIRMA_VACIA_PRUEBAS=1 solo en supabase/functions/.env local (el sandbox de Bold firma con llave vacía); se ignora en *.supabase.co
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Dependencias } from './manejadores.ts';

export function dependenciasReales(): Dependencias {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const servicio = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
    secretos: {
      identidad: Deno.env.get('BOLD_IDENTITY_KEY') ?? '',
      secreta: Deno.env.get('BOLD_SECRET_KEY') ?? '',
      sitio: (Deno.env.get('SITE_URL') ?? '').replace(/\/+$/, ''),
      tokenConciliacion: Deno.env.get('BOLD_RECONCILE_TOKEN') ?? '',
      // Doble barrera: la bandera debe estar encendida Y el proyecto no puede ser uno alojado (*.supabase.co / *.supabase.in).
      aceptarFirmaVaciaPruebas: Deno.env.get('BOLD_ACEPTAR_FIRMA_VACIA_PRUEBAS') === '1' && !/\.supabase\.(co|in)(:\d+)?\/?$/i.test(url),
    },
    clienteServicio: createClient(url, servicio, opciones),
    // Con la sesión de quien llama: así auth.uid() de la función SQL es la persona, no el servidor.
    clienteUsuario: (autorizacion: string) => createClient(url, anon, { ...opciones, global: { headers: { Authorization: autorizacion } } }),
  };
}
