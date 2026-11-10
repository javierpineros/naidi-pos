import qrcode from 'qrcode-generator';

// Devuelve un elemento <svg> con el código QR del texto (el QR lo genera la librería; no se arma HTML a mano).
export function qrSvg(texto, celda) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: celda || 6, margin: 2, scalable: true });
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}
