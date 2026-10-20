/*
 * Page renderer shared by the document converters (Word, OpenDocument).
 * flowToPdf() lays HTML out across fixed-size pages; pagesToPdf() takes pages that are already
 * built (slides). Each page is captured with html2canvas and placed into a PDF with pdf-lib.
 */
(function () {
  'use strict';
  const U = window.Util;
  const PT_PER_MM = 72 / 25.4;
  const SPLITTABLE = /^(TABLE|UL|OL)$/;

  function overflows(el) {
    return el.scrollHeight > el.clientHeight + 1;
  }

  /** Continue on a new page with `node`, bringing along any headings that would be stranded at the bottom. */
  function breakBefore(node, body, newPage) {
    node.remove();
    const carry = [];
    let last = body.lastChild;
    while (last && /^H[1-6]$/.test(last.tagName) && last.previousSibling) {
      carry.unshift(last);
      last = last.previousSibling;
    }
    carry.forEach((n) => n.remove());
    const next = newPage();
    next.append(...carry, node);
    return next;
  }

  /** Flow a table or list across as many pages as it needs, row by row, starting on the current page. */
  function splitAcrossPages(node, body, newPage) {
    const isTable = node.tagName === 'TABLE';
    const isOl = node.tagName === 'OL';
    const head = isTable ? node.tHead : null;
    const items = isTable ? [...node.rows].filter((r) => !head || !head.contains(r)) : [...node.children];
    let number = isOl ? node.start || 1 : 0;
    const shell = () => {
      const c = node.cloneNode(false);
      if (isTable) {
        const cols = node.querySelector(':scope > colgroup');
        if (cols) c.appendChild(cols.cloneNode(true));
        if (head) c.appendChild(head.cloneNode(true));
        c.appendChild(document.createElement('tbody'));
      }
      if (isOl) c.start = number;
      return c;
    };

    let part = shell();
    node.replaceWith(part);
    let target = isTable ? part.tBodies[0] : part;
    for (const item of items) {
      target.appendChild(item);
      if (overflows(body)) {
        if (target.children.length > 1) {
          target.removeChild(item);
          body = newPage();
          part = shell();
          body.appendChild(part);
          target = isTable ? part.tBodies[0] : part;
          target.appendChild(item);
        } else if (part.previousSibling) {
          body = breakBefore(part, body, newPage); // not even one row fits here
        }
      }
      if (!isTable && item.value) number = item.value;
      number++;
    }
    return body;
  }

  /** Multiply every absolute font size inside `root` by k (used to shrink text so it fits). */
  function scaleFonts(root, k) {
    const base = parseFloat(getComputedStyle(root).fontSize);
    for (const el of root.querySelectorAll('*')) {
      const m = /^([\d.]+)(pt|px)$/.exec(el.style.fontSize);
      if (m) el.style.fontSize = `${parseFloat(m[1]) * k}${m[2]}`;
    }
    root.style.fontSize = `${base * k}px`;
  }

  /** Shrink wide content (e.g. spreadsheets) so it fits the page width. */
  function shrinkToWidth(el, body) {
    const parent = el.parentNode;
    const next = el.nextSibling;
    body.appendChild(el);
    const avail = body.clientWidth;
    for (let i = 0; i < 4; i++) {
      const width = Math.max(el.scrollWidth, el.offsetWidth);
      if (width <= avail + 1) break;
      const size = parseFloat(getComputedStyle(el).fontSize);
      const k = Math.max(avail / width, 6.5 / size); // never smaller than ~5pt text
      if (k >= 1) break;
      el.style.fontSize = `${size * k}px`;
    }
    parent.insertBefore(el, next);
  }

  /** Shrink text inside slide boxes marked as "shrink on overflow". */
  function shrinkToFit(box) {
    for (let i = 0; i < 12 && overflows(box); i++) scaleFonts(box, 0.92);
  }

  function makeStage() {
    const stage = document.createElement('div');
    stage.className = 'render-stage';
    document.body.appendChild(stage);
    return stage;
  }

  function makePage(stage, layout, contentClass) {
    const m = layout.margin;
    const page = document.createElement('div');
    page.className = 'render-page';
    page.style.cssText = `width:${layout.width}mm;height:${layout.height}mm;padding:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;` +
      `--inner-h:${layout.height - m.top - m.bottom}mm`;
    const body = document.createElement('div');
    body.className = contentClass;
    page.appendChild(body);
    stage.appendChild(page);
    return { page, body };
  }

  const loadImages = (root) =>
    Promise.all([...root.querySelectorAll('img')].map((img) => U.whenLoaded(img).catch(() => img.remove())));

  /** Capture [{ el, width, height }] (sizes in mm) one page at a time into a PDF. */
  async function capture(stage, pages, onPage) {
    const [html2canvas, { PDFDocument }] = await Promise.all([U.lib('html2canvas'), U.lib('pdfLib')]);
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages.length; i++) {
      const { el, width, height } = pages[i];
      if (onPage) onPage(i, pages.length);
      stage.replaceChildren(el); // render each page on its own, at the top of the stage
      el.querySelectorAll('.shrink-to-fit').forEach(shrinkToFit);
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', logging: false, scrollX: 0, scrollY: 0 });
      const jpg = await U.canvasToBlob(canvas, 'image/jpeg', 0.88);
      const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      const w = width * PT_PER_MM;
      const h = height * PT_PER_MM;
      doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  /**
   * Lay out HTML (a string or a container element) on pages and return a PDF blob.
   * layout: { width, height, margin: { top, right, bottom, left } } in mm.
   * Elements with data-page-break="before|after" force page breaks; `.fit-width` elements are
   * shrunk to the page width (and with autoLandscape the page turns sideways for wide content).
   */
  async function flowToPdf(content, layout, { contentClass, autoLandscape = false, onPage } = {}) {
    let source = content;
    if (typeof content === 'string') {
      source = document.createElement('div');
      source.innerHTML = content || '<p></p>';
    }
    await loadImages(source);

    const stage = makeStage();
    try {
      let lay = layout;
      const wide = [...source.querySelectorAll('.fit-width')];
      if (wide.length) {
        const probe = makePage(stage, lay, contentClass);
        if (autoLandscape && lay.height > lay.width) {
          const avail = probe.body.clientWidth;
          const widest = Math.max(...wide.map((el) => {
            const parent = el.parentNode;
            const next = el.nextSibling;
            probe.body.appendChild(el);
            const w = Math.max(el.scrollWidth, el.offsetWidth);
            parent.insertBefore(el, next);
            return w;
          }));
          if (widest > avail * 1.15) lay = { ...lay, width: lay.height, height: lay.width };
        }
        probe.page.remove();
        const sized = makePage(stage, lay, contentClass);
        wide.forEach((el) => shrinkToWidth(el, sized.body));
        sized.page.remove();
      }

      const pages = [];
      const newPage = () => {
        const { page, body } = makePage(stage, lay, contentClass);
        pages.push(page);
        return body;
      };

      let body = newPage();
      let pendingBreak = false;
      for (const node of [...source.childNodes]) {
        const brk = node.nodeType === 1 ? node.dataset.pageBreak : '';
        if ((pendingBreak || brk === 'before') && body.childNodes.length) body = newPage();
        pendingBreak = brk === 'after';
        body.appendChild(node);
        if (!overflows(body)) continue;
        if (SPLITTABLE.test(node.tagName)) body = splitAcrossPages(node, body, newPage);
        else if (node.previousSibling) body = breakBefore(node, body, newPage);
        // else: a single block taller than a page — it is clipped rather than looping forever
      }

      return await capture(stage, pages.map((el) => ({ el, width: lay.width, height: lay.height })), onPage);
    } finally {
      stage.remove();
    }
  }

  /** Render pages that are already laid out ([{ el, width, height }], sizes in mm). */
  async function pagesToPdf(pages, { onPage } = {}) {
    await Promise.all(pages.map((p) => loadImages(p.el)));
    const stage = makeStage();
    try {
      return await capture(stage, pages, onPage);
    } finally {
      stage.remove();
    }
  }

  window.Render = { flowToPdf, pagesToPdf };
})();
