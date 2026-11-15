// Reglas de negocio (puntos, umbrales, vigencias, topes...): se ven las vigentes con su historial y se cambian con PIN.
// Cada cambio crea una versión nueva con fecha de vigencia (la anterior se conserva); el servidor audita quién y cuándo.
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fechaCorta, horaBogota } from '../../lib/format.js';
import { pedirPin, modal } from '../../pos/ui/modal.js';
import { mensajePin } from '../../pos/ui/caja.js';

const compacto = (v) => { const t = JSON.stringify(v); return t === undefined ? 'null' : t; };

export function crearVistaReglas(ctx) {
  const el = h('section', { class: 'vista vista-reglas', 'data-vista': 'reglas' });
  let filas = [];
  let cargado = false;
  let filtro = '';

  async function refrescar() {
    try {
      filas = (await ctx.api.listarReglas()) || [];
      cargado = true;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar las reglas.' : e.message, 'error');
      return;
    }
    pintar();
  }

  // Agrupa por clave: la versión vigente (sin fecha de fin) y las anteriores, de la más nueva a la más vieja.
  function agrupadas() {
    const mapa = new Map();
    for (const f of filas) {
      if (!mapa.has(f.clave)) mapa.set(f.clave, { clave: f.clave, vigente: null, anteriores: [] });
      const g = mapa.get(f.clave);
      if (!f.vigente_hasta) g.vigente = f; else g.anteriores.push(f);
    }
    const lista = [...mapa.values()].filter((g) => g.vigente);
    for (const g of lista) g.anteriores.sort((a, b) => b.version - a.version);
    return lista.sort((a, b) => a.clave.localeCompare(b.clave));
  }

  function editar(g) {
    const r = g.vigente;
    const m = modal({ titulo: 'Cambiar ' + r.clave });
    const campo = h('textarea', { rows: '5', 'data-campo': 'valor-regla', 'aria-label': 'Valor nuevo (JSON)', class: 'mono' });
    campo.value = JSON.stringify(r.valor, null, 2);
    const error = h('p', { class: 'error', role: 'alert', 'data-campo': 'error-regla' });
    const guardar = async () => {
      error.textContent = '';
      let valor;
      try { valor = JSON.parse(campo.value); } catch (e) { error.textContent = 'El valor no es un JSON válido. Los textos van entre comillas.'; return; }
      if (compacto(valor) === compacto(r.valor)) { error.textContent = 'No cambiaste nada.'; return; }
      const pin = await pedirPin('Confirma con tu PIN: cambiar la regla ' + r.clave);
      if (!pin) return;
      let res;
      try { res = await ctx.api.cambiarRegla(r.clave, valor, pin); } catch (e) { error.textContent = e.message; return; }
      if (res && res.ok === false) { error.textContent = mensajePin(res); return; }
      m.cerrar();
      ctx.avisar('Regla actualizada: ' + r.clave + ' (versión ' + res.version + ').', 'ok');
      await refrescar();
    };
    agregar(vaciar(m.cuerpo),
      r.descripcion ? h('p', null, r.descripcion) : null,
      h('p', { class: 'pequeno' }, 'Hoy vale ' + compacto(r.valor) + ' (versión ' + r.version + '). El cambio rige desde que lo guardas; lo anterior queda en el historial.'),
      campo, error,
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: 'btn', onclick: () => m.cerrar() }, 'Cancelar'),
        h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'guardar-regla', onclick: guardar }, 'Guardar')));
  }

  function pintar() {
    const cuando = (iso) => fechaCorta(iso, ctx.ahora()) + ' ' + horaBogota(iso);
    const busca = filtro.trim().toLowerCase();
    const lista = agrupadas().filter((g) => !busca || g.clave.toLowerCase().indexOf(busca) >= 0 || String(g.vigente.descripcion || '').toLowerCase().indexOf(busca) >= 0);
    const buscador = h('input', { type: 'search', value: filtro, placeholder: 'Buscar regla…', 'data-campo': 'buscar-regla', 'aria-label': 'Buscar regla' });
    buscador.addEventListener('input', () => { filtro = buscador.value; pintar(); const n = el.querySelector('[data-campo="buscar-regla"]'); if (n) { n.focus(); n.setSelectionRange(filtro.length, filtro.length); } });
    vaciar(el);
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Reglas de negocio'), buscador,
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-reglas', onclick: refrescar }, 'Actualizar')),
      h('p', { class: 'pequeno' }, 'Puntos, umbrales, vigencias y topes viven aquí, no en el código. Cada cambio crea una versión nueva y queda en la auditoría.'),
      !cargado ? h('p', { class: 'vacio' }, 'Cargando las reglas…')
        : lista.length
          ? h('table', { class: 'tabla', 'data-tabla': 'reglas' },
              h('thead', null, h('tr', null, h('th', null, 'Regla'), h('th', null, 'Valor'), h('th', null, 'Desde'), h('th', null, ''))),
              h('tbody', null, lista.map((g) =>
                h('tr', { 'data-regla': g.clave },
                  h('td', null, h('strong', { class: 'mono' }, g.clave), g.vigente.descripcion ? h('div', { class: 'pequeno' }, g.vigente.descripcion) : null,
                    g.anteriores.length
                      ? h('details', { 'data-campo': 'historial' }, h('summary', null, 'Historial (' + g.anteriores.length + ')'),
                          g.anteriores.map((a) => h('div', { class: 'pequeno mono' }, 'v' + a.version + ' · ' + compacto(a.valor) + ' · hasta ' + cuando(a.vigente_hasta))))
                      : null),
                  h('td', { class: 'mono', 'data-campo': 'valor' }, compacto(g.vigente.valor)),
                  h('td', null, 'v' + g.vigente.version + ' · ' + cuando(g.vigente.vigente_desde)),
                  h('td', null, h('button', { type: 'button', class: 'btn', 'data-accion': 'cambiar-regla', onclick: () => editar(g) }, 'Cambiar'))))))
          : h('p', { class: 'vacio' }, 'No hay reglas que coincidan.'));
  }

  pintar();
  return { el, refrescar };
}
