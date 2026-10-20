/*
 * Excel → PDF.
 *   .xlsx / .xlsm are read directly (a ZIP of XML), so cell styles survive: fonts, fills, borders,
 *   alignment, merged cells, column widths, row heights, print areas and repeated title rows.
 *   Number formats (currency, dates, percentages…) are applied with SheetJS's formatter.
 *   .xls, .xlsb and .csv are read with SheetJS (values and layout, no colours).
 * Each sheet becomes an HTML table that Render.flowToPdf lays out on pages.
 */
(function () {
  'use strict';
  const U = window.Util;

  const MAX_ROWS = 5000;
  const MAX_COLS = 256;
  const KEY = 20000; // cell key = row * KEY + col (Excel has at most 16,384 columns)
  const GRIDLINE = '1px solid #d4d4d4';
  const PAPER_MM = { 1: [215.9, 279.4], 5: [215.9, 355.6], 8: [297, 420], 9: [210, 297], 11: [148, 210] };
  const BORDER_CSS = {
    thin: '1px solid', hair: '1px dotted', dotted: '1px dotted', dashed: '1px dashed', dashDot: '1px dashed',
    dashDotDot: '1px dashed', medium: '2px solid', mediumDashed: '2px dashed', mediumDashDot: '2px dashed',
    mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed', thick: '3px solid', double: '3px double',
  };
  const FONT_FALLBACKS = {
    Calibri: 'Carlito, Arial', 'Calibri Light': 'Carlito, Arial', Aptos: 'Calibri, Carlito, Arial',
    'Aptos Narrow': '"Arial Narrow", Calibri, Arial', Cambria: 'Caladea, Georgia', Arial: '"Liberation Sans", Helvetica',
    'Times New Roman': '"Liberation Serif", Times', 'Courier New': '"Liberation Mono", Courier',
  };
  const SERIF = /times|cambria|caladea|georgia|garamond|serif/i;
  const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
  const INDEXED = [
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
    '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
    '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
    '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
    '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
    '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  ];

  /* ---------- XML helpers (namespace-agnostic, so "strict" OOXML files work too) ---------- */

  const kids = (el, name) => (el ? [...el.children].filter((c) => !name || c.localName === name) : []);
  const child = (el, name) => (el ? [...el.children].find((c) => c.localName === name) : undefined);
  const all = (doc, name) => (doc ? [...doc.getElementsByTagNameNS('*', name)] : []);
  const first = (doc, name) => all(doc, name)[0];
  const val = (el) => (el ? el.getAttribute('val') : null);
  const flag = (v) => v === '1' || v === 'true';
  const on = (el) => !!el && !/^(0|false|none)$/.test(el.getAttribute('val') || '');
  const unescapeX = (s) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  function relId(el) {
    for (const a of el.attributes) if (a.localName === 'id' && a.namespaceURI) return a.value;
    return null;
  }

  function colIndex(letters) {
    let c = 0;
    for (const ch of letters.toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
    return c - 1;
  }

  function decodeRef(ref) {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref || '');
    return m ? { r: +m[2] - 1, c: colIndex(m[1]) } : null;
  }

  function decodeRange(ref) {
    const [a, b] = String(ref || '').replace(/\$/g, '').split(':');
    const s = decodeRef(a);
    const e = b ? decodeRef(b) : s;
    return s && e ? { r1: Math.min(s.r, e.r), c1: Math.min(s.c, e.c), r2: Math.max(s.r, e.r), c2: Math.max(s.c, e.c) } : null;
  }

  /** First area of a defined name such as "'Sales 2026'!$A$1:$F$40", "$1:$2" or "$A:$C". */
  function parseArea(text) {
    for (const part of String(text || '').split(',')) {
      const ref = part.slice(part.lastIndexOf('!') + 1).replace(/\$/g, '').trim();
      let m;
      if (/^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(ref)) return decodeRange(ref);
      if ((m = /^(\d+):(\d+)$/.exec(ref))) return { r1: +m[1] - 1, r2: +m[2] - 1, c1: 0, c2: Infinity, rowsOnly: true };
      if ((m = /^([A-Z]+):([A-Z]+)$/i.exec(ref))) return { c1: colIndex(m[1]), c2: colIndex(m[2]), r1: 0, r2: Infinity };
    }
    return null;
  }

  /* ---------- colours ---------- */

  function applyTint(hex, tint) {
    let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    let l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
    const hue = (p, q, t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) r = g = b = l;
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      [r, g, b] = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
    }
    return [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  }

  function colorResolver(theme, indexed) {
    return (el) => {
      if (!el || flag(el.getAttribute('auto'))) return null;
      let hex = null;
      if (el.hasAttribute('rgb')) hex = el.getAttribute('rgb').slice(-6);
      else if (el.hasAttribute('theme')) hex = theme[+el.getAttribute('theme')];
      else if (el.hasAttribute('indexed')) hex = indexed[+el.getAttribute('indexed')];
      if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
      const tint = parseFloat(el.getAttribute('tint')) || 0;
      return `#${tint ? applyTint(hex, tint) : hex}`;
    };
  }

  function parseTheme(doc) {
    const scheme = first(doc, 'clrScheme');
    if (!scheme) return DEFAULT_THEME;
    const get = (name, i) => {
      const c = (child(scheme, name) || {}).firstElementChild;
      return (c && (c.getAttribute('lastClr') || c.getAttribute('val'))) || DEFAULT_THEME[i];
    };
    return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(get);
  }

  /* ---------- styles ---------- */

  function parseFont(el, colorOf) {
    if (!el) return null;
    const u = child(el, 'u');
    return {
      name: val(child(el, 'name')) || val(child(el, 'rFont')),
      size: parseFloat(val(child(el, 'sz'))) || null,
      bold: on(child(el, 'b')),
      italic: on(child(el, 'i')),
      strike: on(child(el, 'strike')),
      underline: !!u && val(u) !== 'none',
      color: colorOf(child(el, 'color')),
      vert: val(child(el, 'vertAlign')),
    };
  }

  function parseFill(el, colorOf) {
    const pattern = child(el, 'patternFill');
    if (pattern) {
      const type = pattern.getAttribute('patternType') || 'none';
      if (/^(none|gray125|gray0625)$/.test(type)) return null;
      const fg = colorOf(child(pattern, 'fgColor'));
      if (type === 'solid') return fg;
      return fg || colorOf(child(pattern, 'bgColor')); // other patterns: use the dominant colour
    }
    const gradient = child(el, 'gradientFill');
    if (gradient) return all(gradient, 'stop').map((s) => colorOf(child(s, 'color'))).find(Boolean) || null;
    return null;
  }

  function parseBorder(el, colorOf) {
    const out = {};
    for (const [side, names] of [['left', ['left', 'start']], ['right', ['right', 'end']], ['top', ['top']], ['bottom', ['bottom']]]) {
      const s = names.map((n) => child(el, n)).find(Boolean);
      const style = s && s.getAttribute('style');
      if (style && BORDER_CSS[style]) out[side] = `${BORDER_CSS[style]} ${colorOf(child(s, 'color')) || '#000'}`;
    }
    return out;
  }

  function parseStyles(doc, theme) {
    const custom = kids(first(doc, 'indexedColors'), 'rgbColor').map((c) => (c.getAttribute('rgb') || '').slice(-6));
    const colorOf = colorResolver(theme, custom.length ? custom : INDEXED);
    const numFmts = new Map(kids(first(doc, 'numFmts'), 'numFmt').map((n) => [+n.getAttribute('numFmtId'), n.getAttribute('formatCode')]));
    const fonts = kids(first(doc, 'fonts'), 'font').map((f) => parseFont(f, colorOf));
    const fills = kids(first(doc, 'fills'), 'fill').map((f) => parseFill(f, colorOf));
    const borders = kids(first(doc, 'borders'), 'border').map((b) => parseBorder(b, colorOf));
    const xfs = kids(first(doc, 'cellXfs'), 'xf').map((xf) => {
      const a = child(xf, 'alignment');
      return {
        numFmt: +xf.getAttribute('numFmtId') || 0,
        font: fonts[+xf.getAttribute('fontId') || 0] || null,
        fill: fills[+xf.getAttribute('fillId') || 0] || null,
        border: borders[+xf.getAttribute('borderId') || 0] || {},
        h: a && a.getAttribute('horizontal'),
        v: a && a.getAttribute('vertical'),
        wrap: !!a && flag(a.getAttribute('wrapText')),
        indent: (a && +a.getAttribute('indent')) || 0,
      };
    });
    return { colorOf, numFmts, fonts, xfs };
  }

  /** Shared/inline strings: plain text, or an array of styled runs for rich text. */
  function parseText(si, colorOf) {
    if (!si) return '';
    const runs = kids(si, 'r');
    if (!runs.length) return unescapeX(kids(si, 't').map((t) => t.textContent).join(''));
    return runs.map((r) => ({
      text: unescapeX(kids(r, 't').map((t) => t.textContent).join('')),
      font: parseFont(child(r, 'rPr'), colorOf),
    }));
  }

  /** Colour from a number format such as "0.0%;[Red]-0.0%" (the formatter drops colours). */
  const NAMED_COLORS = { black: '#000000', blue: '#0000ff', cyan: '#00ffff', green: '#00ff00', magenta: '#ff00ff', red: '#ff0000', white: '#ffffff', yellow: '#ffff00' };
  function numberColor(code, value) {
    if (typeof code !== 'string' || !/\[(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)\]/i.test(code)) return null;
    const sections = [];
    let current = '';
    let quoted = false;
    let bracket = false;
    for (const ch of code) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === '[') bracket = true;
      else if (!quoted && ch === ']') bracket = false;
      if (ch === ';' && !quoted && !bracket) {
        sections.push(current);
        current = '';
      } else current += ch;
    }
    sections.push(current);
    const section = (value < 0 && sections[1] != null && sections[1]) || (value === 0 && sections[2]) || sections[0];
    const m = /\[(black|blue|cyan|green|magenta|red|white|yellow)\]|\[color\s*(\d+)\]/i.exec(section);
    if (!m) return null;
    return m[1] ? NAMED_COLORS[m[1].toLowerCase()] : INDEXED[+m[2] + 7] ? `#${INDEXED[+m[2] + 7]}` : null;
  }

  /** Apply an Excel number format (code or built-in id) with SheetJS's formatter. */
  function formatNumber(XLSX, fmt, value, date1904) {
    // "[$-409]" only names a locale; the formatter would otherwise print it as a "$".
    const code = typeof fmt === 'string' ? fmt.replace(/\[\$-[0-9A-Fa-f]+\]/g, '') : fmt;
    let text;
    try {
      text = XLSX.SSF.format(code, value, { date1904 });
    } catch (e) {
      text = String(value);
    }
    return { text, color: numberColor(code, value) };
  }

  /** Column widths from the text in each column, for files that don't store any (CSV). */
  function autoWidths(cells) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '11pt Calibri, Carlito, Arial, sans-serif';
    const widths = new Map();
    for (const [key, cell] of cells) {
      const c = key % KEY;
      const px = Math.min(320, Math.ceil(ctx.measureText(String(cell.content)).width) + 12);
      widths.set(c, Math.max(widths.get(c) || 40, px));
    }
    return widths;
  }

  const NUMERIC = /^[-+(]?\s*[$€£¥]?\s*\d[\d,]*(\.\d+)?\s*%?\)?$|^[-+(]?\s*[$€£¥]?\s*\.\d+%?\)?$/;

  const isEmpty = (content) => (Array.isArray(content) ? !content.some((r) => r.text) : content === '' || content == null);

  /* ---------- .xlsx / .xlsm ---------- */

  async function readXlsx(file) {
    const [JSZip, XLSX] = await Promise.all([U.lib('jszip'), U.lib('sheetjs')]);
    const zip = await JSZip.loadAsync(file);
    const xml = async (path) => {
      const entry = zip.file(path);
      if (!entry) return null;
      const doc = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
      return doc.getElementsByTagName('parsererror').length ? null : doc;
    };
    const rels = async (path) => {
      const dir = path.replace(/[^/]*$/, '');
      const doc = await xml(`${dir}_rels/${path.slice(dir.length)}.rels`);
      const map = new Map();
      for (const r of all(doc, 'Relationship')) {
        const target = r.getAttribute('Target');
        const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/');
        const resolved = [];
        for (const p of parts) if (p === '..') resolved.pop(); else if (p !== '.') resolved.push(p);
        map.set(r.getAttribute('Id'), { path: resolved.join('/'), type: r.getAttribute('Type') || '' });
      }
      return map;
    };
    const byType = (map, suffix) => [...map.values()].find((r) => r.type.endsWith(suffix));

    const root = await rels('');
    const wbPath = (byType(root, '/officeDocument') || { path: 'xl/workbook.xml' }).path;
    const wb = await xml(wbPath);
    if (!wb) throw new Error('not a workbook');
    const wbRels = await rels(wbPath);

    const theme = parseTheme(byType(wbRels, '/theme') && (await xml(byType(wbRels, '/theme').path)));
    const styleDoc = byType(wbRels, '/styles') && (await xml(byType(wbRels, '/styles').path));
    const styles = parseStyles(styleDoc, theme);
    const sstDoc = byType(wbRels, '/sharedStrings') && (await xml(byType(wbRels, '/sharedStrings').path));
    const sst = kids(first(sstDoc, 'sst'), 'si').map((si) => parseText(si, styles.colorOf));
    const date1904 = flag((first(wb, 'workbookPr') || { getAttribute: () => null }).getAttribute('date1904'));
    const baseFont = styles.fonts[0] || {};
    const base = baseFont.size || 11;

    const format = (value, xf) => {
      const code = styles.numFmts.get(xf.numFmt);
      return formatNumber(XLSX, code != null ? code : xf.numFmt, value, date1904);
    };

    const sheetEls = all(wb, 'sheet');
    const sheets = sheetEls.map((s) => ({
      name: s.getAttribute('name') || 'Sheet',
      hidden: !!s.getAttribute('state') && s.getAttribute('state') !== 'visible',
      path: (wbRels.get(relId(s)) || {}).path,
    }));
    for (const dn of all(wb, 'definedName')) {
      const sheet = sheets[+dn.getAttribute('localSheetId')];
      if (!sheet) continue;
      if (dn.getAttribute('name') === '_xlnm.Print_Area') sheet.printArea = parseArea(dn.textContent);
      if (dn.getAttribute('name') === '_xlnm.Print_Titles') {
        const titles = dn.textContent.split(',').map(parseArea).find((a) => a && a.rowsOnly);
        if (titles) sheet.printTitles = titles;
      }
    }

    const out = [];
    for (const meta of sheets) {
      const doc = meta.path && (await xml(meta.path));
      if (!doc || !first(doc, 'sheetData')) continue; // chart sheets, dialogs…
      out.push(Object.assign(parseSheet(doc, { styles, sst, format, base }), meta));
    }
    return out;
  }

  function parseSheet(doc, { styles, sst, format, base }) {
    const xfAt = (i) => styles.xfs[i] || styles.xfs[0] || null;
    const cells = new Map();
    const rowInfo = new Map();
    let r = -1;
    for (const row of all(doc, 'row')) {
      r = row.hasAttribute('r') ? +row.getAttribute('r') - 1 : r + 1;
      rowInfo.set(r, {
        pt: parseFloat(row.getAttribute('ht')) || null,
        hidden: flag(row.getAttribute('hidden')),
        style: flag(row.getAttribute('customFormat')) ? xfAt(+row.getAttribute('s') || 0) : null,
      });
      let c = -1;
      for (const cell of kids(row, 'c')) {
        const pos = decodeRef(cell.getAttribute('r'));
        c = pos ? pos.c : c + 1;
        const xf = xfAt(+cell.getAttribute('s') || 0);
        const t = cell.getAttribute('t') || 'n';
        const v = child(cell, 'v');
        const raw = v ? v.textContent : null;
        let kind = 's';
        let content = '';
        if (t === 's') content = raw != null ? sst[+raw] ?? '' : '';
        else if (t === 'inlineStr') content = parseText(child(cell, 'is'), styles.colorOf);
        else if (t === 'str' || t === 'd') content = raw ?? '';
        else if (t === 'b') { kind = 'b'; content = raw === '1' ? 'TRUE' : 'FALSE'; }
        else if (t === 'e') { kind = 'e'; content = raw ?? ''; }
        let color = null;
        if (t === 'n' && raw != null && raw !== '') {
          kind = 'n';
          ({ text: content, color } = format(parseFloat(raw), xf));
        }
        cells.set(r * KEY + c, { kind, content, color, style: xf });
      }
    }

    const fmt = first(doc, 'sheetFormatPr');
    const attr = (el, name) => (el ? el.getAttribute(name) : null);
    const mdw = (7 * base) / 11; // width of a digit in px, the unit Excel column widths are counted in
    const widthPx = (w) => Math.trunc(((256 * w + Math.trunc(128 / mdw)) / 256) * mdw);
    const defaultPx = parseFloat(attr(fmt, 'defaultColWidth'))
      ? widthPx(parseFloat(attr(fmt, 'defaultColWidth')))
      : Math.round((parseFloat(attr(fmt, 'baseColWidth')) || 8) * mdw + 5);
    const cols = all(doc, 'col').map((col) => ({
      min: +col.getAttribute('min') - 1,
      max: +col.getAttribute('max') - 1,
      px: parseFloat(col.getAttribute('width')) ? widthPx(parseFloat(col.getAttribute('width'))) : defaultPx,
      hidden: flag(col.getAttribute('hidden')),
      style: col.hasAttribute('style') ? xfAt(+col.getAttribute('style')) : null,
    }));
    const defaultRow = parseFloat(attr(fmt, 'defaultRowHeight')) || (15 * base) / 11;

    const setup = first(doc, 'pageSetup');
    const margins = first(doc, 'pageMargins');
    const inch = (name, d) => (margins && parseFloat(margins.getAttribute(name)) >= 0 ? parseFloat(margins.getAttribute(name)) : d) * 25.4;

    return {
      cells,
      merges: all(doc, 'mergeCell').map((m) => decodeRange(m.getAttribute('ref'))).filter(Boolean),
      rowInfo: (row) => {
        const info = rowInfo.get(row);
        return { pt: (info && info.pt) || defaultRow, hidden: !!(info && info.hidden), style: info && info.style };
      },
      colInfo: (col) => cols.find((c) => col >= c.min && col <= c.max) || { px: defaultPx, hidden: false, style: null },
      defaultStyle: styles.xfs[0] || null,
      base,
      baseFont: (styles.fonts[0] || {}).name || 'Calibri',
      page: {
        landscape: attr(setup, 'orientation') === 'landscape',
        paper: PAPER_MM[+attr(setup, 'paperSize')] || null,
        margin: { top: inch('top', 0.75), right: inch('right', 0.7), bottom: inch('bottom', 0.75), left: inch('left', 0.7) },
      },
    };
  }

  /* ---------- .xls / .xlsb / .csv (SheetJS) ---------- */

  async function readWithSheetJS(file) {
    const XLSX = await U.lib('sheetjs');
    const csv = U.fileExt(file) === 'csv';
    let wb;
    if (csv) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text = new TextDecoder('utf-8').decode(bytes);
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes); // older Excel CSV exports
      wb = XLSX.read(text, { type: 'string', raw: true }); // keep the text exactly as written
    } else {
      wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellStyles: true, cellNF: true });
    }
    const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
    return wb.SheetNames.map((name, i) => {
      const ws = wb.Sheets[name];
      const cells = new Map();
      for (const ref of Object.keys(ws)) {
        if (ref[0] === '!') continue;
        const { r, c } = XLSX.utils.decode_cell(ref);
        const cell = ws[ref];
        let kind = { n: 'n', b: 'b', e: 'e' }[cell.t] || 's';
        let content = cell.w != null ? cell.w : cell.v != null ? String(cell.v) : '';
        let color = null;
        if (cell.t === 'b' && cell.w == null) content = cell.v ? 'TRUE' : 'FALSE';
        if (cell.t === 'n' && cell.z) ({ text: content, color } = formatNumber(XLSX, cell.z, cell.v, date1904));
        if (csv && NUMERIC.test(content.trim())) kind = 'n'; // right-align numbers, as Excel would
        cells.set(r * KEY + c, { kind, content, color, style: null });
      }
      const cols = ws['!cols'] || [];
      const rows = ws['!rows'] || [];
      const fitted = cols.length ? null : autoWidths(cells);
      return {
        name,
        hidden: !!(wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[i] && wb.Workbook.Sheets[i].Hidden),
        cells,
        merges: (ws['!merges'] || []).map((m) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c })),
        rowInfo: (r) => ({ pt: (rows[r] && (rows[r].hpt || (rows[r].hpx && rows[r].hpx * 0.75))) || 15, hidden: !!(rows[r] && rows[r].hidden), style: null }),
        colInfo: (c) => {
          const col = cols[c];
          const px = col && (col.wpx || (col.wch != null ? Math.round(col.wch * 7 + 5) : null));
          return { px: px || (fitted && fitted.get(c)) || 64, hidden: !!(col && col.hidden), style: null };
        },
        defaultStyle: null,
        base: 11,
        baseFont: 'Calibri',
        page: { landscape: false, paper: null, margin: { top: 19, right: 18, bottom: 19, left: 18 } },
      };
    });
  }

  /* ---------- sheet → HTML table ---------- */

  function fontCss(f, base, parentSize) {
    const css = {};
    if (!f) return css;
    if (f.name) {
      const fallback = FONT_FALLBACKS[f.name];
      css.fontFamily = [`"${f.name.replace(/"/g, '')}"`, fallback, SERIF.test(f.name) ? 'serif' : 'sans-serif'].filter(Boolean).join(', ');
    }
    if (f.size) css.fontSize = `${(f.size / (parentSize || base)).toFixed(3)}em`;
    css.fontWeight = f.bold ? 'bold' : 'normal';
    css.fontStyle = f.italic ? 'italic' : 'normal';
    const deco = [f.underline && 'underline', f.strike && 'line-through'].filter(Boolean);
    css.textDecoration = deco.length ? deco.join(' ') : 'none';
    if (f.color) css.color = f.color;
    if (f.vert === 'superscript' || f.vert === 'subscript') {
      css.verticalAlign = f.vert === 'superscript' ? 'super' : 'sub';
      css.fontSize = '0.7em';
    }
    return css;
  }

  function renderSheet(sheet, gridlines) {
    const { cells, base } = sheet;
    const pxPerEm = (base * 96) / 72;

    // Print area if the sheet has one, otherwise everything with content, a fill or a border.
    let r1 = Infinity;
    let c1 = Infinity;
    let r2 = -1;
    let c2 = -1;
    for (const [key, cell] of cells) {
      const st = cell.style;
      if (isEmpty(cell.content) && !(st && (st.fill || Object.keys(st.border || {}).length))) continue;
      const r = Math.floor(key / KEY);
      const c = key % KEY;
      r1 = Math.min(r1, r); c1 = Math.min(c1, c);
      r2 = Math.max(r2, r); c2 = Math.max(c2, c);
    }
    if (r2 < 0) return null;
    for (const m of sheet.merges) {
      if (m.r1 >= r1 && m.r1 <= r2 && m.c1 >= c1 && m.c1 <= c2) {
        r2 = Math.max(r2, m.r2);
        c2 = Math.max(c2, m.c2);
      }
    }
    const area = sheet.printArea;
    if (area) {
      r1 = area.r1; c1 = area.c1;
      r2 = Math.min(area.r2, r2); c2 = Math.min(area.c2, c2);
      if (r2 < r1 || c2 < c1) return null;
    }

    const cols = [];
    for (let c = c1; c <= c2 && cols.length < MAX_COLS; c++) if (!sheet.colInfo(c).hidden) cols.push(c);
    const rows = [];
    let truncated = false;
    for (let r = r1; r <= r2; r++) {
      if (sheet.rowInfo(r).hidden) continue;
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      rows.push(r);
    }
    if (!rows.length || !cols.length) return null;

    // Merged cells: the top-left cell spans, the rest are skipped.
    const masters = new Map();
    const covered = new Set();
    for (const m of sheet.merges) {
      const rs = rows.filter((r) => r >= m.r1 && r <= m.r2).length;
      const cs = cols.filter((c) => c >= m.c1 && c <= m.c2).length;
      if (!rs || !cs) continue;
      const top = rows.find((r) => r >= m.r1);
      const left = cols.find((c) => c >= m.c1);
      masters.set(top * KEY + left, { rs, cs });
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== top || c !== left) covered.add(r * KEY + c);
    }

    const styleAt = (r, c) => {
      const cell = cells.get(r * KEY + c);
      return (cell && cell.style) || sheet.rowInfo(r).style || sheet.colInfo(c).style || sheet.defaultStyle;
    };
    const side = (r, c, s) => {
      const st = styleAt(r, c);
      return (st && st.border && st.border[s]) || null;
    };
    const grid = gridlines ? GRIDLINE : null;
    // Each edge gets one resolved border (Excel shows a border if either neighbouring cell has one),
    // and both cells sharing the edge get the same value, so collapsing never picks the wrong one.
    const hEdge = (k, c) => (k > 0 && side(rows[k - 1], c, 'bottom')) || (k < rows.length && side(rows[k], c, 'top')) || grid || 'none';
    const vEdge = (r, j) => (j > 0 && side(r, cols[j - 1], 'right')) || (j < cols.length && side(r, cols[j], 'left')) || grid || 'none';
    const emptyAt = (r, c) => {
      const key = r * KEY + c;
      const cell = cells.get(key);
      return (!cell || isEmpty(cell.content)) && !covered.has(key) && !masters.has(key);
    };

    const group = document.createElement('colgroup');
    let totalEm = 0;
    for (const c of cols) {
      const em = sheet.colInfo(c).px / pxPerEm;
      totalEm += em;
      const col = document.createElement('col');
      col.style.width = `${em.toFixed(3)}em`;
      group.appendChild(col);
    }
    const makeTable = (rowEls) => {
      const table = document.createElement('table');
      table.className = 'xl-table fit-width';
      table.appendChild(group.cloneNode(true));
      Object.assign(table.style, {
        width: `${totalEm.toFixed(3)}em`,
        fontSize: `${base}pt`,
        fontFamily: [`"${sheet.baseFont}"`, FONT_FALLBACKS[sheet.baseFont], 'sans-serif'].filter(Boolean).join(', '),
      });
      const tbody = document.createElement('tbody');
      tbody.append(...rowEls);
      table.appendChild(tbody);
      return table;
    };

    const trs = [];
    rows.forEach((r, k) => {
      const tr = document.createElement('tr');
      tr.style.height = `${(sheet.rowInfo(r).pt / base).toFixed(3)}em`;
      cols.forEach((c, j) => {
        const key = r * KEY + c;
        if (covered.has(key)) return;
        const span = masters.get(key) || { rs: 1, cs: 1 };
        const cell = cells.get(key);
        const st = styleAt(r, c) || {};
        const font = st.font || null;
        const size = (font && font.size) || base;
        const td = document.createElement('td');
        if (span.cs > 1) td.colSpan = span.cs;
        if (span.rs > 1) td.rowSpan = span.rs;

        const kind = cell ? cell.kind : 's';
        const h = st.h && st.h !== 'general' ? st.h : kind === 'n' ? 'right' : kind === 'b' || kind === 'e' ? 'center' : 'left';
        const css = {
          ...fontCss(font, base),
          borderTop: hEdge(k, c),
          borderBottom: hEdge(Math.min(k + span.rs, rows.length), c),
          borderLeft: vEdge(r, j),
          borderRight: vEdge(r, Math.min(j + span.cs, cols.length)),
          textAlign: { center: 'center', centerContinuous: 'center', right: 'right', justify: 'justify', distributed: 'justify' }[h] || 'left',
          verticalAlign: { top: 'top', center: 'middle', justify: 'middle', distributed: 'middle' }[st.v] || 'bottom',
        };
        if (st.fill) css.backgroundColor = st.fill;
        if (cell && cell.color) css.color = cell.color;
        if (st.wrap) css.whiteSpace = 'pre-wrap';
        if (st.indent) css[h === 'right' ? 'paddingRight' : 'paddingLeft'] = `${(0.25 + st.indent * 0.7).toFixed(2)}em`;
        // Text runs on into empty cells to its right, as in Excel; otherwise it is cut off at the border.
        if (!st.wrap && span.cs === 1 && cell && !isEmpty(cell.content) && j + 1 < cols.length && emptyAt(r, cols[j + 1])) css.overflow = 'visible';
        Object.assign(td.style, css);

        if (cell && Array.isArray(cell.content)) {
          for (const run of cell.content) {
            const s = document.createElement('span');
            Object.assign(s.style, fontCss(run.font, base, size));
            s.textContent = run.text;
            td.appendChild(s);
          }
        } else if (cell) {
          td.textContent = cell.content;
        }
        tr.appendChild(td);
      });
      trs.push(tr);
    });
    if (truncated) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = cols.length;
      td.style.cssText = 'font-style:italic;color:#666;overflow:visible';
      td.textContent = `… only the first ${MAX_ROWS.toLocaleString()} rows of this sheet are included`;
      tr.appendChild(td);
      trs.push(tr);
    }

    // "Rows to repeat at top" become the main table's header, which repeats on every page.
    // Anything printed above them (a title, say) goes in a table of its own.
    const titles = sheet.printTitles;
    const isTitle = (k) => titles && k < rows.length && rows[k] >= titles.r1 && rows[k] <= titles.r2;
    const start = rows.findIndex((r, k) => isTitle(k));
    if (start < 0) return [makeTable(trs)];
    let end = start;
    while (isTitle(end)) end++;
    const tables = start > 0 ? [makeTable(trs.slice(0, start))] : [];
    const main = makeTable(trs.slice(end));
    const thead = document.createElement('thead');
    thead.append(...trs.slice(start, end));
    main.insertBefore(thead, main.tBodies[0]);
    tables.push(main);
    return tables;
  }

  /* ---------- workbook → PDF ---------- */

  function isCfb(bytes) {
    return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  }

  async function readWorkbook(file) {
    const ext = U.fileExt(file);
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const zip = head[0] === 0x50 && head[1] === 0x4b;
    if (/^xls[xmb]$/.test(ext) && !zip) {
      // Modern Excel files are ZIP packages; an encrypted one is an OLE container instead.
      throw new Error(isCfb(head)
        ? `"${file.name}" is password-protected. Save it without a password and try again.`
        : `"${file.name}" isn't a valid Excel file.`);
    }
    try {
      if (zip && ext !== 'xlsb') {
        try {
          return await readXlsx(file);
        } catch (e) {
          if (/download|internet/i.test(e.message)) throw e;
          return await readWithSheetJS(file); // unusual XLSX flavours: fall back to values only
        }
      }
      return await readWithSheetJS(file);
    } catch (e) {
      if (/download|internet/i.test(e.message)) throw e;
      if (/password|encrypt/i.test(e.message)) throw new Error(`"${file.name}" is password-protected. Save it without a password and try again.`);
      throw new Error(`"${file.name}" couldn't be read as a spreadsheet.`);
    }
  }

  function layoutFor(sheet, pageSize) {
    let [width, height] = pageSize || sheet.page.paper || [210, 297];
    if (sheet.page.landscape) [width, height] = [height, width];
    return { width, height, margin: sheet.page.margin };
  }

  async function mergePdfs(blobs) {
    const { PDFDocument } = await U.lib('pdfLib');
    const out = await PDFDocument.create();
    for (const blob of blobs) {
      const doc = await PDFDocument.load(await blob.arrayBuffer());
      (await out.copyPages(doc, doc.getPageIndices())).forEach((p) => out.addPage(p));
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  async function toPdf(file, opts, progress) {
    progress(0.02, `Reading ${file.name}`);
    let sheets = (await readWorkbook(file)).filter((s) => !s.hidden);
    if (opts.firstOnly) sheets = sheets.slice(0, 1);
    const blobs = [];
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];
      progress(0.08 + (0.9 * i) / sheets.length, `Laying out "${sheet.name}"`);
      const tables = renderSheet(sheet, opts.gridlines);
      if (!tables) continue;
      const root = document.createElement('div');
      if (sheets.length > 1) {
        const title = document.createElement('h2');
        title.className = 'sheet-name';
        title.textContent = sheet.name;
        root.appendChild(title);
      }
      root.append(...tables);
      blobs.push(await window.Render.flowToPdf(root, layoutFor(sheet, opts.pageSize), {
        contentClass: 'sheet-render',
        autoLandscape: true,
        onPage: (p, n) => progress(0.08 + (0.9 * (i + p / n)) / sheets.length,
          `${sheets.length > 1 ? `Sheet ${i + 1} of ${sheets.length}: ` : ''}page ${p + 1} of ${n}`),
      }));
    }
    if (!blobs.length) throw new Error(`"${file.name}" is empty — there is nothing to convert.`);
    return blobs.length === 1 ? blobs[0] : mergePdfs(blobs);
  }

  /** Sheet count for the file list (cheap: only reads the workbook part of .xlsx files). */
  async function describe(file) {
    const JSZip = await U.lib('jszip');
    const zip = await JSZip.loadAsync(file);
    const wb = zip.file('xl/workbook.xml');
    if (!wb) return '';
    const doc = new DOMParser().parseFromString(await wb.async('string'), 'application/xml');
    const n = all(doc, 'sheet').filter((s) => !s.getAttribute('state') || s.getAttribute('state') === 'visible').length;
    return `${n} sheet${n === 1 ? '' : 's'}`;
  }

  window.Excel = { toPdf, describe };
})();
