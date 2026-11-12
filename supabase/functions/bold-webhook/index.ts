import { manejarWebhook } from '../_shared/manejadores.ts';
import { dependenciasReales } from '../_shared/entorno.ts';

Deno.serve((req) => manejarWebhook(req, dependenciasReales()));
