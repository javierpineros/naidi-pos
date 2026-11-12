// Acceso del personal: correo + código de 6 dígitos. El dueño, además, verifica en dos pasos (TOTP).
import { h, vaciar } from '../../lib/dom.js';

// `soloDueno` lo usa el panel: una cuenta de cajero entra al POS pero no al panel.
export function montarAcceso({ api, contenedor, alListo, titulo, soloDueno }) {
  const zona = h('div', { class: 'acceso-zona' });
  const error = h('p', { class: 'error', role: 'alert', 'data-zona': 'error' });
  contenedor.append(h('section', { class: 'acceso' }, h('h1', { class: 'titulo' }, titulo || 'Naidi POS'), zona, error));
  let correo = '';
  let ocupado = false;

  const mostrarError = (e) => {
    error.textContent = e ? (e.message || String(e)) : '';
  };

  async function protegido(fn) {
    if (ocupado) return;
    ocupado = true;
    mostrarError(null);
    try {
      await fn();
    } catch (e) {
      mostrarError(e.name === 'ErrorRed' ? 'Sin conexión. Revisa el internet e inténtalo de nuevo.' : e);
    } finally {
      ocupado = false;
    }
  }

  function campo(etiqueta, atributos) {
    const input = h('input', { autocomplete: 'off', ...atributos });
    return { input, fila: h('label', null, etiqueta, input) };
  }

  function pasoCorreo() {
    const c = campo('Correo del personal', { type: 'email', 'data-campo': 'correo', inputmode: 'email', autocapitalize: 'off' });
    vaciar(zona).append(
      c.fila,
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'enviar-codigo', onclick: () => protegido(async () => {
        correo = c.input.value.trim();
        if (!correo) throw new Error('Escribe tu correo.');
        await api.enviarCodigo(correo);
        pasoCodigo();
      }) }, 'Enviar código')
    );
  }

  function pasoCodigo() {
    const c = campo('Código de 6 dígitos que te llegó al correo', { type: 'text', 'data-campo': 'codigo', inputmode: 'numeric', maxlength: '6' });
    vaciar(zona).append(
      c.fila,
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'verificar-codigo', onclick: () => protegido(async () => {
        await api.verificarCodigo(correo, c.input.value.trim());
        await tras();
      }) }, 'Entrar'),
      h('button', { type: 'button', class: 'btn', 'data-accion': 'otro-correo', onclick: pasoCorreo }, 'Usar otro correo')
    );
  }

  async function tras() {
    const ses = await api.sesion();
    if (!ses) throw new Error('No se pudo iniciar la sesión.');
    const perfil = await api.miPerfilDePersonal(ses.id);
    if (!perfil) {
      await api.salir();
      pasoCorreo();
      throw new Error('Esta cuenta no tiene acceso al POS. Habla con el dueño.');
    }
    if (soloDueno && perfil.rol !== 'dueno') {
      await api.salir();
      pasoCorreo();
      throw new Error('Esta sección es solo para el dueño.');
    }
    if (perfil.rol === 'dueno' && ses.nivel !== 'aal2') {
      const factor = await api.mfaFactor();
      if (factor) return pasoMfa(factor, ses, perfil);
      const alta = await api.mfaEnrolar();
      return pasoEnrolar(alta, ses, perfil);
    }
    alListo({ ses, perfil });
  }

  function pasoMfa(factorId, ses, perfil) {
    const c = campo('Código de tu app de verificación', { type: 'text', 'data-campo': 'mfa', inputmode: 'numeric', maxlength: '6' });
    vaciar(zona).append(
      h('p', null, 'Como dueño, confirma que eres tú.'),
      c.fila,
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'verificar-mfa', onclick: () => protegido(async () => {
        await api.mfaVerificar(factorId, c.input.value.trim());
        alListo({ ses: await api.sesion(), perfil });
      }) }, 'Verificar')
    );
  }

  function pasoEnrolar(alta, ses, perfil) {
    const c = campo('Código de 6 dígitos que muestra la app', { type: 'text', 'data-campo': 'mfa', inputmode: 'numeric', maxlength: '6' });
    vaciar(zona).append(
      h('p', null, 'Como dueño necesitas verificación en dos pasos. Escanea este código con una app de verificación (Google Authenticator, Authy...).'),
      h('img', { class: 'qr-mfa', src: alta.qr, alt: 'Código QR para tu app de verificación' }),
      h('p', { class: 'mono pequeno' }, 'Si no puedes escanear, escribe esta clave: ' + alta.secreto),
      c.fila,
      h('button', { type: 'button', class: 'btn btn-primario', 'data-accion': 'verificar-mfa', onclick: () => protegido(async () => {
        await api.mfaVerificar(alta.id, c.input.value.trim());
        alListo({ ses: await api.sesion(), perfil });
      }) }, 'Activar y entrar')
    );
  }

  // Si ya hay sesión (recarga de la página), se salta directo al paso que falte.
  protegido(async () => {
    const ses = await api.sesion();
    if (ses) await tras();
    else pasoCorreo();
  });

  return { destruir: () => { if (zona.parentNode && zona.parentNode.parentNode) zona.parentNode.parentNode.removeChild(zona.parentNode); } };
}
