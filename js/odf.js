/*
 * OpenDocument → PDF. An ODF file is a ZIP of XML parts; this reads content.xml + styles.xml,
 * resolves the document's styles to CSS, and builds HTML:
 *   - text documents (ODT) and spreadsheets (ODS) become flowing content laid out by Render.flowToPdf
 *   - presentations (ODP) and drawings (ODG) become one absolutely-positioned page per slide
 */
(function () {
  'use strict';
  const U = window.Util;

  const NS = {
    office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
    xlink: 'http://www.w3.org/1999/xlink',
    presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  };
  const PREFIX = Object.fromEntries(Object.entries(NS).map(([p, uri]) => [uri, p]));

  const PROP_GROUPS = {
    'text-properties': 'text', 'paragraph-properties': 'para', 'table-cell-properties': 'cell',
    'graphic-properties': 'graphic', 'table-column-properties': 'column', 'table-properties': 'table',
    'table-row-properties': 'row', 'drawing-page-properties': 'page',
  };
  const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp' };
  const FONT_FALLBACKS = {
    'Liberation Serif': '"Times New Roman", Times', 'Liberation Sans': 'Arial, Helvetica', 'Liberation Sans Narrow': '"Arial Narrow"',
    'Liberation Mono': '"Courier New", Courier', Carlito: 'Calibri', Caladea: 'Cambria', 'DejaVu Sans': 'Verdana',
    'DejaVu Serif': 'Georgia', 'DejaVu Sans Mono': 'Consolas, "Courier New"', 'Noto Sans': 'Arial', 'Noto Serif': 'Georgia',
  };
  const GENERIC = { roman: 'serif', swiss: 'sans-serif', modern: 'monospace', script: 'cursive', decorative: 'fantasy', system: 'sans-serif' };
  const ALIGN = { start: 'left', left: 'left', end: 'right', right: 'right', center: 'center', justify: 'justify' };
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const NUM_FORMATS = { 1: 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' };
  const CONTAINERS = new Set(['section', 'index-body', 'index-title', 'table-of-content', 'illustration-index', 'table-index',
    'object-index', 'user-index', 'alphabetical-index', 'bibliography', 'numbered-paragraph']);
  const MAX_SHEET_ROWS = 5000;

  /* ---------- small helpers ---------- */

  const attr = (el, ns, name) => (el && el.getAttributeNS(NS[ns], name)) || '';
  const is = (el, ns, name) => !!el && el.nodeType === 1 && el.namespaceURI === NS[ns] && (!name || el.localName === name);
  const kids = (el) => (el ? [...el.children] : []);
  const child = (el, ns, name) => kids(el).find((c) => is(c, ns, name));
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 };
  function toMM(v) {
    const m = /^(-?[\d.]+)(mm|cm|in|pt|pc|px)$/.exec(String(v || '').trim());
    return m ? parseFloat(m[1]) * UNIT_MM[m[2]] : null;
  }

  function make(tag, css, cls) {
    const el = document.createElement(tag);
    if (css) for (const [k, v] of Object.entries(css)) if (v != null && v !== '') el.style[k] = v;
    if (cls) el.className = cls;
    return el;
  }

  function normHref(href) {
    try {
      return decodeURIComponent(href.replace(/^\.\//, ''));
    } catch (e) {
      return href;
    }
  }

  /* ---------- package ---------- */

  async function readPackage(file) {
    const JSZip = await U.lib('jszip');
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch (e) {
      throw new Error(`"${file.name}" isn't a valid OpenDocument file.`);
    }
    const manifest = zip.file('META-INF/manifest.xml');
    if (manifest && /encryption-data/.test(await manifest.async('string'))) {
      throw new Error(`"${file.name}" is password-protected. Save it without a password and try again.`);
    }
    const parse = async (name) => {
      const entry = zip.file(name);
      if (!entry) return null;
      const doc = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
      return doc.getElementsByTagName('parsererror').length ? null : doc;
    };
    const content = await parse('content.xml');
    if (!content) throw new Error(`"${file.name}" isn't a valid OpenDocument file.`);

    // Embedded pictures become data URLs. External links are never fetched.
    const images = new Map();
    await Promise.all(Object.values(zip.files).map(async (entry) => {
      const mime = IMAGE_MIME[U.ext(entry.name)];
      if (!mime || entry.dir || /^(Thumbnails|Configurations2)\//.test(entry.name)) return;
      images.set(entry.name, `data:${mime};base64,${await entry.async('base64')}`);
    }));
    return { content, styles: await parse('styles.xml'), images };
  }

  /* ---------- styles ---------- */

  function readProps(el) {
    const out = {};
    for (const c of kids(el)) {
      const group = c.namespaceURI === NS.style && PROP_GROUPS[c.localName];
      if (!group) continue;
      const o = {};
      for (const a of c.attributes) if (a.namespaceURI) o[`${PREFIX[a.namespaceURI] || a.prefix}:${a.localName}`] = a.value;
      out[group] = o;
    }
    return out;
  }

  function merge(base, own) {
    const out = { ...base, ...own };
    for (const g of Object.values(PROP_GROUPS)) if (base[g] && own[g]) out[g] = { ...base[g], ...own[g] };
    // A percentage font size is relative to the parent style's size.
    const size = own.text && own.text['fo:font-size'];
    const baseSize = base.text && base.text['fo:font-size'];
    if (size && size.endsWith('%') && baseSize && baseSize.endsWith('pt')) {
      out.text['fo:font-size'] = `${(parseFloat(baseSize) * parseFloat(size)) / 100}pt`;
    }
    return out;
  }

  class Styles {
    constructor(docs) {
      this.styles = new Map();
      this.defaults = new Map();
      this.lists = new Map();
      this.fonts = new Map();
      this.layouts = new Map();
      this.masters = new Map();
      this.fillImages = new Map();
      this.gradients = new Map();
      this.cache = new Map();
      for (const doc of docs.filter(Boolean)) {
        const each = (ns, name, fn) => { for (const el of doc.getElementsByTagNameNS(NS[ns], name)) fn(el); };
        each('style', 'font-face', (el) => this.fonts.set(attr(el, 'style', 'name'), {
          family: attr(el, 'svg', 'font-family').replace(/^['"]|['"]$/g, ''),
          generic: attr(el, 'style', 'font-family-generic'),
        }));
        each('style', 'style', (el) => this.styles.set(`${attr(el, 'style', 'family')}:${attr(el, 'style', 'name')}`, el));
        each('style', 'default-style', (el) => this.defaults.set(attr(el, 'style', 'family'), el));
        each('text', 'list-style', (el) => attr(el, 'style', 'name') && this.lists.set(attr(el, 'style', 'name'), el));
        each('style', 'page-layout', (el) => this.layouts.set(attr(el, 'style', 'name'), el));
        each('style', 'master-page', (el) => this.masters.set(attr(el, 'style', 'name'), el));
        each('draw', 'fill-image', (el) => this.fillImages.set(attr(el, 'draw', 'name'), el));
        each('draw', 'gradient', (el) => this.gradients.set(attr(el, 'draw', 'name'), el));
      }
    }

    /** Fully resolved properties of a style, following its parent chain (and optionally the family default). */
    props(family, name, withDefaults = true) {
      const key = `${family}:${name}:${withDefaults}`;
      if (this.cache.has(key)) return this.cache.get(key);
      this.cache.set(key, {}); // guards against circular parent references
      const el = name ? this.styles.get(`${family}:${name}`) : null;
      const parent = el && attr(el, 'style', 'parent-style-name');
      let base = {};
      if (parent) base = this.props(family, parent, withDefaults);
      else if (withDefaults) {
        const def = this.defaults.get(family) || (family === 'presentation' ? this.defaults.get('graphic') : null);
        if (def) base = readProps(def);
      }
      const result = el ? merge(base, readProps(el)) : base;
      this.cache.set(key, result);
      return result;
    }

    pageLayout(masterName) {
      const master = this.masters.get(masterName) || this.masters.values().next().value;
      const props = child(master && this.layouts.get(attr(master, 'style', 'page-layout-name')), 'style', 'page-layout-properties');
      const dim = (name, fallback) => {
        const v = toMM(attr(props, 'fo', name));
        return v > 0 ? v : fallback;
      };
      const width = dim('page-width', 210);
      const height = dim('page-height', 297);
      const margin = {};
      for (const side of SIDES) {
        const v = toMM(attr(props, 'fo', `margin-${side}`) || attr(props, 'fo', 'margin'));
        const limit = (side === 'top' || side === 'bottom' ? height : width) * 0.3;
        margin[side] = v != null && v >= 0 && v < limit ? v : 20;
      }
      return { width, height, margin };
    }
  }

  /* ---------- style → CSS ---------- */

  /** ODF lengths are valid CSS lengths; in spreadsheets they're converted to em so the sheet can be scaled. */
  function len(v, ctx) {
    if (!ctx.em) return v;
    const mm = toMM(v);
    return mm == null ? v : `${((mm * 72) / 25.4 / ctx.em).toFixed(3)}em`;
  }

  function fontFamily(t, styles) {
    const name = t['style:font-name'] || t['fo:font-family'];
    if (!name) return '';
    const face = styles.fonts.get(name);
    const family = ((face && face.family) || name).replace(/^['"]|['"]$/g, '');
    const generic = GENERIC[face && face.generic]
      || (/mono|courier|consol/i.test(family) ? 'monospace' : /serif|times|georgia|cambria|caladea/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans-serif');
    return [`"${family.replace(/"/g, '')}"`, FONT_FALLBACKS[family], generic].filter(Boolean).join(', ');
  }

  function textCss(t, ctx) {
    const css = {};
    if (!t) return css;
    const size = t['fo:font-size'];
    if (size) css.fontSize = ctx.em && size.endsWith('pt') ? `${(parseFloat(size) / ctx.em).toFixed(3)}em` : size;
    if (t['fo:font-weight']) css.fontWeight = t['fo:font-weight'];
    if (t['fo:font-style']) css.fontStyle = t['fo:font-style'];
    const family = fontFamily(t, ctx.styles);
    if (family) css.fontFamily = family;
    if (t['fo:color']) css.color = t['fo:color'];
    const deco = [];
    if (t['style:text-underline-style'] && t['style:text-underline-style'] !== 'none') deco.push('underline');
    if (t['style:text-line-through-style'] && t['style:text-line-through-style'] !== 'none') deco.push('line-through');
    if (deco.length) css.textDecoration = deco.join(' ');
    else if ('style:text-underline-style' in t) css.textDecoration = 'none';
    const bg = t['fo:background-color'];
    if (bg && bg !== 'transparent') css.backgroundColor = bg;
    if (t['fo:font-variant'] === 'small-caps') css.fontVariant = 'small-caps';
    if (t['fo:text-transform'] && t['fo:text-transform'] !== 'none') css.textTransform = t['fo:text-transform'];
    const pos = t['style:text-position'];
    if (pos) {
      const shift = pos.split(/\s+/)[0];
      if (shift === 'super' || parseFloat(shift) > 0) Object.assign(css, { verticalAlign: 'super', fontSize: '58%' });
      else if (shift === 'sub' || parseFloat(shift) < 0) Object.assign(css, { verticalAlign: 'sub', fontSize: '58%' });
    }
    return css;
  }

  /** "Automatic" font colour: white on dark backgrounds, black otherwise (as LibreOffice draws it). */
  function autoColor(t, background) {
    if (!t || t['fo:color'] || t['style:use-window-font-color'] !== 'true') return null;
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(background || '');
    if (!m) return null;
    const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
    return 0.299 * r + 0.587 * g + 0.114 * b <= 156 ? '#fff' : '#000';
  }

  function boxCss(p, ctx) {
    const css = {};
    for (const side of SIDES) {
      const border = p[`fo:border-${side}`] || p['fo:border'];
      if (border && border !== 'none') css[`border${cap(side)}`] = border;
      const pad = p[`fo:padding-${side}`] || p['fo:padding'];
      if (pad) css[`padding${cap(side)}`] = len(pad, ctx);
    }
    const bg = p['fo:background-color'];
    if (bg && bg !== 'transparent') css.backgroundColor = bg;
    return css;
  }

  function paraCss(p, ctx) {
    if (!p) return {};
    const css = boxCss(p, ctx);
    const align = ALIGN[p['fo:text-align']];
    if (align) css.textAlign = align;
    for (const side of SIDES) {
      const m = p[`fo:margin-${side}`];
      if (m && !m.endsWith('%')) css[`margin${cap(side)}`] = len(m, ctx);
    }
    if (p['fo:text-indent'] && !p['fo:text-indent'].endsWith('%')) css.textIndent = len(p['fo:text-indent'], ctx);
    const lh = p['fo:line-height'];
    // ODF's 100% is the font's natural line height, roughly CSS "normal" (≈1.15)
    if (lh && lh !== 'normal') css.lineHeight = lh.endsWith('%') ? String((1.15 * parseFloat(lh)) / 100) : len(lh, ctx);
    return css;
  }

  function cellCss(c, ctx) {
    if (!c) return {};
    const css = boxCss(c, ctx);
    const va = c['style:vertical-align'];
    if (va && va !== 'automatic') css.verticalAlign = va;
    if (c['fo:wrap-option'] === 'wrap') css.whiteSpace = 'normal';
    return css;
  }

  function gradientCss(gr) {
    const from = attr(gr, 'draw', 'start-color') || '#000';
    const to = attr(gr, 'draw', 'end-color') || '#fff';
    const a = attr(gr, 'draw', 'angle');
    const deg = /deg$/.test(a) ? parseFloat(a) : /rad$/.test(a) ? (parseFloat(a) * 180) / Math.PI : (parseFloat(a) || 0) / 10;
    const css = 180 - deg; // ODF angles turn counter-clockwise from "top to bottom"
    switch (attr(gr, 'draw', 'style')) {
      case 'axial': return `linear-gradient(${css}deg, ${from}, ${to}, ${from})`;
      case 'radial': case 'ellipsoid': case 'square': case 'rectangular': return `radial-gradient(${to}, ${from})`;
      default: return `linear-gradient(${css}deg, ${from}, ${to})`;
    }
  }

  function fillCss(g, ctx) {
    const css = {};
    if (!g) return css;
    const fill = g['draw:fill'];
    if (fill === 'solid' && g['draw:fill-color']) css.backgroundColor = g['draw:fill-color'];
    else if (fill === 'gradient') {
      const gr = ctx.styles.gradients.get(g['draw:fill-gradient-name']);
      if (gr) css.backgroundImage = gradientCss(gr);
    } else if (fill === 'bitmap') {
      const fi = ctx.styles.fillImages.get(g['draw:fill-image-name']);
      const url = fi && ctx.images.get(normHref(attr(fi, 'xlink', 'href')));
      if (url) {
        const repeat = g['style:repeat'] || 'repeat';
        Object.assign(css, {
          backgroundImage: `url("${url}")`,
          backgroundSize: repeat === 'stretch' ? '100% 100%' : 'auto',
          backgroundRepeat: repeat === 'repeat' ? 'repeat' : 'no-repeat',
          backgroundPosition: 'center',
        });
      }
    }
    return css;
  }

  function strokeCss(g) {
    const stroke = g && g['draw:stroke'];
    if (!stroke || stroke === 'none') return {};
    const px = Math.max(1, ((toMM(g['svg:stroke-width']) || 0) * 96) / 25.4);
    return { border: `${px.toFixed(2)}px ${stroke === 'dash' ? 'dashed' : 'solid'} ${g['svg:stroke-color'] || '#000'}` };
  }

  function listLevel(styles, name, depth) {
    const levels = kids(styles.lists.get(name));
    const find = (d) => levels.find((l) => +attr(l, 'text', 'level') === d) || levels.filter((l) => +attr(l, 'text', 'level') <= d).pop();
    // How far a level's text starts from the left margin, in mm.
    const indent = (d) => {
      const props = child(find(d), 'style', 'list-level-properties');
      const label = child(props, 'style', 'list-level-label-alignment');
      if (label) return toMM(attr(label, 'fo', 'margin-left'));
      const before = toMM(attr(props, 'text', 'space-before')) || 0;
      const width = toMM(attr(props, 'text', 'min-label-width'));
      return width == null ? null : before + width;
    };
    const lvl = find(depth);
    const here = indent(depth);
    const pad = here == null ? null : `${Math.max(here - (depth > 1 ? indent(depth - 1) || 0 : 0), 3)}mm`;
    if (is(lvl, 'text', 'list-level-style-number')) {
      const fmt = lvl.hasAttributeNS(NS.style, 'num-format') ? attr(lvl, 'style', 'num-format') : '1';
      return { ordered: true, type: NUM_FORMATS[fmt] || (fmt ? 'decimal' : 'none'), start: +attr(lvl, 'text', 'start-value') || 1, pad };
    }
    if (is(lvl, 'text', 'list-level-style-bullet')) {
      const ch = attr(lvl, 'text', 'bullet-char');
      return { ordered: false, type: /[◦○◯]/.test(ch) ? 'circle' : /[▪■□◼]/.test(ch) ? 'square' : 'disc', start: 1, pad };
    }
    return { ordered: false, type: 'disc', start: 1, pad };
  }

  function rowList(table) {
    const out = [];
    const walk = (el, header) => {
      for (const c of kids(el)) {
        if (is(c, 'table', 'table-row')) out.push({ row: c, header });
        else if (is(c, 'table', 'table-header-rows')) walk(c, true);
        else if (is(c, 'table', 'table-rows') || is(c, 'table', 'table-row-group')) walk(c, header);
      }
    };
    walk(table, false);
    return out;
  }

  function columnList(table, styles) {
    const out = [];
    const walk = (el) => {
      for (const c of kids(el)) {
        if (is(c, 'table', 'table-column')) {
          const p = styles.props('table-column', attr(c, 'table', 'style-name')).column || {};
          const info = {
            width: p['style:column-width'] || '',
            rel: parseFloat(p['style:rel-column-width']) || 0,
            cellStyle: attr(c, 'table', 'default-cell-style-name'),
            hidden: /^(collapse|filter)$/.test(attr(c, 'table', 'visibility')),
          };
          const n = Math.min(+attr(c, 'table', 'number-columns-repeated') || 1, 1024 - out.length);
          for (let i = 0; i < n; i++) out.push(info);
        } else if (is(c, 'table') && /^table-(columns|header-columns|column-group)$/.test(c.localName)) {
          walk(c);
        }
      }
    };
    walk(table);
    return out;
  }

  const hasContent = (cell) => kids(cell).some((k) => (is(k, 'text', 'p') && k.textContent.trim()) || is(k, 'draw', 'frame'));

  /* ---------- ODF → HTML ---------- */

  class Converter {
    constructor(styles, images, { paraDefaults = true, em = 0 } = {}) {
      this.styles = styles;
      this.images = images;
      this.paraDefaults = paraDefaults; // ODT paragraphs inherit the document defaults; text in cells/shapes inherits its container
      this.em = em; // base font size (pt) when sizes should be relative
      this.notes = [];
      this.counters = new Map();
    }

    blocks(src, out) {
      for (const el of kids(src)) this.block(el, out);
    }

    block(el, out) {
      if (is(el, 'text', 'p') || is(el, 'text', 'h')) out.appendChild(this.paragraph(el));
      else if (is(el, 'text', 'list')) out.appendChild(this.list(el, 1, ''));
      else if (is(el, 'table', 'table')) out.appendChild(this.table(el));
      else if (is(el, 'draw', 'frame')) {
        const f = this.frame(el);
        if (f) out.appendChild(f);
      } else if (is(el, 'text') && CONTAINERS.has(el.localName)) this.blocks(el, out);
      // tracked changes, declarations, forms, soft page breaks and unknown elements are skipped
    }

    paragraph(el) {
      const name = attr(el, 'text', 'style-name');
      const props = this.styles.props('paragraph', name, this.paraDefaults);
      const level = Math.min(6, Math.max(1, +attr(el, 'text', 'outline-level') || 1));
      const node = make(el.localName === 'h' ? `h${level}` : 'p', { ...textCss(props.text, this), ...paraCss(props.para, this) });
      const para = props.para || {};
      const own = this.styles.styles.get(`paragraph:${name}`);
      if (para['fo:break-before'] === 'page' || (own && attr(own, 'style', 'master-page-name'))) node.dataset.pageBreak = 'before';
      else if (para['fo:break-after'] === 'page') node.dataset.pageBreak = 'after';
      this.inline(el, node);
      if (!node.textContent.trim() && !node.querySelector('img, br, .odf-frame')) node.appendChild(document.createElement('br'));
      return node;
    }

    inline(src, out) {
      for (const n of src.childNodes) {
        if (n.nodeType === 3) {
          out.appendChild(document.createTextNode(n.nodeValue));
          continue;
        }
        if (n.nodeType !== 1) continue;
        if (n.namespaceURI === NS.text) {
          switch (n.localName) {
            case 's':
              out.appendChild(document.createTextNode(' '.repeat(Math.min(+attr(n, 'text', 'c') || 1, 200))));
              break;
            case 'tab':
              out.appendChild(make('span', null, 'odf-tab'));
              break;
            case 'line-break':
              out.appendChild(document.createElement('br'));
              break;
            case 'span': {
              const span = make('span', textCss(this.styles.props('text', attr(n, 'text', 'style-name'), false).text, this));
              this.inline(n, span);
              out.appendChild(span);
              break;
            }
            case 'a': {
              const a = make('a', textCss(this.styles.props('text', attr(n, 'text', 'style-name'), false).text, this));
              const href = attr(n, 'xlink', 'href');
              if (/^(https?:|mailto:)/i.test(href)) a.href = href;
              this.inline(n, a);
              out.appendChild(a);
              break;
            }
            case 'note':
              this.note(n, out);
              break;
            case 'bookmark': case 'bookmark-start': case 'bookmark-end': case 'reference-mark': case 'reference-mark-start':
            case 'reference-mark-end': case 'soft-page-break': case 'change': case 'change-start': case 'change-end':
            case 'toc-mark': case 'toc-mark-start': case 'toc-mark-end': case 'alphabetical-index-mark':
            case 'alphabetical-index-mark-start': case 'alphabetical-index-mark-end': case 'hidden-text': case 'hidden-paragraph':
              break;
            default:
              this.inline(n, out); // fields (page number, date, title…) carry their last displayed value as text
          }
        } else if (is(n, 'draw', 'frame')) {
          const f = this.frame(n);
          if (f) out.appendChild(f);
        } else if (is(n, 'draw', 'a')) {
          this.inline(n, out);
        }
        // office:annotation (comments) and other drawing shapes are not printed
      }
    }

    note(n, out) {
      const citation = child(n, 'text', 'note-citation');
      const label = (citation && citation.textContent.trim()) || String(this.notes.length + 1);
      const ref = make('sup', null, 'odf-note-ref');
      ref.textContent = label;
      out.appendChild(ref);
      const body = child(n, 'text', 'note-body');
      if (!body) return;
      const note = make('div', null, 'odf-note');
      this.blocks(body, note);
      const mark = make('sup');
      mark.textContent = `${label} `;
      (note.firstChild || note).prepend(mark);
      this.notes.push(note);
    }

    list(el, depth, inherited) {
      const name = attr(el, 'text', 'style-name') || inherited;
      const lvl = listLevel(this.styles, name, depth);
      const node = make(lvl.ordered ? 'ol' : 'ul', { listStyleType: lvl.type, paddingLeft: this.em ? null : lvl.pad });
      // In presentation outlines each level has its own style ("Default-outline2", "-outline3", …).
      if (this.outlinePrefix && depth > 1) {
        Object.assign(node.style, textCss(this.styles.props('presentation', `${this.outlinePrefix}-outline${depth}`).text, this));
      }
      const key = `${name}:${depth}`;
      let start = lvl.start;
      const continues = attr(el, 'text', 'continue-numbering') === 'true' || attr(el, 'text', 'continue-list');
      if (lvl.ordered && continues && this.counters.has(key)) start = this.counters.get(key) + 1;
      if (lvl.ordered && start !== 1) node.start = start;
      let count = 0;
      for (const item of kids(el)) {
        const header = is(item, 'text', 'list-header');
        if (!header && !is(item, 'text', 'list-item')) continue;
        const li = make('li', header ? { listStyleType: 'none' } : null);
        for (const c of kids(item)) {
          if (is(c, 'text', 'list')) li.appendChild(this.list(c, depth + 1, name));
          else this.block(c, li);
        }
        // An item that only holds a sub-list has no paragraph of its own, so no bullet either.
        if (/^(UL|OL)$/.test((li.firstElementChild || {}).tagName)) li.style.listStyleType = 'none';
        if (!header) count++;
        node.appendChild(li);
      }
      if (lvl.ordered) this.counters.set(key, start + count - 1);
      return node;
    }

    image(el) {
      return this.images.get(normHref(attr(el, 'xlink', 'href'))) || null;
    }

    frame(el) {
      const width = attr(el, 'svg', 'width');
      const box = child(el, 'draw', 'text-box');
      if (box) {
        const div = make('div', { width: width || null }, 'odf-frame');
        this.blocks(box, div);
        return div;
      }
      for (const imgEl of kids(el).filter((c) => is(c, 'draw', 'image'))) {
        const url = this.image(imgEl);
        if (!url) continue; // e.g. WMF/EMF previews of charts, which browsers can't display
        const img = make('img', null, 'odf-img');
        img.alt = '';
        img.src = url;
        const w = toMM(width);
        const h = toMM(attr(el, 'svg', 'height'));
        if (w) {
          img.style.width = `${w}mm`;
          if (h) img.style.aspectRatio = `${w} / ${h}`;
        }
        const anchor = attr(el, 'text', 'anchor-type');
        if (anchor && anchor !== 'as-char') {
          img.style.display = 'block';
          const pos = (this.styles.props('graphic', attr(el, 'draw', 'style-name')).graphic || {})['style:horizontal-pos'];
          if (pos === 'center') img.style.margin = '0 auto';
          else if (pos === 'right' || pos === 'outside') img.style.marginLeft = 'auto';
        }
        return img;
      }
      return null;
    }

    /* text-document tables */

    table(el) {
      const tp = this.styles.props('table', attr(el, 'table', 'style-name')).table || {};
      const table = make('table', null, 'odf-table');
      const width = tp['style:width'];
      if (!width || tp['table:align'] === 'margins') table.style.width = '100%';
      else {
        table.style.width = width;
        if (tp['table:align'] === 'center') table.style.margin = '0 auto';
        else if (tp['table:align'] === 'right') table.style.marginLeft = 'auto';
      }
      if (tp['fo:margin-top']) table.style.marginTop = tp['fo:margin-top'];
      if (tp['fo:margin-bottom']) table.style.marginBottom = tp['fo:margin-bottom'];

      const cols = columnList(el, this.styles);
      const relTotal = cols.length && cols.every((c) => c.rel) ? cols.reduce((s, c) => s + c.rel, 0) : 0;
      if (cols.length && (relTotal || cols.every((c) => c.width))) {
        table.style.tableLayout = 'fixed';
        const group = make('colgroup');
        cols.forEach((c) => group.appendChild(make('col', { width: relTotal ? `${(c.rel / relTotal) * 100}%` : c.width })));
        table.appendChild(group);
      }

      let thead = null;
      const tbody = make('tbody');
      for (const { row, header } of rowList(el)) {
        const repeat = Math.min(+attr(row, 'table', 'number-rows-repeated') || 1, 100);
        for (let r = 0; r < repeat; r++) {
          const tr = make('tr');
          let col = 0;
          for (const c of kids(row)) {
            const n = Math.min(+attr(c, 'table', 'number-columns-repeated') || 1, 256);
            if (is(c, 'table', 'table-cell')) {
              for (let k = 0; k < n; k++) tr.appendChild(this.cell(c, cols[col + k]));
            }
            if (is(c, 'table', 'table-cell') || is(c, 'table', 'covered-table-cell')) col += n;
          }
          if (header) (thead = thead || make('thead')).appendChild(tr);
          else tbody.appendChild(tr);
        }
      }
      if (thead) table.appendChild(thead);
      table.appendChild(tbody);
      return table;
    }

    cell(c, col) {
      const props = this.styles.props('table-cell', attr(c, 'table', 'style-name') || (col && col.cellStyle) || '');
      const css = { ...textCss(props.text, this), ...cellCss(props.cell, this) };
      const align = ALIGN[(props.para || {})['fo:text-align']];
      if (align) css.textAlign = align;
      css.color = css.color || autoColor(props.text, css.backgroundColor);
      const td = make('td', css);
      const cs = +attr(c, 'table', 'number-columns-spanned') || 1;
      const rs = +attr(c, 'table', 'number-rows-spanned') || 1;
      if (cs > 1) td.colSpan = cs;
      if (rs > 1) td.rowSpan = rs;
      this.blocks(c, td);
      return td;
    }

    /* spreadsheets */

    sheet(el, gridlines) {
      const cols = columnList(el, this.styles);
      const rows = rowList(el).map(({ row, header }) => {
        const cells = [];
        let col = 0;
        let lastUsed = -1;
        for (const c of kids(row)) {
          const covered = is(c, 'table', 'covered-table-cell');
          if (!covered && !is(c, 'table', 'table-cell')) continue;
          const repeat = +attr(c, 'table', 'number-columns-repeated') || 1;
          const filled = !covered && hasContent(c);
          if (filled) lastUsed = col + repeat - 1 + ((+attr(c, 'table', 'number-columns-spanned') || 1) - 1);
          cells.push({ el: c, col, repeat, covered });
          col += repeat;
        }
        const height = (this.styles.props('table-row', attr(row, 'table', 'style-name')).row || {})['style:row-height'];
        return {
          header, cells, lastUsed,
          height: height ? len(height, this) : '',
          repeat: +attr(row, 'table', 'number-rows-repeated') || 1,
          hidden: /^(collapse|filter)$/.test(attr(row, 'table', 'visibility')),
        };
      });

      // Spreadsheets declare millions of empty cells; only render the used range.
      const maxCol = Math.min(rows.reduce((m, r) => Math.max(m, r.lastUsed), -1) + 1, 256);
      let lastRow = -1;
      rows.forEach((r, i) => { if (r.lastUsed >= 0) lastRow = i; });
      if (!maxCol || lastRow < 0) return null;

      const table = make('table', { fontSize: `${this.em}pt` }, `sheet-table fit-width${gridlines ? ' sheet-grid' : ''}`);
      const group = make('colgroup');
      for (let i = 0; i < maxCol; i++) {
        if (cols[i] && cols[i].hidden) continue;
        group.appendChild(make('col', cols[i] && cols[i].width ? { width: len(cols[i].width, this) } : null));
      }
      table.appendChild(group);

      let thead = null;
      const tbody = make('tbody');
      let rendered = 0;
      let truncated = false;
      for (let ri = 0; ri <= lastRow; ri++) {
        const r = rows[ri];
        if (r.hidden) continue;
        const repeat = r.lastUsed >= 0 ? r.repeat : Math.min(r.repeat, 50); // keep blank spacer rows, not thousands of them
        for (let k = 0; k < repeat; k++) {
          if (rendered >= MAX_SHEET_ROWS) { truncated = true; break; }
          const tr = make('tr', { height: r.height });
          let covered = 0;
          for (const cell of r.cells) {
            for (let j = 0; j < cell.repeat && cell.col + j < maxCol; j++) {
              const info = cols[cell.col + j];
              if (!cell.covered && !(info && info.hidden)) tr.appendChild(this.sheetCell(cell.el, info));
            }
            covered += cell.repeat;
          }
          for (let col = covered; col < maxCol; col++) if (!(cols[col] && cols[col].hidden)) tr.appendChild(make('td'));
          if (r.header) (thead = thead || make('thead')).appendChild(tr);
          else tbody.appendChild(tr);
          rendered++;
        }
      }
      if (truncated) {
        const tr = make('tr');
        const td = make('td', { fontStyle: 'italic', color: '#666' });
        td.colSpan = maxCol;
        td.textContent = `… only the first ${MAX_SHEET_ROWS.toLocaleString()} rows of this sheet are included`;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      if (thead) table.appendChild(thead);
      table.appendChild(tbody);
      return table;
    }

    sheetCell(c, col) {
      const props = this.styles.props('table-cell', attr(c, 'table', 'style-name') || (col && col.cellStyle) || 'Default');
      const css = { ...textCss(props.text, this), ...cellCss(props.cell, this) };
      const type = attr(c, 'office', 'value-type');
      css.textAlign = ALIGN[(props.para || {})['fo:text-align']]
        || (/^(float|percentage|currency|date|time)$/.test(type) ? 'right' : type === 'boolean' ? 'center' : 'left');
      css.color = css.color || autoColor(props.text, css.backgroundColor);
      const td = make('td', css);
      const cs = +attr(c, 'table', 'number-columns-spanned') || 1;
      const rs = +attr(c, 'table', 'number-rows-spanned') || 1;
      if (cs > 1) td.colSpan = cs;
      if (rs > 1) td.rowSpan = rs;
      for (const p of kids(c)) if (is(p, 'text', 'p')) td.appendChild(this.paragraph(p));
      return td;
    }

    /* presentations & drawings */

    slide(page) {
      const masterName = attr(page, 'draw', 'master-page-name');
      const master = this.styles.masters.get(masterName);
      const layout = this.styles.masters.size ? this.styles.pageLayout(masterName) : { width: 280, height: 157.5 };
      const el = make('div', { width: `${layout.width}mm`, height: `${layout.height}mm` }, 'odf-slide');
      const own = this.styles.props('drawing-page', attr(page, 'draw', 'style-name')).page || {};
      const fromMaster = (master && this.styles.props('drawing-page', attr(master, 'draw', 'style-name')).page) || {};
      const background = own['draw:fill'] && own['draw:fill'] !== 'none' ? own : fromMaster;
      this.slideBackground = '#ffffff';
      if (own['presentation:background-visible'] !== 'false') {
        Object.assign(el.style, fillCss(background, this));
        if (background['draw:fill'] === 'solid') this.slideBackground = background['draw:fill-color'];
      }
      if (master && own['presentation:background-objects-visible'] !== 'false') this.shapes(master, el, true);
      this.shapes(page, el, false);
      return { el, width: layout.width, height: layout.height };
    }

    shapes(container, slide, fromMaster) {
      for (const el of kids(container)) {
        if (!is(el, 'draw')) continue; // speaker notes, animations, forms
        if (el.localName === 'g') {
          this.shapes(el, slide, fromMaster); // group members use page coordinates
          continue;
        }
        // Master placeholders (title, outline, date, footer, number) and empty "click to add" boxes aren't printed.
        if (fromMaster && attr(el, 'presentation', 'class')) continue;
        if (attr(el, 'presentation', 'placeholder') === 'true') continue;
        const node = el.localName === 'line' || el.localName === 'connector' ? this.line(el) : this.shape(el);
        if (node) slide.appendChild(node);
      }
    }

    /** Paragraph spacing set on the shape's presentation style (per outline level) applies to its paragraphs. */
    paragraphSpacing(box, props, prefix) {
      box.querySelectorAll('p').forEach((p, i) => {
        let depth = 0;
        for (let n = p.parentElement; n && n !== box; n = n.parentElement) if (/^(UL|OL)$/.test(n.tagName)) depth++;
        const para = (depth > 1 && prefix ? this.styles.props('presentation', `${prefix}-outline${depth}`) : props).para || {};
        for (const side of ['top', 'bottom']) {
          const m = para[`fo:margin-${side}`];
          if (side === 'top' && i === 0) continue; // no space above the first paragraph in a box
          if (m && !p.style[`margin${cap(side)}`]) p.style[`margin${cap(side)}`] = m;
        }
      });
    }

    /** "Default" for a style derived from "Default-outline1", so other levels can be looked up. */
    outlineStylePrefix(name) {
      for (let i = 0; name && i < 10; i++) {
        const m = /^(.*)-outline1$/.exec(name);
        if (m) return m[1];
        name = attr(this.styles.styles.get(`presentation:${name}`), 'style', 'parent-style-name');
      }
      return null;
    }

    shapeProps(el) {
      const pres = attr(el, 'presentation', 'style-name');
      return pres ? this.styles.props('presentation', pres) : this.styles.props('graphic', attr(el, 'draw', 'style-name'));
    }

    place(box, el) {
      const w = toMM(attr(el, 'svg', 'width'));
      const h = toMM(attr(el, 'svg', 'height'));
      if (w == null || h == null) return false;
      let x = toMM(attr(el, 'svg', 'x')) || 0;
      let y = toMM(attr(el, 'svg', 'y')) || 0;
      let rotate = 0;
      const tf = attr(el, 'draw', 'transform');
      if (tf) {
        const r = /rotate\s*\(\s*([-\d.eE]+)\s*\)/.exec(tf);
        if (r) rotate = -parseFloat(r[1]); // ODF turns counter-clockwise
        const t = /translate\s*\(\s*(\S+)\s+([^\s)]+)\s*\)/.exec(tf);
        if (t) {
          x = toMM(t[1]) ?? x;
          y = toMM(t[2]) ?? y;
        }
      }
      Object.assign(box.style, { left: `${x}mm`, top: `${y}mm`, width: `${w}mm`, height: `${h}mm` });
      if (rotate) Object.assign(box.style, { transform: `rotate(${rotate}rad)`, transformOrigin: '0 0' });
      return true;
    }

    shape(el) {
      const kind = el.localName;
      if (!['frame', 'custom-shape', 'rect', 'ellipse', 'circle', 'caption'].includes(kind)) return null;
      const box = make('div', null, 'odf-shape');
      if (!this.place(box, el)) return null;

      const props = this.shapeProps(el);
      const g = props.graphic || {};
      Object.assign(box.style, textCss(props.text, this), fillCss(g, this), strokeCss(g));
      const color = autoColor(props.text, g['draw:fill'] === 'solid' ? g['draw:fill-color'] : this.slideBackground);
      if (color) box.style.color = color;
      const textStyle = this.styles.props('paragraph', attr(el, 'draw', 'text-style-name'), false).para || {};
      const align = ALIGN[textStyle['fo:text-align'] || (props.para || {})['fo:text-align']];
      if (align) box.style.textAlign = align;
      for (const side of SIDES) if (g[`fo:padding-${side}`]) box.style[`padding${cap(side)}`] = g[`fo:padding-${side}`];
      const va = g['draw:textarea-vertical-align'] || (kind === 'frame' ? 'top' : 'middle');
      box.style.justifyContent = { middle: 'center', bottom: 'flex-end' }[va] || 'flex-start';
      if (g['draw:fit-to-size'] === 'true' || g['draw:fit-to-size'] === 'shrink-to-fit' || g['style:shrink-to-fit'] === 'true') {
        box.classList.add('shrink-to-fit');
      }

      let geometry = kind;
      if (kind === 'custom-shape') {
        const type = attr(child(el, 'draw', 'enhanced-geometry'), 'draw', 'type').toLowerCase();
        geometry = /ellipse|circle/.test(type) ? 'ellipse' : /round/.test(type) ? 'round' : 'rect';
      }
      if (geometry === 'ellipse' || geometry === 'circle') box.style.borderRadius = '50%';
      else if (geometry === 'round') box.style.borderRadius = '8%';

      if (kind === 'frame') {
        const textBox = child(el, 'draw', 'text-box');
        const table = child(el, 'table', 'table');
        if (textBox) {
          const prefix = attr(el, 'presentation', 'class') === 'outline' ? this.outlineStylePrefix(attr(el, 'presentation', 'style-name')) : null;
          this.outlinePrefix = prefix;
          this.blocks(textBox, box);
          this.outlinePrefix = null;
          this.paragraphSpacing(box, props, prefix);
        }
        else if (table) box.appendChild(this.table(table));
        else {
          const url = kids(el).filter((c) => is(c, 'draw', 'image')).map((c) => this.image(c)).find(Boolean);
          if (!url) return null; // charts/OLE objects with no browser-readable preview
          const img = make('img', { width: '100%', height: '100%', display: 'block' });
          img.alt = '';
          img.src = url;
          box.style.padding = '0';
          box.appendChild(img);
        }
      } else {
        this.blocks(el, box); // shapes hold their text directly
      }
      return box;
    }

    line(el) {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((a) => toMM(attr(el, 'svg', a)));
      if ([x1, y1, x2, y2].some((v) => v == null)) return null;
      const g = this.shapeProps(el).graphic || {};
      if (g['draw:stroke'] === 'none') return null;
      const w = Math.max(toMM(g['svg:stroke-width']) || 0, 0.26);
      return make('div', {
        position: 'absolute',
        left: `${x1}mm`,
        top: `${y1 - w / 2}mm`,
        width: `${Math.hypot(x2 - x1, y2 - y1)}mm`,
        height: `${w}mm`,
        background: g['svg:stroke-color'] || '#000',
        transform: `rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)`,
        transformOrigin: '0 50%',
      });
    }
  }

  /* ---------- document types ---------- */

  function withPageSize(layout, size) {
    if (!size) return layout;
    const landscape = layout.width > layout.height;
    return { ...layout, width: landscape ? size[1] : size[0], height: landscape ? size[0] : size[1] };
  }

  function textDocument(pkg, styles, body, opts, onPage) {
    const conv = new Converter(styles, pkg.images, { paraDefaults: true });
    const root = make('div');
    conv.blocks(body, root);
    if (conv.notes.length) {
      root.appendChild(make('hr', null, 'odf-notes-rule'));
      conv.notes.forEach((n) => root.appendChild(n));
    }
    // The page style comes from the first paragraph or table that names one, otherwise "Standard".
    const first = kids(body).find((el) => is(el, 'text', 'p') || is(el, 'text', 'h') || is(el, 'table', 'table'));
    const firstStyle = first && styles.styles.get(is(first, 'table')
      ? `table:${attr(first, 'table', 'style-name')}`
      : `paragraph:${attr(first, 'text', 'style-name')}`);
    const master = attr(firstStyle, 'style', 'master-page-name') || (styles.masters.has('Standard') ? 'Standard' : '');
    const layout = withPageSize(styles.pageLayout(master), opts.pageSize);
    return window.Render.flowToPdf(root, layout, { contentClass: 'odf-render', onPage });
  }

  function spreadsheet(pkg, styles, body, opts, onPage) {
    const basePt = parseFloat((styles.props('table-cell', 'Default').text || {})['fo:font-size']) || 10;
    const conv = new Converter(styles, pkg.images, { paraDefaults: false, em: basePt });
    const sheets = kids(body).filter((t) => is(t, 'table', 'table')
      && (styles.props('table', attr(t, 'table', 'style-name')).table || {})['table:display'] !== 'false');
    const root = make('div');
    let count = 0;
    for (const sheet of sheets) {
      const table = conv.sheet(sheet, opts.gridlines);
      if (!table) continue;
      if (sheets.length > 1) {
        const title = make('h2', null, 'sheet-name');
        title.textContent = attr(sheet, 'table', 'name');
        if (count) title.dataset.pageBreak = 'before';
        root.appendChild(title);
      } else if (count) {
        table.dataset.pageBreak = 'before';
      }
      root.appendChild(table);
      count++;
    }
    if (!count) throw new Error('This spreadsheet is empty — there is nothing to convert.');
    const first = sheets[0] && styles.styles.get(`table:${attr(sheets[0], 'table', 'style-name')}`);
    const layout = withPageSize(styles.pageLayout(attr(first, 'style', 'master-page-name') || 'Default'), opts.pageSize);
    return window.Render.flowToPdf(root, layout, { contentClass: 'odf-render', autoLandscape: true, onPage });
  }

  function slides(pkg, styles, body, onPage) {
    const conv = new Converter(styles, pkg.images, { paraDefaults: false });
    const pages = kids(body).filter((p) => is(p, 'draw', 'page')).map((p) => conv.slide(p));
    if (!pages.length) throw new Error('This presentation has no slides.');
    return window.Render.pagesToPdf(pages, { onPage });
  }

  async function toPdf(file, opts, progress) {
    progress(0.02, `Reading ${file.name}`);
    const pkg = await readPackage(file);
    const styles = new Styles([pkg.styles, pkg.content]);
    const officeBody = pkg.content.getElementsByTagNameNS(NS.office, 'body')[0];
    const body = kids(officeBody).find((c) => is(c, 'office'));
    const onPage = (i, n) => progress(0.15 + (0.85 * i) / n, `Rendering page ${i + 1} of ${n}`);
    progress(0.08, `Laying out ${file.name}`);
    switch (body && body.localName) {
      case 'text': return textDocument(pkg, styles, body, opts, onPage);
      case 'spreadsheet': return spreadsheet(pkg, styles, body, opts, onPage);
      case 'presentation': case 'drawing': return slides(pkg, styles, body, onPage);
      default: throw new Error(`"${file.name}" is a kind of OpenDocument file that can't be converted (only text documents, spreadsheets, presentations and drawings).`);
    }
  }

  /** The file's kind and the preview image LibreOffice/OpenOffice store inside every ODF file. */
  async function describe(file) {
    const JSZip = await U.lib('jszip');
    const zip = await JSZip.loadAsync(file);
    const mimeEntry = zip.file('mimetype');
    const mime = mimeEntry ? (await mimeEntry.async('string')).trim() : '';
    const kinds = { text: 'Text document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', graphics: 'Drawing' };
    const thumb = zip.file('Thumbnails/thumbnail.png');
    return {
      kind: kinds[mime.split('.').pop().replace(/-template$/, '')] || '',
      thumb: thumb ? new Blob([await thumb.async('uint8array')], { type: 'image/png' }) : null,
    };
  }

  window.ODF = { toPdf, describe };
})();
