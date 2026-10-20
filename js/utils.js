/* Shared helpers: lazy library loading, file/image/PDF utilities, page-range parsing. */
(function () {
  'use strict';

  const PDFJS_VERSION = '3.11.174';

  // Libraries are loaded on demand, so the home page stays fast.
  const LIBS = {
    pdfLib: { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', global: 'PDFLib' },
    pdfjs: {
      src: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`,
      global: 'pdfjsLib',
      init(lib) {
        lib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
      },
    },
    jszip: { src: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', global: 'JSZip' },
    mammoth: { src: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js', global: 'mammoth' },
    html2canvas: { src: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', global: 'html2canvas' },
    heic2any: { src: 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js', global: 'heic2any' },
    sortable: { src: 'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js', global: 'Sortable' },
    // Official SheetJS build (the npm 0.18.x releases have known security issues).
    sheetjs: { src: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', global: 'XLSX' },
  };

  const pending = {};

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        s.remove();
        reject(new Error('A required component could not be downloaded. Check your internet connection and try again.'));
      };
      document.head.appendChild(s);
    });
  }

  function lib(name) {
    const def = LIBS[name];
    if (!pending[name]) {
      pending[name] = loadScript(def.src).then(() => {
        const g = window[def.global];
        if (!g) throw new Error(`Could not start ${name}.`);
        if (def.init) def.init(g);
        return g;
      });
      pending[name].catch(() => { delete pending[name]; });
    }
    return pending[name];
  }

  /* ---------- small helpers ---------- */

  const tick = () => new Promise((r) => setTimeout(r, 0));

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${parseFloat(n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2))} ${units[i]}`;
  }

  const MIME_EXT = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel.sheet.macroEnabled.12': 'xlsm',
    'application/vnd.ms-excel': 'xls',
    'text/csv': 'csv',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.oasis.opendocument.presentation': 'odp',
    'application/vnd.oasis.opendocument.graphics': 'odg',
  };

  function ext(name) {
    const m = /\.([^./\\]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  const fileExt = (file) => ext(file.name) || MIME_EXT[file.type] || '';
  const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'file';
  const isHeic = (file) => /^image\/hei[cf]/.test(file.type) || ['heic', 'heif'].includes(ext(file.name));

  function uniqueNames(items) {
    const seen = new Map();
    return items.map((it) => {
      const key = it.name.toLowerCase();
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      if (!n) return it;
      const e = ext(it.name);
      return { ...it, name: `${baseName(it.name)} (${n + 1})${e ? '.' + e : ''}` };
    });
  }

  async function zip(items) {
    const JSZip = await lib('jszip');
    const z = new JSZip();
    uniqueNames(items).forEach((it) => z.file(it.name, it.blob));
    return z.generateAsync({ type: 'blob', compression: 'STORE' });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ---------- images ---------- */

  const MAX_DIM = 12000; // stay well inside browser canvas limits

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image — it may be too large.'))), type, quality);
    });
  }

  /** Wait for an <img> to load. (img.decode() never settles while the tab is in the background.) */
  function whenLoaded(img) {
    return new Promise((resolve, reject) => {
      if (img.complete) return img.naturalWidth ? resolve(img) : reject(new Error('Image failed to load'));
      img.addEventListener('load', () => resolve(img), { once: true });
      img.addEventListener('error', reject, { once: true });
    });
  }

  async function loadImage(file) {
    let blob = file;
    if (isHeic(file)) {
      const heic2any = await lib('heic2any');
      try {
        const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
        blob = Array.isArray(out) ? out[0] : out;
      } catch (e) {
        throw new Error(`Couldn't read the HEIC photo "${file.name}".`);
      }
    }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await whenLoaded(img);
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error(`"${file.name}" isn't an image your browser can open.`);
    }
    return { img, release: () => URL.revokeObjectURL(url) };
  }

  /** Decode an image file onto a canvas, optionally scaling it (EXIF rotation is applied by the browser). */
  async function imageToCanvas(file, { scale = 1, maxDim = 0, background = null } = {}) {
    const { img, release } = await loadImage(file);
    try {
      const w0 = img.naturalWidth || 1024;
      const h0 = img.naturalHeight || 1024;
      const limit = Math.min(maxDim || Infinity, MAX_DIM);
      let s = scale;
      if (Math.max(w0, h0) * s > limit) s = limit / Math.max(w0, h0);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w0 * s));
      canvas.height = Math.max(1, Math.round(h0 * s));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      release();
    }
  }

  /** Canvas → 24-bit BMP (browsers can't encode BMP natively). Draw on an opaque background first. */
  function encodeBMP(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rowSize = Math.ceil((w * 3) / 4) * 4;
    const size = 54 + rowSize * h;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    v.setUint16(0, 0x4d42, true); // "BM"
    v.setUint32(2, size, true);
    v.setUint32(10, 54, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, w, true);
    v.setInt32(22, h, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 24, true);
    v.setUint32(34, rowSize * h, true);
    v.setInt32(38, 2835, true);
    v.setInt32(42, 2835, true);
    const bytes = new Uint8Array(buf);
    for (let y = 0; y < h; y++) {
      let o = 54 + (h - 1 - y) * rowSize; // rows are stored bottom-up
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        bytes[o++] = px[i + 2];
        bytes[o++] = px[i + 1];
        bytes[o++] = px[i];
      }
    }
    return new Blob([buf], { type: 'image/bmp' });
  }

  /* ---------- PDFs ---------- */

  async function openPdf(file) {
    const { PDFDocument } = await lib('pdfLib');
    try {
      return await PDFDocument.load(await file.arrayBuffer());
    } catch (e) {
      if (/encrypt/i.test(e.message)) throw new Error(`"${file.name}" is password-protected. Remove the password and try again.`);
      throw new Error(`"${file.name}" doesn't look like a valid PDF.`);
    }
  }

  async function openPdfJs(file) {
    const pdfjs = await lib('pdfjs');
    try {
      return await pdfjs.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        isEvalSupported: false,
        cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`,
      }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new Error(`"${file.name}" is password-protected. Remove the password and try again.`);
      throw new Error(`"${file.name}" doesn't look like a valid PDF.`);
    }
  }

  /** Render one page (1-based) of a pdf.js document. Returns the canvas plus the page size in points. */
  async function renderPdfPage(doc, pageNumber, scale) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const s = Math.min(scale, MAX_DIM / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: s });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // "print" intent renders in one go instead of waiting on requestAnimationFrame,
    // so conversions keep running in background tabs.
    await page.render({ canvasContext: ctx, viewport, intent: 'print', annotationMode: window.pdfjsLib.AnnotationMode.ENABLE }).promise;
    page.cleanup();
    return { canvas, width: base.width, height: base.height };
  }

  async function pdfThumb(file, width = 120) {
    const doc = await openPdfJs(file);
    try {
      const page = await doc.getPage(1);
      const { canvas } = await renderPdfPage(doc, 1, width / page.getViewport({ scale: 1 }).width);
      return { url: canvas.toDataURL('image/jpeg', 0.8), pages: doc.numPages };
    } finally {
      doc.destroy();
    }
  }

  /** Parse "1-3, 5, 8-" into [{from, to, label}] (1-based, inclusive). */
  function parseRanges(input, total) {
    const parts = String(input || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error('Enter the pages you want, for example: 1-3, 5');
    return parts.map((part) => {
      const m = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(part);
      if (!m) throw new Error(`"${part}" isn't a valid page or range. Use a format like 1-3, 5`);
      const from = +m[1];
      const to = m[2] === undefined ? from : m[2] === '' ? total : +m[2];
      const bad = [from, to].find((n) => n < 1 || n > total);
      if (bad !== undefined) throw new Error(`Page ${bad} doesn't exist — this PDF has ${total} page${total === 1 ? '' : 's'}.`);
      if (from > to) throw new Error(`"${part}" goes backwards — write it as ${to}-${from}.`);
      return { from, to, label: from === to ? `${from}` : `${from}-${to}` };
    });
  }

  function rangePages(r) {
    const pages = [];
    for (let i = r.from; i <= r.to; i++) pages.push(i);
    return pages;
  }

  window.Util = {
    lib, tick, formatBytes, ext, fileExt, baseName, isHeic, uniqueNames, zip, download,
    whenLoaded, canvasToBlob, imageToCanvas, encodeBMP,
    openPdf, openPdfJs, renderPdfPage, pdfThumb, parseRanges, rangePages,
  };
})();
