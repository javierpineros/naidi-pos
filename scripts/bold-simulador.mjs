// Simulador local de webhooks de Bold (solo desarrollo). Firma un evento como lo haría Bold y lo envía a la Edge Function
// servida con `supabase functions serve --env-file supabase/functions/.env`. Sirve para revisar a mano cada caso.
//
//   node scripts/bold-simulador.mjs <order_id> aprobado [monto] [--moneda=COP] [--id=evt-1]
//   node scripts/bold-simulador.mjs <order_id> rechazado
//   node scripts/bold-simulador.mjs <order_id> anulado
//   Casos de prueba:  --firma-mala (firma inválida)   --repetir (envía el mismo evento dos veces)
//
// La llave secreta sale de BOLD_SECRET_KEY (misma que usa la función). Nunca uses llaves de producción aquí.
import { createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const opc = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const [orden, tipo, monto] = args.filter((a) => !a.startsWith('--'));
const TIPOS = { aprobado: 'SALE_APPROVED', rechazado: 'SALE_REJECTED', anulado: 'VOID_APPROVED' };
const secreta = process.env.BOLD_SECRET_KEY;
if (!orden || !TIPOS[tipo] || !secreta) {
  console.error('Uso: BOLD_SECRET_KEY=... node scripts/bold-simulador.mjs <order_id> aprobado|rechazado|anulado [monto] [--firma-mala] [--repetir]');
  process.exit(1);
}
const url = process.env.BOLD_WEBHOOK_URL || 'http://127.0.0.1:54321/functions/v1/bold-webhook';
const id = opc.id || 'sim-' + Date.now();
const ev = { id, type: TIPOS[tipo], subject: 'bp-' + id,
  data: { payment_id: 'bp-' + id, payment_method: 'CARD', amount: { total: Number(monto || 0), currency: opc.moneda || 'COP' }, metadata: { reference: orden } } };
const cuerpo = JSON.stringify(ev);
const firma = opc['firma-mala'] ? 'f'.repeat(64) : createHmac('sha256', secreta).update(Buffer.from(cuerpo).toString('base64')).digest('hex');
for (let i = 0; i < (opc.repetir ? 2 : 1); i++) {
  const r = await fetch(url, { method: 'POST', body: cuerpo, headers: { 'x-bold-signature': firma, 'Content-Type': 'application/json' } });
  console.log(`#${i + 1} ${TIPOS[tipo]} ${orden} ->`, r.status, await r.text());
}
