// /cuenta: la cuenta del cliente en su celular. Acceso con correo y código (o Google), consentimiento de datos,
// check-in con el QR de entrada (#entrada=), reclamo del QR posterior a la venta (#qr=), saldo y progreso hacia el premio,
// compra en curso con "esto no es lo que pedí", premios con vigencia, historial y perfil.
// Todo texto entra como nodo de texto (nunca como HTML). El servidor calcula puntos, totales y premios: aquí solo se muestran.
import { h, vaciar } from '../lib/dom.js';
import { fmtCop, horaBogota, fechaCorta, TAMANOS } from '../lib/format.js';

const CLAVE_PENDIENTE = 'naidi.cuenta.pendiente';
const CLAVE_PERFIL_DESCARTADO = 'naidi.cuenta.perfil_descartado';
const FORMATO_ENTRADA = /^[0-9a-f]{48}$/;
const FORMATO_QR = /^[0-9a-f]{64}$/;

const MOVIMIENTOS = {
  suma: 'Puntos por tu compra',
  canje: 'Canje de premio',
  anulacion: 'Compra anulada',
  bono: 'Bono',
};
const MEDIOS = { efectivo: 'Efectivo', datafono_bold: 'Datáfono Bold', transferencia: 'Transferencia', bold_online: 'Pago en línea', rappi: 'Rappi' };

export function crearCuenta(cfg) {
  const { raiz, api } = cfg;
  const almacen = cfg.almacen || { leer: () => null, escribir: () => {}, borrar: () => {} };
  const leerHash = cfg.leerHash || (() => window.location.hash);
  const limpiarHash = cfg.limpiarHash || (() => { try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* ok */ } });
  const cadaTanto = cfg.setInterval || ((fn, ms) => setInterval(fn, ms));
  const parar = cfg.clearInterval || ((t) => clearInterval(t));
  const ahora = cfg.ahora || (() => new Date());
  const googleActivo = !!cfg.googleActivo;
  const intervaloMs = cfg.intervaloMs || 3000;

  const e = {
    pantalla: 'cargando', pestana: 'inicio', sesion: null, perfil: null, reglas: null, saldo: 0, vouchers: [],
    compra: null, checkin: null, movimientos: [], compras: [], aviso: null, error: '',
    paso: 'correo', correo: '', ocupado: false, borrador: {}, reportados: new Set(), temporizador: null, firmaSondeo: '',
  };

  // ------------------------------------------------------------------ Utilidades
  const leerAlmacen = (k) => { try { return almacen.leer(k); } catch (x) { return null; } };
  const escribirAlmacen = (k, v) => { try { almacen.escribir(k, v); } catch (x) { /* sin almacenamiento: no pasa nada */ } };
  const borrarAlmacen = (k) => { try { almacen.borrar(k); } catch (x) { /* ok */ } };

  function aviso(tipo, texto) { e.aviso = texto ? { tipo, texto } : null; }

  function pila(nombre) { return String(nombre || '').split(/\s+/)[0] || ''; }
  const nombreTamano = (t) => TAMANOS[t] || t || '';

  function etiquetaVoucher(w) {
    if (w.modalidad === 'toppings_gratis') return (w.cantidad_toppings || 1) + ((w.cantidad_toppings || 1) === 1 ? ' topping gratis' : ' toppings gratis');
    if (w.modalidad === 'descuento_compra') return w.descuento_pct + '% de descuento en tu compra';
    return w.descuento_pct + '% de descuento en un bowl ' + (w.tamanos || []).map(nombreTamano).join(', ');
  }

  function textoLinea(l) {
    const base = (l.cantidad > 1 ? l.cantidad + ' × ' : '') + l.producto + (l.tamano ? ' ' + nombreTamano(l.tamano) : '');
    const tops = (l.toppings || []).map((t) => (t && t.nombre) || t).join(', ');
    return { base, tops };
  }

  // ------------------------------------------------------------------ Acceso
  function pantallaAcceso() {
    const pendiente = leerAlmacen(CLAVE_PENDIENTE);
    const contexto = pendiente
      ? (JSON.parse(pendiente).tipo === 'entrada'
        ? 'Entra para registrar tu llegada: así el vendedor te reconoce y sumas puntos.'
        : 'Entra para reclamar los puntos de tu compra.')
      : 'Entra para ver tus puntos, tus premios y tu compra en curso.';
    const errorEl = h('p', { class: 'error', role: 'alert', 'data-campo': 'error' }, e.error);

    const formCorreo = h('form', { class: 'form-acceso', 'data-form': 'correo', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      const correo = String(new FormData(ev.target).get('correo') || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) { errorEl.textContent = 'Revisa tu correo: parece que le falta algo.'; return; }
      await accion(async () => { await api.enviarCodigo(correo); e.correo = correo; e.paso = 'codigo'; e.error = ''; }, errorEl, pintar);
    } },
      h('label', null, 'Tu correo', h('input', { type: 'email', name: 'correo', autocomplete: 'email', inputmode: 'email', value: e.correo, 'data-campo': 'correo' })),
      h('button', { type: 'submit', class: 'btn btn-primario', 'data-accion': 'enviar-codigo' }, 'Enviarme un código'));

    const formCodigo = h('form', { class: 'form-acceso', 'data-form': 'codigo', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      const codigo = String(new FormData(ev.target).get('codigo') || '').replace(/\s+/g, '');
      if (!/^\d{6}$/.test(codigo)) { errorEl.textContent = 'El código tiene 6 números.'; return; }
      await accion(async () => { await api.verificarCodigo(e.correo, codigo); e.sesion = await api.sesion(); e.error = ''; }, errorEl, continuarConSesion);
    } },
      h('p', null, 'Te enviamos un código de 6 números a ', h('strong', null, e.correo), '. Puede tardar un minuto; revisa también el spam.'),
      h('label', null, 'Código', h('input', { type: 'text', name: 'codigo', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, 'data-campo': 'codigo' })),
      h('button', { type: 'submit', class: 'btn btn-primario', 'data-accion': 'verificar-codigo' }, 'Entrar'),
      h('div', { class: 'fila-botones' },
        h('button', { type: 'button', class: 'btn', 'data-accion': 'reenviar', onclick: () => accion(async () => { await api.enviarCodigo(e.correo); aviso('ok', 'Te enviamos un código nuevo.'); }, errorEl, pintar) }, 'Reenviar código'),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'cambiar-correo', onclick: () => { e.paso = 'correo'; e.error = ''; pintar(); } }, 'Cambiar correo')));

    return h('main', { class: 'acceso' },
      marca(),
      h('h1', null, 'Tu cuenta Naidí'),
      h('p', { class: 'contexto' }, contexto),
      e.aviso ? h('p', { class: 'aviso ' + e.aviso.tipo, role: 'status' }, e.aviso.texto) : null,
      e.paso === 'correo' ? formCorreo : formCodigo,
      errorEl,
      googleActivo && e.paso === 'correo'
        ? h('button', { type: 'button', class: 'btn btn-google', 'data-accion': 'google', onclick: () => accion(() => api.entrarConGoogle(), errorEl, () => {}) }, 'Continuar con Google')
        : null);
  }

  // Ejecuta una acción del servidor mostrando el error en su sitio y evitando dobles toques.
  async function accion(fn, errorEl, despues) {
    if (e.ocupado) return;
    e.ocupado = true;
    try {
      await fn();
      e.ocupado = false;
      if (despues) await despues();
    } catch (x) {
      e.ocupado = false;
      if (errorEl) errorEl.textContent = x.name === 'ErrorRed' ? 'No hay conexión. Revisa tu internet e inténtalo de nuevo.' : x.message;
    }
  }

  // ------------------------------------------------------------------ Consentimiento (Ley 1581)
  function pantallaConsentimiento() {
    const errorEl = h('p', { class: 'error', role: 'alert', 'data-campo': 'error' });
    const datos = h('input', { type: 'checkbox', name: 'datos', 'data-campo': 'acepta-datos' });
    const mensajes = h('input', { type: 'checkbox', name: 'mensajes', 'data-campo': 'acepta-mensajes' });
    const boton = h('button', { type: 'submit', class: 'btn btn-primario', disabled: true, 'data-accion': 'aceptar' }, 'Continuar');
    datos.addEventListener('change', () => { boton.disabled = !datos.checked; });
    return h('main', { class: 'acceso' },
      marca(),
      h('h1', null, 'Antes de empezar'),
      h('p', null, 'Para llevar tu cuenta y tus puntos necesitamos tu autorización para tratar tus datos personales (Ley 1581 de 2012).'),
      h('form', { class: 'form-acceso', 'data-form': 'consentimiento', onsubmit: async (ev) => {
        ev.preventDefault();
        if (!datos.checked) return;
        await accion(async () => {
          const version = e.perfil.privacidad_version;
          await api.consentir('datos', version, true);
          if (mensajes.checked) await api.consentir('mensajes', version, true);
        }, errorEl, recargarPerfilYSeguir);
      } },
        h('label', { class: 'casilla' }, datos,
          h('span', null, 'Autorizo a Naidi a tratar mis datos (nombre, correo, compras y puntos) para llevar mi cuenta y mis puntos, según la ',
            h('a', { href: '/privacidad/', target: '_blank', rel: 'noopener' }, 'política de privacidad'), '.')),
        h('label', { class: 'casilla' }, mensajes,
          h('span', null, 'Quiero recibir mensajes de Naidi con novedades y recordatorios. (Opcional; lo puedes cambiar cuando quieras.)')),
        boton),
      errorEl,
      h('button', { type: 'button', class: 'btn btn-texto', 'data-accion': 'salir', onclick: salir }, 'Salir'));
  }

  // ------------------------------------------------------------------ Inicio
  function marca() { return h('img', { class: 'logo', src: '/img/logo-nombre.png', alt: 'Naidí' }); }

  function tarjetaSaldo() {
    const um = (e.reglas && e.reglas.umbrales) || {};
    const orden = Object.entries(um).sort((a, b) => a[1] - b[1]);
    const saldo = Math.max(0, e.saldo);
    let progreso = null;
    if (orden.length) {
      const [tam, meta] = orden[0];
      const pct = Math.min(100, Math.round((saldo / meta) * 100));
      progreso = h('div', { class: 'progreso' },
        h('div', { class: 'barra', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': meta, 'aria-valuenow': Math.min(saldo, meta) },
          h('div', { class: 'barra-llena', style: 'width:' + pct + '%' })),
        saldo >= meta
          ? h('p', { class: 'ok', 'data-campo': 'progreso' }, '¡Ya puedes canjear tu premio!')
          : h('p', { 'data-campo': 'progreso' }, 'Te faltan ' + (meta - saldo) + ' puntos para tu premio de bowl ' + nombreTamano(tam) + '.'));
    }
    return h('section', { class: 'tarjeta saldo' },
      h('p', { class: 'rotulo' }, 'Tus puntos'),
      h('p', { class: 'puntos mono', 'data-campo': 'saldo' }, String(e.saldo)),
      progreso,
      h('button', { type: 'button', class: 'btn', 'data-accion': 'ir-premios', onclick: () => irA('premios') }, 'Ver premios'));
  }

  function tarjetaCheckin() {
    // Con una compra en curso ya lo están atendiendo (el servidor cierra la llegada al empezar la venta): la tarjeta sobra.
    if (e.compra) return null;
    if (e.checkin) {
      return h('section', { class: 'tarjeta checkin', 'data-campo': 'checkin' },
        h('p', { class: 'rotulo' }, 'Tu llegada'),
        h('p', null, 'Estás en la lista desde las ' + horaBogota(e.checkin.llegada_en) + '. El vendedor te reconoce y te alista tu pedido.'),
        h('p', { class: 'pequeno' }, 'Vence a las ' + horaBogota(e.checkin.vence_en) + '.'));
    }
    return h('section', { class: 'tarjeta checkin', 'data-campo': 'checkin' },
      h('p', { class: 'rotulo' }, '¿Estás en la tienda?'),
      h('p', null, 'Escanea el código QR de entrada con la cámara de tu celular para avisarle al vendedor que llegaste.'));
  }

  function tarjetaCompra() {
    const c = e.compra;
    if (!c) return null;
    const pagada = c.estado === 'pagada';
    const reportado = e.reportados.has(c.venta_id);
    const b = e.borrador;
    const lineas = (c.lineas || []).map((l) => {
      const t = textoLinea(l);
      return h('li', { class: 'linea' },
        h('div', null, h('strong', null, t.base), t.tops ? h('small', null, t.tops) : null),
        h('span', { class: 'mono' }, fmtCop(l.cantidad * l.precio_unitario_cop - (l.descuento_cop || 0))));
    });
    let reporte = null;
    if (!pagada) {
      if (reportado) {
        reporte = h('p', { class: 'aviso ok', 'data-campo': 'reportado' }, 'Ya le avisamos al vendedor. Te ayudará en un momento.');
      } else if (b.reportando) {
        const errorEl = h('p', { class: 'error', role: 'alert' });
        reporte = h('form', { class: 'form-reporte', 'data-form': 'reporte', onsubmit: async (ev) => {
          ev.preventDefault();
          await accion(async () => { await api.reportarPedido(c.venta_id, b.nota); e.reportados.add(c.venta_id); b.reportando = false; b.nota = ''; }, errorEl, pintar);
        } },
          h('label', null, '¿Qué no coincide? (opcional)',
            h('textarea', { name: 'nota', maxlength: 200, rows: 2, 'data-campo': 'nota', oninput: (ev) => { b.nota = ev.target.value; } }, b.nota || '')),
          h('div', { class: 'fila-botones' },
            h('button', { type: 'submit', class: 'btn btn-primario', 'data-accion': 'enviar-reporte' }, 'Avisar al vendedor'),
            h('button', { type: 'button', class: 'btn', 'data-accion': 'cancelar-reporte', onclick: () => { b.reportando = false; pintar(); } }, 'Cancelar')),
          errorEl);
      } else {
        reporte = h('button', { type: 'button', class: 'btn', 'data-accion': 'esto-no-es', onclick: () => { b.reportando = true; pintar(); } }, 'Esto no es lo que pedí');
      }
    }
    return h('section', { class: 'tarjeta compra ' + (pagada ? 'pagada' : 'por-pagar'), 'data-campo': 'compra' },
      h('div', { class: 'compra-cabecera' },
        h('p', { class: 'rotulo' }, 'Tu compra'),
        h('span', { class: 'pastilla ' + (pagada ? 'pagado' : 'por-pagar'), 'data-campo': 'estado-compra' }, pagada ? 'Pagado' : 'Por pagar')),
      h('ul', { class: 'lineas' }, lineas),
      c.descuento_cop > 0 ? h('p', { class: 'ahorro' }, 'Descuento −' + fmtCop(c.descuento_cop)) : null,
      h('p', { class: 'total' }, 'Total ', h('strong', { class: 'mono', 'data-campo': 'total' }, fmtCop(c.total_cop))),
      pagada
        ? h('p', { class: 'ok', 'data-campo': 'puntos-ganados' }, c.puntos_ganados > 0 ? '¡Sumaste ' + c.puntos_ganados + (c.puntos_ganados === 1 ? ' punto!' : ' puntos!') : 'Gracias por tu compra.')
        : h('p', { class: 'pequeno' }, 'Paga en el mostrador: efectivo, datáfono o transferencia.'),
      reporte);
  }

  // Tras la primera compra pagada se piden, una vez, celular y cumpleaños (opcionales y con motivo).
  function tarjetaPerfilPendiente() {
    const p = e.perfil;
    if (!p || p.compras_pagadas < 1 || p.celular || p.cumpleanos || leerAlmacen(CLAVE_PERFIL_DESCARTADO)) return null;
    const errorEl = h('p', { class: 'error', role: 'alert' });
    const b = e.borrador;
    return h('section', { class: 'tarjeta', 'data-campo': 'pedir-perfil' },
      h('p', { class: 'rotulo' }, 'Para sorprenderte'),
      h('p', null, 'Cuéntanos tu cumpleaños y te avisamos de un detalle ese día. Tu celular nos sirve para ayudarte si pierdes el acceso. Son datos opcionales.'),
      formPerfil(errorEl, true),
      h('button', { type: 'button', class: 'btn btn-texto', 'data-accion': 'perfil-ahora-no', onclick: () => { escribirAlmacen(CLAVE_PERFIL_DESCARTADO, '1'); b.celular = undefined; b.cumpleanos = undefined; pintar(); } }, 'Ahora no'));
  }

  function formPerfil(errorEl, desdeTarjeta) {
    const p = e.perfil;
    const b = e.borrador;
    return h('form', { class: 'form-perfil', 'data-form': 'perfil', onsubmit: async (ev) => {
      ev.preventDefault();
      const celular = (b.celular !== undefined ? b.celular : (p.celular || '')).trim();
      const cumple = b.cumpleanos !== undefined ? b.cumpleanos : (p.cumpleanos || '');
      if (!celular && !cumple) { errorEl.textContent = 'Escribe al menos un dato.'; return; }
      await accion(async () => {
        await api.actualizarPerfil(celular, cumple);
        e.perfil = await api.perfil();
        b.celular = undefined; b.cumpleanos = undefined;
        aviso('ok', 'Guardamos tus datos. ¡Gracias!');
      }, errorEl, pintar);
    } },
      h('label', null, 'Celular', h('input', { type: 'tel', name: 'celular', autocomplete: 'tel', value: b.celular !== undefined ? b.celular : (p.celular || ''), 'data-campo': 'celular', oninput: (ev) => { b.celular = ev.target.value; } })),
      h('label', null, 'Cumpleaños', h('input', { type: 'date', name: 'cumpleanos', value: b.cumpleanos !== undefined ? b.cumpleanos : (p.cumpleanos || ''), 'data-campo': 'cumpleanos', oninput: (ev) => { b.cumpleanos = ev.target.value; } })),
      h('button', { type: 'submit', class: 'btn btn-primario', 'data-accion': 'guardar-perfil' }, desdeTarjeta ? 'Guardar' : 'Guardar mis datos'),
      errorEl);
  }

  function vistaInicio() {
    return h('div', { class: 'vista', 'data-vista': 'inicio' },
      h('h2', null, e.perfil ? 'Hola, ' + e.perfil.nombre_pila : 'Hola'),
      tarjetaCompra(),
      tarjetaCheckin(),
      tarjetaSaldo(),
      tarjetaPerfilPendiente());
  }

  // ------------------------------------------------------------------ Premios
  function vistaPremios() {
    const um = (e.reglas && e.reglas.umbrales) || {};
    const pct = e.reglas ? e.reglas.descuento_pct : 50;
    const dias = e.reglas ? e.reglas.voucher_dias : 45;
    const confirmando = e.borrador.canjeando;
    const errorEl = h('p', { class: 'error', role: 'alert' });
    const filas = Object.entries(um).sort((a, b) => a[1] - b[1]).map(([tam, meta]) => {
      const alcanza = e.saldo >= meta;
      return h('li', { class: 'premio', 'data-premio': tam },
        h('div', null, h('strong', null, 'Bowl ' + nombreTamano(tam)), h('small', null, pct + '% de descuento · ' + meta + ' puntos')),
        alcanza
          ? h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'canjear-' + tam, onclick: () => { e.borrador.canjeando = tam; pintar(); } }, 'Canjear')
          : h('span', { class: 'pequeno', 'data-campo': 'faltan-' + tam }, 'Te faltan ' + (meta - Math.max(0, e.saldo))));
    });
    const panel = confirmando
      ? h('div', { class: 'tarjeta confirmar', 'data-campo': 'confirmar-canje' },
        h('p', null, '¿Canjear ' + um[confirmando] + ' puntos por ' + pct + '% de descuento en un bowl ' + nombreTamano(confirmando) + '? Tendrás ' + dias + ' días para usarlo.'),
        h('div', { class: 'fila-botones' },
          h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'confirmar-canje', onclick: () => accion(async () => {
            const r = await api.canjear(confirmando);
            e.borrador.canjeando = null;
            aviso('ok', '¡Listo! Canjeaste ' + r.puntos_descontados + ' puntos. Díselo al vendedor cuando pidas.');
            await refrescarCuenta();
          }, errorEl, pintar) }, 'Sí, canjear'),
          h('button', { type: 'button', class: 'btn', 'data-accion': 'cancelar-canje', onclick: () => { e.borrador.canjeando = null; pintar(); } }, 'Ahora no')),
        errorEl)
      : null;
    const vales = e.vouchers.length
      ? e.vouchers.map((w) => h('li', { class: 'voucher', 'data-voucher': w.id },
        h('div', null,
          h('strong', null, w.tipo === 'bienvenida' ? 'Regalo de bienvenida' : 'Premio'),
          h('small', null, etiquetaVoucher(w))),
        h('span', { class: 'pequeno' }, 'Vence el ' + fechaCorta(w.vence_en, ahora()))))
      : [h('li', { class: 'vacio', 'data-campo': 'sin-premios' }, 'Todavía no tienes premios listos.')];
    return h('div', { class: 'vista', 'data-vista': 'premios' },
      h('h2', null, 'Premios'),
      e.aviso ? h('p', { class: 'aviso ' + e.aviso.tipo, role: 'status' }, e.aviso.texto) : null,
      h('section', { class: 'tarjeta' }, h('p', { class: 'rotulo' }, 'Canjea tus puntos'), h('ul', { class: 'lista' }, filas), panel),
      h('section', { class: 'tarjeta' }, h('p', { class: 'rotulo' }, 'Tus premios y regalos'), h('p', { class: 'pequeno' }, 'Díselo al vendedor al pedir y lo aplica.'), h('ul', { class: 'lista' }, vales)));
  }

  // ------------------------------------------------------------------ Historial
  function vistaHistorial() {
    const movs = e.movimientos.length
      ? e.movimientos.map((m) => h('li', { class: 'movimiento' },
        h('div', null, h('strong', null, MOVIMIENTOS[m.tipo] || m.tipo), h('small', null, fechaCorta(m.creado_en, ahora()))),
        h('span', { class: 'mono ' + (m.puntos > 0 ? 'ok' : 'resta') }, (m.puntos > 0 ? '+' : '') + m.puntos)))
      : [h('li', { class: 'vacio', 'data-campo': 'sin-movimientos' }, 'Aún no tienes movimientos de puntos.')];
    const compras = e.compras.length
      ? e.compras.map((c) => h('li', { class: 'compra-hist', 'data-venta': c.venta_id },
        h('div', null,
          h('strong', null, fechaCorta(c.pagada_en, ahora()) + ' · ' + fmtCop(c.total_cop)),
          h('small', null, (c.lineas || []).map((l) => (l.cantidad > 1 ? l.cantidad + ' × ' : '') + l.producto + (l.tamano ? ' ' + nombreTamano(l.tamano) : '')).join(', ')),
          h('small', null, (MEDIOS[c.medio_pago] || c.medio_pago || '') + (c.puntos ? ' · +' + c.puntos + ' puntos' : ''))),
        null))
      : [h('li', { class: 'vacio', 'data-campo': 'sin-compras' }, 'Todavía no tienes compras registradas en tu cuenta.')];
    return h('div', { class: 'vista', 'data-vista': 'historial' },
      h('h2', null, 'Historial'),
      h('section', { class: 'tarjeta' }, h('p', { class: 'rotulo' }, 'Tus compras'), h('ul', { class: 'lista' }, compras)),
      h('section', { class: 'tarjeta' }, h('p', { class: 'rotulo' }, 'Tus puntos'), h('ul', { class: 'lista' }, movs)));
  }

  // ------------------------------------------------------------------ Perfil
  function vistaPerfil() {
    const p = e.perfil;
    const errorEl = h('p', { class: 'error', role: 'alert' });
    const errorMsg = h('p', { class: 'error', role: 'alert' });
    const mensajes = h('input', { type: 'checkbox', 'data-campo': 'mensajes', checked: p.acepta_mensajes ? true : null });
    mensajes.checked = !!p.acepta_mensajes;
    mensajes.addEventListener('change', () => accion(async () => {
      await api.consentir('mensajes', p.privacidad_version, mensajes.checked);
      e.perfil = await api.perfil();
      aviso('ok', mensajes.checked ? 'Listo, te escribiremos con novedades.' : 'Listo, no te escribiremos.');
    }, errorMsg, pintar));
    return h('div', { class: 'vista', 'data-vista': 'perfil' },
      h('h2', null, 'Mi perfil'),
      e.aviso ? h('p', { class: 'aviso ' + e.aviso.tipo, role: 'status' }, e.aviso.texto) : null,
      h('section', { class: 'tarjeta' },
        h('p', { class: 'rotulo' }, 'Tu cuenta'),
        h('p', null, h('strong', null, p.nombre)),
        h('p', { class: 'pequeno' }, e.sesion ? e.sesion.email : '')),
      h('section', { class: 'tarjeta' }, h('p', { class: 'rotulo' }, 'Tus datos'), formPerfil(errorEl, false)),
      h('section', { class: 'tarjeta' },
        h('p', { class: 'rotulo' }, 'Privacidad'),
        h('label', { class: 'casilla' }, mensajes, h('span', null, 'Quiero recibir mensajes de Naidi con novedades y recordatorios.')),
        errorMsg,
        h('p', { class: 'pequeno' }, h('a', { href: '/privacidad/', target: '_blank', rel: 'noopener' }, 'Política de privacidad'))),
      h('button', { type: 'button', class: 'btn', 'data-accion': 'salir', onclick: salir }, 'Cerrar sesión'));
  }

  // ------------------------------------------------------------------ Armazón y navegación
  const PESTANAS = [['inicio', 'Inicio'], ['premios', 'Premios'], ['historial', 'Historial'], ['perfil', 'Perfil']];

  function irA(nombre) {
    if (nombre !== e.pestana) aviso(null);   // los avisos son de una acción reciente: no se arrastran a otra sección
    e.pestana = nombre;
    if (nombre !== 'premios') e.borrador.canjeando = null;
    if (nombre === 'historial') refrescarHistorial().then(pintar);
    pintar();
  }

  function pantallaPrincipal() {
    const vista = { inicio: vistaInicio, premios: vistaPremios, historial: vistaHistorial, perfil: vistaPerfil }[e.pestana]();
    return h('div', { class: 'app' },
      h('header', { class: 'cabecera' }, marca()),
      e.aviso && e.pestana === 'inicio' ? h('p', { class: 'aviso ' + e.aviso.tipo, role: 'status', 'data-campo': 'aviso' },
        e.aviso.texto, h('button', { type: 'button', class: 'cerrar', 'aria-label': 'Cerrar aviso', onclick: () => { aviso(null); pintar(); } }, '×')) : null,
      h('main', { class: 'principal' }, vista),
      h('nav', { class: 'pestanas', 'aria-label': 'Secciones' },
        PESTANAS.map(([n, rotulo]) => h('button', { type: 'button', class: 'pestana' + (e.pestana === n ? ' activa' : ''), 'data-pestana': n, onclick: () => irA(n) }, rotulo))));
  }

  function pintar() {
    vaciar(raiz);
    let nodo;
    if (e.pantalla === 'acceso') nodo = pantallaAcceso();
    else if (e.pantalla === 'consentimiento') nodo = pantallaConsentimiento();
    else if (e.pantalla === 'inicio') nodo = pantallaPrincipal();
    else if (e.pantalla === 'error') {
      nodo = h('main', { class: 'acceso' }, marca(), h('h1', null, 'No pudimos abrir tu cuenta'), h('p', { class: 'error', role: 'alert', 'data-campo': 'error' }, e.error),
        h('button', { type: 'button', class: 'btn', 'data-accion': 'salir', onclick: salir }, 'Salir'));
    } else nodo = h('main', { class: 'acceso' }, marca(), h('p', { 'data-campo': 'cargando' }, 'Cargando…'));
    raiz.append(nodo);
  }

  // ------------------------------------------------------------------ Datos
  async function refrescarCuenta() {
    const [saldo, vouchers, perfil] = await Promise.all([api.saldo(), api.vouchers(), api.perfil()]);
    e.saldo = saldo; e.vouchers = vouchers || []; e.perfil = perfil;
    await refrescarHistorial();
  }

  async function refrescarHistorial() {
    try {
      const [movs, compras] = await Promise.all([api.movimientos(), api.compras()]);
      e.movimientos = movs || []; e.compras = compras || [];
    } catch (x) { /* el historial puede esperar */ }
  }

  async function sondear() {
    if (e.pantalla !== 'inicio') return;
    let compra, checkin;
    try {
      [compra, checkin] = await Promise.all([api.compraEnCurso(), api.miCheckin()]);
    } catch (x) { return; }
    const firma = JSON.stringify([compra, checkin]);
    if (firma === e.firmaSondeo) return;
    const antes = e.compra;
    e.firmaSondeo = firma;
    e.compra = compra || null;
    e.checkin = checkin || null;
    // La compra pasó a Pagada: el servidor acaba de acreditar los puntos; se actualizan saldo, premios e historial.
    if (e.compra && e.compra.estado === 'pagada' && (!antes || antes.estado !== 'pagada')) {
      try { await refrescarCuenta(); } catch (x) { /* se verá en el próximo sondeo */ }
    }
    pintar();
  }

  function iniciarSondeo() {
    if (e.temporizador) parar(e.temporizador);
    e.temporizador = cadaTanto(sondear, intervaloMs);
  }

  // ------------------------------------------------------------------ Flujo de entrada
  // Los QR llevan el token en el fragmento (#entrada= o #qr=): no viaja al servidor ni a los registros.
  function leerQrDeLaUrl() {
    const hash = String(leerHash() || '');
    const m = /(?:^#|&)(entrada|qr)=([^&]*)/.exec(hash);
    if (!m) return;
    limpiarHash();
    let token = m[2];
    try { token = decodeURIComponent(token); } catch (x) { /* queda como vino */ }
    const valido = m[1] === 'entrada' ? FORMATO_ENTRADA.test(token) : FORMATO_QR.test(token);
    if (!valido) {
      aviso('error', m[1] === 'entrada' ? 'Este QR de entrada no es válido. Escanea el que está en la tienda.' : 'Este QR no es válido, ya se usó o venció.');
      return;
    }
    escribirAlmacen(CLAVE_PENDIENTE, JSON.stringify({ tipo: m[1], token }));
  }

  async function procesarPendiente() {
    const crudo = leerAlmacen(CLAVE_PENDIENTE);
    if (!crudo) return;
    borrarAlmacen(CLAVE_PENDIENTE);   // se borra antes de usarlo: si algo falla, no se repite en bucle
    let p;
    try { p = JSON.parse(crudo); } catch (x) { return; }
    try {
      if (p.tipo === 'entrada') {
        const r = await api.hacerCheckin(p.token);
        aviso('ok', r.cliente_nuevo
          ? '¡Bienvenido a Naidí! Ya estás en la lista y tienes un regalo de bienvenida esperándote.'
          : (r.ya_estaba ? 'Ya estabas en la lista. El vendedor te verá en un momento.' : '¡Listo! Ya estás en la lista. El vendedor te verá en un momento.'));
      } else {
        const r = await api.reclamarQr(p.token);
        aviso('ok', r.puntos_acreditados > 0 ? '¡Listo! Sumaste ' + r.puntos_acreditados + (r.puntos_acreditados === 1 ? ' punto' : ' puntos') + ' a tu cuenta.' : 'Listo, esa compra quedó en tu cuenta.');
      }
    } catch (x) {
      aviso('error', x.name === 'ErrorRed' ? 'No hay conexión. Vuelve a escanear el QR cuando tengas internet.' : x.message);
    }
  }

  async function recargarPerfilYSeguir() {
    e.perfil = await api.perfil();
    await abrirCuenta();
  }

  async function abrirCuenta() {
    if (!e.perfil.acepta_datos) { e.pantalla = 'consentimiento'; pintar(); return; }
    await procesarPendiente();
    try {
      e.reglas = await api.reglas();
      await refrescarCuenta();
      [e.compra, e.checkin] = await Promise.all([api.compraEnCurso(), api.miCheckin()]);
      e.compra = e.compra || null; e.checkin = e.checkin || null;
      e.firmaSondeo = JSON.stringify([e.compra, e.checkin]);
    } catch (x) {
      e.pantalla = 'error';
      e.error = x.name === 'ErrorRed' ? 'No hay conexión. Revisa tu internet e inténtalo de nuevo.' : x.message;
      pintar();
      return;
    }
    e.pantalla = 'inicio';
    e.pestana = 'inicio';
    pintar();
    iniciarSondeo();
  }

  async function continuarConSesion() {
    e.pantalla = 'cargando';
    pintar();
    try {
      e.perfil = await api.perfil();
    } catch (x) {
      e.pantalla = 'error';
      e.error = x.name === 'ErrorRed' ? 'No hay conexión. Revisa tu internet e inténtalo de nuevo.' : x.message;
      pintar();
      return;
    }
    await abrirCuenta();
  }

  async function salir() {
    if (e.temporizador) { parar(e.temporizador); e.temporizador = null; }
    try { await api.salir(); } catch (x) { /* ok */ }
    borrarAlmacen(CLAVE_PENDIENTE);
    Object.assign(e, { sesion: null, perfil: null, reglas: null, saldo: 0, vouchers: [], compra: null, checkin: null, movimientos: [], compras: [], aviso: null, error: '', paso: 'correo', correo: '', borrador: {}, firmaSondeo: '' });
    e.pantalla = 'acceso';
    pintar();
  }

  async function iniciar() {
    leerQrDeLaUrl();
    pintar();
    try { e.sesion = await api.sesion(); } catch (x) { e.sesion = null; }
    if (!e.sesion) { e.pantalla = 'acceso'; pintar(); return; }
    await continuarConSesion();
  }

  if (typeof document !== 'undefined' && !cfg.sinEventos) {
    document.addEventListener('visibilitychange', () => { if (!document.hidden && e.pantalla === 'inicio') sondear(); });
  }

  return { iniciar, estado: e, sondear, salir };
}
