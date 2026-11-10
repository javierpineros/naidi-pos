// Cola de ventas hechas sin internet. Se guardan localmente (sin cliente, ya cobradas) y se sincronizan después.
// Cada venta lleva su clave de idempotencia: reenviarla nunca la duplica en el servidor.
import { esErrorRed } from '../lib/errores.js';

export function almacenLocal(storage, clave) {
  return {
    leer() {
      try {
        const t = storage.getItem(clave);
        return Promise.resolve(t ? JSON.parse(t) : []);
      } catch (e) {
        return Promise.resolve([]);
      }
    },
    escribir(lista) {
      try {
        storage.setItem(clave, JSON.stringify(lista));
      } catch (e) {
        return Promise.reject(new Error('No hay espacio para guardar la venta en este dispositivo.'));
      }
      return Promise.resolve();
    },
  };
}

export function almacenMemoria() {
  let lista = [];
  return {
    leer: () => Promise.resolve(JSON.parse(JSON.stringify(lista))),
    escribir: (l) => {
      lista = JSON.parse(JSON.stringify(l));
      return Promise.resolve();
    },
  };
}

export function crearCola({ almacen, ahora }) {
  const reloj = ahora || (() => new Date().toISOString());
  let enCurso = null;

  return {
    // venta: { idem, lineas:[{producto,tamano,presentacion,base,toppings,cantidad}], medio, efectivo_recibido?, total_estimado }
    async encolar(venta) {
      const lista = await almacen.leer();
      if (lista.some((x) => x.idem === venta.idem)) return lista.length;
      lista.push({ ...venta, creada_en: venta.creada_en || reloj(), intentos: 0, error: null });
      await almacen.escribir(lista);
      return lista.length;
    },
    pendientes: () => almacen.leer(),

    // Envía en orden. Se detiene al primer fallo de red (sigue sin conexión). Un rechazo del servidor
    // deja la venta marcada con su motivo para que el dueño la revise; no se pierde ni se reintenta en bucle.
    async sincronizar(api) {
      if (enCurso) return enCurso;
      enCurso = (async () => {
        const res = { enviadas: 0, duplicadas: 0, rechazadas: 0, sinConexion: false };
        const lista = await almacen.leer();
        const resto = [];
        for (let i = 0; i < lista.length; i++) {
          const v = lista[i];
          if (v.error) {
            resto.push(v);
            continue;
          }
          try {
            const r = await api.registrarVentaOffline(v);
            if (r && r.duplicada) res.duplicadas++;
            else res.enviadas++;
          } catch (e) {
            if (esErrorRed(e)) {
              res.sinConexion = true;
              resto.push({ ...v, intentos: v.intentos + 1 }, ...lista.slice(i + 1));
              break;
            }
            res.rechazadas++;
            resto.push({ ...v, intentos: v.intentos + 1, error: e.message });
          }
        }
        await almacen.escribir(resto);
        return res;
      })();
      try {
        return await enCurso;
      } finally {
        enCurso = null;
      }
    },
  };
}
