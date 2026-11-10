// Dos tipos de fallo: sin conexión (se puede reintentar o guardar) y rechazo del servidor (hay que decírselo a la persona).
export class ErrorRed extends Error {
  constructor(mensaje) {
    super(mensaje || 'Sin conexión.');
    this.name = 'ErrorRed';
  }
}

export class ErrorServidor extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.name = 'ErrorServidor';
    this.codigo = codigo || null;
  }
}

export const esErrorRed = (e) => e instanceof ErrorRed;

// Convierte el error de supabase-js en uno de los dos tipos anteriores.
export function traducirError(error) {
  if (!error) return null;
  const msg = String(error.message || '');
  const sinCodigo = !error.code && !error.status;
  if (sinCodigo || /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
    return new ErrorRed('Sin conexión con el servidor.');
  }
  return new ErrorServidor(msg || 'No se pudo completar la acción.', error.code);
}
