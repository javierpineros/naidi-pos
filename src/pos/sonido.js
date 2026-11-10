// Aviso sonoro del POS. Los navegadores bloquean el audio hasta que la persona interactúa,
// por eso hay un botón "Activar sonido" al abrir el turno. La señal tiene límite de frecuencia
// y SIEMPRE va acompañada de una alerta visual (la pone la lista, no este módulo).
export function crearSonido(opciones) {
  const o = opciones || {};
  const crearContexto =
    o.crearContexto ||
    (() => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      return Ctx ? new Ctx() : null;
    });
  const ahora = o.ahora || (() => Date.now());
  const minIntervaloMs = o.minIntervaloMs === undefined ? 20000 : o.minIntervaloMs;
  const maxPorMinuto = o.maxPorMinuto === undefined ? 3 : o.maxPorMinuto;

  let ctx = null;
  let activo = false;
  let ultimo = -Infinity;
  let recientes = [];

  function tono(frecuencia, inicio, duracion) {
    const osc = ctx.createOscillator();
    const ganancia = ctx.createGain();
    osc.frequency.value = frecuencia;
    ganancia.gain.value = 0.15;
    osc.connect(ganancia);
    ganancia.connect(ctx.destination);
    osc.start(ctx.currentTime + inicio);
    osc.stop(ctx.currentTime + inicio + duracion);
  }

  return {
    activar() {
      try {
        ctx = ctx || crearContexto();
        if (!ctx) return false;
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
        tono(1, 0, 0.01); // tono inaudible: "desbloquea" el audio
        activo = true;
      } catch (e) {
        activo = false;
      }
      return activo;
    },
    activo: () => activo,
    // true si sonó; false si el sonido no está activo o se pasó del límite de frecuencia.
    alertar() {
      if (!activo || !ctx) return false;
      const t = ahora();
      recientes = recientes.filter((x) => t - x < 60000);
      if (t - ultimo < minIntervaloMs || recientes.length >= maxPorMinuto) return false;
      try {
        tono(880, 0, 0.18);
        tono(1175, 0.22, 0.25);
      } catch (e) {
        return false;
      }
      ultimo = t;
      recientes.push(t);
      return true;
    },
  };
}
