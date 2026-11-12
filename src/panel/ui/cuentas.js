// Cuentas con restricción para pedidos web: ver, cambiar de modo o quitar la restricción (siempre con PIN).
import { h, vaciar, agregar } from '../../lib/dom.js';
import { fechaCorta } from '../../lib/format.js';
import { pedirTexto, pedirPin, confirmar } from '../../pos/ui/modal.js';
import { mensajePin } from '../../pos/ui/caja.js';

const MODOS = { prepago: 'Solo pago en línea (prepago)', bloqueo: 'Pedidos web bloqueados' };

export function crearVistaCuentas(ctx) {
  const el = h('section', { class: 'vista vista-cuentas', 'data-vista': 'cuentas' });
  let cuentas = [];
  let cargado = false;

  async function refrescar() {
    try {
      cuentas = (await ctx.api.cuentasRestringidas()) || [];
      cargado = true;
    } catch (e) {
      ctx.avisar(e.name === 'ErrorRed' ? 'Sin conexión: no puedo cargar las cuentas.' : e.message, 'error');
      return;
    }
    pintar();
  }

  async function cambiar(c, modo) {
    const quitar = modo === null;
    if (quitar) {
      const ok = await confirmar({ titulo: 'Quitar restricción', mensaje: (c.nombre || 'Esta cuenta') + ' volverá a poder pedir como cualquier cliente. ¿Seguimos?', boton: 'Quitar' });
      if (!ok) return;
    }
    const motivo = quitar ? null : await pedirTexto({ titulo: modo === 'prepago' ? 'Cambiar a prepago' : 'Bloquear pedidos web', etiqueta: 'Motivo (opcional)', boton: 'Seguir', obligatorio: false });
    if (motivo === null && !quitar) return;
    const pin = await pedirPin(quitar ? 'Confirma con tu PIN: quitar restricción' : 'Confirma con tu PIN');
    if (!pin) return;
    let r;
    try { r = await ctx.api.restringirCuenta(c.cliente_id, modo, motivo, pin); } catch (e) { ctx.avisar(e.message, 'error'); return; }
    if (r && r.ok === false) { ctx.avisar(mensajePin(r), 'error'); return; }
    ctx.avisar(quitar ? 'Restricción quitada.' : 'Restricción actualizada.', 'ok');
    await ctx.refrescarTodo();
  }

  function pintar() {
    vaciar(el);
    agregar(el,
      h('div', { class: 'barra-vista' }, h('h2', null, 'Cuentas con restricción'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'actualizar-cuentas', onclick: refrescar }, 'Actualizar')),
      h('p', { class: 'pequeno' }, 'Llegan aquí desde la alerta "No llegó". Decidir, cambiar o quitar una restricción pide tu PIN.'),
      !cargado ? h('p', { class: 'vacio' }, 'Cargando las cuentas…')
        : cuentas.length
          ? h('table', { class: 'tabla', 'data-tabla': 'cuentas' },
              h('thead', null, h('tr', null, h('th', null, 'Cuenta'), h('th', null, 'Restricción'), h('th', null, 'Motivo'), h('th', { class: 'num' }, 'No llegó'), h('th', null, 'Desde'), h('th', null, ''))),
              h('tbody', null, cuentas.map((c) =>
                h('tr', { 'data-cliente': c.cliente_id },
                  h('td', null, h('strong', null, c.nombre || 'Sin nombre'), h('br'), h('span', { class: 'pequeno' }, c.correo || '')),
                  h('td', { 'data-campo': 'modo' }, MODOS[c.modo] || c.modo),
                  h('td', null, c.motivo || '—'),
                  h('td', { class: 'num mono' }, String(c.no_llego)),
                  h('td', null, fechaCorta(c.fijada_en, ctx.ahora())),
                  h('td', null,
                    h('button', { type: 'button', class: 'btn', 'data-accion': 'cambiar-modo', onclick: () => cambiar(c, c.modo === 'prepago' ? 'bloqueo' : 'prepago') }, c.modo === 'prepago' ? 'Pasar a bloqueo' : 'Pasar a prepago'),
                    h('button', { type: 'button', class: 'btn', 'data-accion': 'quitar-restriccion', onclick: () => cambiar(c, null) }, 'Quitar restricción'))))))
          : h('p', { class: 'vacio', 'data-campo': 'sin-cuentas' }, 'No hay cuentas con restricción.'));
  }

  pintar();
  return { el, refrescar };
}
