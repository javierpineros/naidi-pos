import { manejarVerificacionVenta } from '../_shared/manejadores.ts';
import { dependenciasReales } from '../_shared/entorno.ts';

Deno.serve((req) => manejarVerificacionVenta(req, dependenciasReales()));
