// Cliente mínimo de la pantalla del iPad. No usa supabase-js: la pantalla solo necesita llamar una función
// (pantalla_estado) con la llave del dispositivo, y así el paquete es chico y no arrastra código que Safari 12 no entiende.
// La llave anon es pública por diseño; la seguridad la da la función del servidor, que valida la llave del dispositivo.

export function crearApiPantalla(opciones) {
  const url = String(opciones.url || '').replace(/\/+$/, '');
  const anon = opciones.anon || '';
  const hacerFetch = opciones.fetch || (typeof fetch === 'function' ? function (u, i) { return fetch(u, i); } : null);
  const limiteMs = opciones.limiteMs || 8000;
  const programar = opciones.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
  const cancelar = opciones.clearTimeout || function (t) { clearTimeout(t); };

  // Devuelve el estado, o lanza un Error con .tipo = 'red' | 'servidor'.
  function estado(llave) {
    if (!hacerFetch) return Promise.reject(Object.assign(new Error('Este navegador no tiene fetch.'), { tipo: 'red' }));
    const control = typeof AbortController === 'function' ? new AbortController() : null;
    let vencido = false;
    const reloj = programar(() => { vencido = true; if (control) control.abort(); }, limiteMs);
    const pedido = hacerFetch(url + '/rest/v1/rpc/pantalla_estado', {
      method: 'POST',
      headers: { apikey: anon, Authorization: 'Bearer ' + anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_llave: llave }),
      cache: 'no-store',
      signal: control ? control.signal : undefined,
    });
    return pedido.then(
      (r) => {
        cancelar(reloj);
        if (!r.ok) throw Object.assign(new Error('El servidor respondió ' + r.status + '.'), { tipo: 'servidor' });
        return r.json();
      },
      (e) => {
        cancelar(reloj);
        throw Object.assign(new Error(vencido ? 'El servidor tardó demasiado.' : 'Sin conexión.'), { tipo: 'red', causa: e });
      }
    );
  }

  return { estado };
}
