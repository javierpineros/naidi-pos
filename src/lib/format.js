// Pesos colombianos con punto de miles: 19700 -> "$19.700".
export function fmtCop(n) {
  const v = Math.round(Number(n) || 0);
  const signo = v < 0 ? '-' : '';
  return signo + '$' + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Hora de Bogotá en 24 h: "14:05".
export function horaBogota(iso) {
  if (!iso) return '';
  const partes = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t) => (partes.find((p) => p.type === t) || {}).value || '00';
  return g('hour') + ':' + g('minute');
}

// Fecha de hoy en Bogotá como "AAAA-MM-DD".
export function hoyBogota(ahora) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora || new Date());
  return d;
}

export const MEDIOS = {
  efectivo: 'Efectivo',
  datafono_bold: 'Datáfono Bold',
  transferencia: 'Transferencia',
  rappi: 'Rappi',
  bold_online: 'Pago en línea',
};
