/* UI: routing, home page, tool workspace (upload → options → convert → download). */
(function () {
  'use strict';
  const U = window.Util;
  const TOOLS = window.TOOLS;
  const icon = window.icon;
  const pixelArt = window.pixelArt;
  const SITE_TITLE = 'Free PDF & Image Converter';

  const app = document.getElementById('app');
  // Header nav routes (#/pdf, #/images, #/convert) filter the tool grid.
  const FILTER_ROUTES = { '': 'all', pdf: 'pdf', images: 'image', convert: 'convert' };
  const SECTION_TITLES = { all: 'Pick a tool', pdf: 'PDF tools', image: 'Image tools', convert: 'Converters' };
  let filter = 'all';
  let nextId = 1;
  let renderToken = 0;
  let heroTimer = null;

  const state = {
    tool: null,
    files: [], // { id, file, thumb, thumbOwned, info }
    opts: {},
    stage: 'empty', // empty | files | working | done
    outputs: [], // { name, blob, url, note }
    summary: null,
    error: null,
    run: 0,
    sortable: null,
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const formatsOf = (t) => t.formats || t.exts.map((e) => e.toUpperCase()).join(', ');

  /* ---------- routing ---------- */

  function route() {
    clearInterval(heroTimer);
    const id = location.hash.replace(/^#\/?/, '');
    const tool = TOOLS.find((t) => t.id === id) || null;
    resetState(tool);
    if (tool) {
      renderTool();
      window.scrollTo(0, 0);
    } else {
      filter = FILTER_ROUTES[id] || 'all';
      renderHome();
      if (filter === 'all') window.scrollTo(0, 0);
      else document.getElementById('tools').scrollIntoView();
    }
    document.title = tool ? `${tool.name} — ${SITE_TITLE}` : SITE_TITLE;
    document.querySelectorAll('[data-nav]').forEach((a) => {
      if (!tool && FILTER_ROUTES[a.dataset.nav] === filter) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function clearOutputs() {
    state.outputs.forEach((o) => URL.revokeObjectURL(o.url));
    state.outputs = [];
    state.summary = null;
  }

  function releaseFile(item) {
    if (item.thumbOwned) URL.revokeObjectURL(item.thumb);
  }

  function resetState(tool) {
    state.run++; // invalidates any conversion still in flight
    state.files.forEach(releaseFile);
    clearOutputs();
    state.tool = tool;
    state.files = [];
    state.stage = 'empty';
    state.error = null;
    state.opts = tool ? Object.fromEntries(tool.options.map((o) => [o.key, o.default])) : {};
  }

  /* ---------- home ---------- */

  const DIVIDER = '<div class="pixel-divider" aria-hidden="true"><i></i><i></i><i></i><b></b><i></i><i></i><i></i></div>';

  function renderHome() {
    const cards = TOOLS
      .filter((t) => filter === 'all' || t.tags.includes(filter))
      .map((t) => `
        <a class="tool-card pixel-card" href="#/${t.id}">
          <span class="tile">${icon(t.icon)}</span>
          <h3 class="tool-card-name">${t.name}</h3>
          <p class="tool-card-desc">${t.desc}</p>
        </a>`).join('');

    app.innerHTML = `
      <section class="hero">
        <div class="hero-text">
          <p class="badge">100% free · nothing gets uploaded</p>
          <h1>Convert, merge &amp; compress files <mark>in seconds</mark></h1>
          <p class="lead">PDFs, Word and OpenDocument files, photos and more — handled right in your browser. No sign-up, no watermarks, and your files never leave your device.</p>
          <div class="hero-actions">
            <button type="button" class="btn btn-tool btn-lg" data-scroll="tools">Pick a tool ${icon('arrowRight')}</button>
            <button type="button" class="btn btn-lg" data-scroll="why">Why it's private</button>
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="retro-window pixel-card" id="retro-window">
            <div class="rw-titlebar"><span>convert.exe</span><span class="rw-buttons"><i></i><i></i><i></i></span></div>
            <div class="rw-body">
              <div class="rw-files">
                <div class="pixel-file" data-file="from"></div>
                <div class="pixel-arrow">${pixelArt(ARROW_ART, { K: '#0a0a0a', Y: '#ffca2d' })}</div>
                <div class="pixel-file" data-file="to"></div>
              </div>
              <div class="rw-progress">${'<i></i>'.repeat(10)}</div>
              <p class="rw-status"><span class="rw-status-text">Converting...</span><span class="blink">_</span></p>
            </div>
          </div>
          <span class="sticker sticker-red">${TOOLS.length} tools</span>
          <span class="sticker sticker-white">0 uploads</span>
        </div>
      </section>
      ${DIVIDER}
      <section class="section" id="tools" aria-labelledby="tools-title">
        <h2 class="section-title" id="tools-title">${SECTION_TITLES[filter]}</h2>
        <div class="tool-grid">${cards}</div>
      </section>
      ${DIVIDER}
      <section class="section" id="why" aria-labelledby="why-title">
        <h2 class="section-title" id="why-title">Why use it?</h2>
        <div class="features">
          <div class="feature pixel-card">
            <span class="tile">${icon('lock')}</span>
            <h3>Private by design</h3>
            <p>Files are processed right on your device. Nothing is uploaded to a server, ever.</p>
          </div>
          <div class="feature pixel-card">
            <span class="tile">${icon('zap')}</span>
            <h3>Fast</h3>
            <p>No waiting for uploads or downloads. Conversions start the moment you click.</p>
          </div>
          <div class="feature pixel-card">
            <span class="tile">${icon('tag')}</span>
            <h3>Free, no strings</h3>
            <p>No accounts, no watermarks, no daily limits. Just pick a tool and go.</p>
          </div>
        </div>
      </section>`;
    startHeroDemo();
  }

  /* ---------- hero animation: a tiny "convert.exe" cycling through example conversions ---------- */

  const FILE_ART = [
    'KKKKKKKKK....',
    'KWWWWWWWKK...',
    'KWWWWWWWKWK..',
    'KWWWWWWWKWWK.',
    'KWWWWWWWKKKKK',
    'KWLLLLLWWWWWK',
    'KWWWWWWWWWWWK',
    'KWLLLLLLLLWWK',
    'KWWWWWWWWWWWK',
    'KCCCCCCCCCCCK',
    'KCCCCCCCCCCCK',
    'KCCCCCCCCCCCK',
    'KCCCCCCCCCCCK',
    'KWWWWWWWWWWWK',
    'KWLLLLLLWWWWK',
    'KKKKKKKKKKKKK',
  ];
  const ARROW_ART = [
    '......K....',
    '......KK...',
    '......KYK..',
    'KKKKKKKYYK.',
    'KYYYYYYYYYK',
    'KKKKKKKYYK.',
    '......KYK..',
    '......KK...',
    '......K....',
  ];
  const FORMAT_COLORS = { DOCX: '#2563eb', XLSX: '#15803d', PDF: '#dc2626', JPG: '#16a34a', HEIC: '#9333ea', ODT: '#c026d3', PNG: '#0891b2', WEBP: '#ea580c' };
  const DEMOS = [['DOCX', 'PDF'], ['PDF', 'JPG'], ['XLSX', 'PDF'], ['HEIC', 'JPG'], ['ODT', 'PDF'], ['PNG', 'WEBP']];

  const fileArt = (ext) =>
    pixelArt(FILE_ART, { K: '#0a0a0a', W: '#ffffff', L: '#a1a1aa', C: FORMAT_COLORS[ext] }) + `<span>${ext}</span>`;

  function startHeroDemo() {
    const win = document.getElementById('retro-window');
    if (!win) return;
    const from = win.querySelector('[data-file="from"]');
    const to = win.querySelector('[data-file="to"]');
    const segments = win.querySelectorAll('.rw-progress i');
    const status = win.querySelector('.rw-status-text');
    let demo = 0;
    let step = 0;
    const show = () => {
      from.innerHTML = fileArt(DEMOS[demo][0]);
      to.innerHTML = fileArt(DEMOS[demo][1]);
    };
    show();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      segments.forEach((s) => s.classList.add('on'));
      status.textContent = 'Ready';
      return;
    }
    heroTimer = setInterval(() => {
      if (++step > 15) {
        step = 0;
        demo = (demo + 1) % DEMOS.length;
        show();
      }
      segments.forEach((s, i) => s.classList.toggle('on', i < step));
      status.textContent = step >= 10 ? `Done! ${DEMOS[demo][1]} saved` : `Converting ${DEMOS[demo][0]}...`;
    }, 200);
  }

  /* ---------- tool page ---------- */

  function renderTool() {
    const t = state.tool;
    const accept = t.exts.map((e) => '.' + e).join(',');
    app.innerHTML = `
      <section class="tool-page">
        <a class="btn back-link" href="#/">${icon('arrowLeft')} All tools</a>
        <header class="tool-header">
          <span class="tile lg">${icon(t.icon)}</span>
          <div>
            <h1>${t.name}</h1>
            <p>${t.desc}</p>
          </div>
        </header>
        <div id="workspace" class="workspace"></div>
        <input type="file" id="file-input" hidden ${t.multiple ? 'multiple' : ''} accept="${accept}">
      </section>`;

    const input = document.getElementById('file-input');
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });

    const ws = document.getElementById('workspace');
    ws.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
    });
    ws.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('dropzone')) {
        e.preventDefault();
        input.click();
      }
    });
    ws.addEventListener('input', onOptionInput);
    ws.addEventListener('change', onOptionInput);
    renderWorkspace();
  }

  const actions = {
    choose(el, e) {
      e.stopPropagation();
      document.getElementById('file-input').click();
    },
    remove(el) {
      const id = +el.dataset.id;
      const item = state.files.find((f) => f.id === id);
      if (item) releaseFile(item);
      state.files = state.files.filter((f) => f.id !== id);
      state.error = null;
      if (!state.files.length) state.stage = 'empty';
      renderWorkspace();
    },
    run: () => runTool(),
    back() {
      clearOutputs();
      state.stage = 'files';
      renderWorkspace();
    },
    reset() {
      resetState(state.tool);
      renderWorkspace();
    },
    async zip(el) {
      el.disabled = true;
      const label = el.innerHTML;
      el.innerHTML = `${icon('download')} Zipping…`;
      try {
        const blob = await U.zip(state.outputs);
        const first = state.files[0] ? U.baseName(state.files[0].file.name) : 'files';
        U.download(blob, state.files.length === 1 ? `${first}.zip` : `${state.tool.id}-files.zip`);
      } catch (err) {
        toast(err.message);
      } finally {
        el.disabled = false;
        el.innerHTML = label;
      }
    },
  };

  function renderWorkspace() {
    const ws = document.getElementById('workspace');
    if (!ws) return;
    const token = ++renderToken;
    if (state.sortable) {
      state.sortable.destroy();
      state.sortable = null;
    }

    if (state.stage === 'empty') ws.innerHTML = dropzoneHTML();
    else if (state.stage === 'done') ws.innerHTML = resultsHTML();
    else ws.innerHTML = filesHTML();

    const t = state.tool;
    if (t.sortable && state.stage === 'files' && state.files.length > 1) {
      U.lib('sortable').then((Sortable) => {
        const list = document.getElementById('file-list');
        if (token !== renderToken || !list) return;
        state.sortable = Sortable.create(list, {
          animation: 150,
          ghostClass: 'is-ghost',
          filter: '.icon-btn',
          preventOnFilter: false,
          onEnd() {
            const order = [...list.children].map((li) => +li.dataset.id);
            state.files.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            list.querySelectorAll('.file-index').forEach((el, i) => { el.textContent = i + 1; });
          },
        });
      }).catch(() => {});
    }
  }

  function dropzoneHTML() {
    const t = state.tool;
    return `
      <div class="dropzone" data-action="choose" tabindex="0" aria-label="Choose ${t.multiple ? 'files' : 'a file'} or drop them here">
        <span class="tile">${icon('upload')}</span>
        <button type="button" class="btn btn-tool btn-lg" data-action="choose" tabindex="-1">${icon('plus')} Choose ${t.multiple ? 'files' : 'file'}</button>
        <p class="dz-hint">or drop ${t.multiple ? t.noun + 's' : 'a ' + t.noun} here</p>
        <p class="dz-formats">${esc(formatsOf(t))}</p>
      </div>
      <p class="privacy-note">${icon('lock')} Your files are processed on this device and never uploaded.</p>`;
  }

  function fileItemHTML(item, index) {
    const t = state.tool;
    const f = item.file;
    const thumb = item.thumb
      ? `<img src="${item.thumb}" alt="">`
      : `<span class="file-badge">${esc(U.fileExt(f).slice(0, 4) || 'file')}</span>`;
    return `
      <li class="file-item" data-id="${item.id}">
        ${t.sortable ? `<span class="file-index" aria-hidden="true">${index + 1}</span>` : ''}
        <span class="file-thumb">${thumb}</span>
        <span class="file-meta">
          <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="file-info">${U.formatBytes(f.size)}${item.info ? ' · ' + esc(item.info) : ''}</span>
        </span>
        <button type="button" class="icon-btn" data-action="remove" data-id="${item.id}" aria-label="Remove ${esc(f.name)}" title="Remove">${icon('x')}</button>
      </li>`;
  }

  function filesHTML() {
    const t = state.tool;
    const working = state.stage === 'working';
    const n = state.files.length;
    const needMore = t.minFiles && n < t.minFiles;
    return `
      <div class="files-layout${working ? ' is-working' : ''}">
        <div class="panel file-panel">
          <div class="panel-head">
            <h2>${plural(n, t.noun)} selected</h2>
            <button type="button" class="btn btn-ghost" data-action="choose" ${working ? 'disabled' : ''}>
              ${t.multiple ? `${icon('plus')} Add more` : `${icon('refresh')} Replace`}
            </button>
          </div>
          ${t.sortable && n > 1 ? `<p class="panel-sub">Drag files to change the order.</p>` : ''}
          <ul class="file-list${t.sortable && n > 1 ? ' is-sortable' : ''}" id="file-list">
            ${state.files.map(fileItemHTML).join('')}
          </ul>
          ${needMore ? `<p class="panel-sub need-more">${icon('info')} Add at least ${plural(t.minFiles, t.noun)} to ${t.name.toLowerCase()}.</p>` : ''}
        </div>
        <aside class="panel options-panel">
          ${t.options.length ? `<h2>Options</h2>` : ''}
          <fieldset ${working ? 'disabled' : ''}>
            ${t.options.map(optionHTML).join('')}
          </fieldset>
          ${t.note ? `<p class="tool-note">${icon('info')}<span>${esc(t.note)}</span></p>` : ''}
          ${state.error ? `<div class="alert" role="alert">${icon('alert')}<span>${esc(state.error)}</span></div>` : ''}
          ${working ? `
            <div class="progress-wrap">
              <div class="progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="progress-bar" id="progress-bar"></div>
              </div>
              <p class="progress-label" id="progress-label" aria-live="polite">Getting ready…</p>
            </div>` : `
            <button type="button" class="btn btn-tool btn-lg btn-block" data-action="run" ${needMore ? 'disabled' : ''}>
              ${t.action} ${icon('arrowRight')}
            </button>`}
        </aside>
      </div>`;
  }

  /* ---------- options ---------- */

  const isVisible = (o) => !o.showIf || o.showIf(state.opts, state.files);
  const hintOf = (o) => (typeof o.hint === 'function' ? o.hint(state.opts) : o.hint) || '';

  function optionHTML(o) {
    const v = state.opts[o.key];
    const id = `opt-${o.key}`;
    let control;
    switch (o.type) {
      case 'choice':
        control = `
          <div class="segmented" role="radiogroup" aria-labelledby="${id}-label">
            ${o.choices.map(([val, label]) => `
              <label class="seg"><input type="radio" name="${id}" value="${val}" data-key="${o.key}" ${String(v) === val ? 'checked' : ''}><span>${label}</span></label>`).join('')}
          </div>`;
        break;
      case 'select':
        control = `<select id="${id}" data-key="${o.key}">${o.choices.map(([val, label]) => `<option value="${val}" ${String(v) === val ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
        break;
      case 'range':
        control = `
          <div class="range-row">
            <input type="range" id="${id}" data-key="${o.key}" min="${o.min}" max="${o.max}" step="${o.step}" value="${v}">
            <output for="${id}" data-output="${o.key}">${v}${o.unit || ''}</output>
          </div>`;
        break;
      case 'text':
        control = `<input type="text" id="${id}" data-key="${o.key}" value="${esc(v)}" placeholder="${esc(o.placeholder || '')}" autocomplete="off" spellcheck="false">`;
        break;
      case 'toggle':
        control = `
          <label class="toggle">
            <input type="checkbox" data-key="${o.key}" ${v ? 'checked' : ''}>
            <span class="toggle-track" aria-hidden="true"></span>
            <span>${o.label}</span>
          </label>`;
        break;
    }
    const label = o.type === 'toggle' ? ''
      : o.type === 'choice' ? `<span class="opt-label" id="${id}-label">${o.label}</span>`
      : `<label class="opt-label" for="${id}">${o.label}</label>`;
    const hint = hintOf(o);
    return `
      <div class="opt" data-opt="${o.key}" ${isVisible(o) ? '' : 'hidden'}>
        ${label}${control}
        <p class="opt-hint" data-hint="${o.key}" ${hint ? '' : 'hidden'}>${esc(hint)}</p>
      </div>`;
  }

  function onOptionInput(e) {
    const el = e.target;
    const key = el.dataset && el.dataset.key;
    if (!key || !state.tool) return;
    state.opts[key] = el.type === 'checkbox' ? el.checked : el.value;
    const out = document.querySelector(`[data-output="${key}"]`);
    if (out) out.textContent = el.value + (state.tool.options.find((o) => o.key === key).unit || '');
    if (state.error && e.type === 'change') {
      state.error = null;
      const alert = document.querySelector('.options-panel .alert');
      if (alert) alert.remove();
    }
    for (const o of state.tool.options) {
      const wrap = document.querySelector(`[data-opt="${o.key}"]`);
      if (wrap) wrap.hidden = !isVisible(o);
      const hintEl = document.querySelector(`[data-hint="${o.key}"]`);
      if (hintEl) {
        const h = hintOf(o);
        hintEl.textContent = h;
        hintEl.hidden = !h;
      }
    }
  }

  /* ---------- files ---------- */

  function accepts(t, file) {
    return t.exts.includes(U.fileExt(file));
  }

  function addFiles(list) {
    const t = state.tool;
    if (!t || state.stage === 'working') return;
    const incoming = [...list];
    const ok = incoming.filter((f) => accepts(t, f));
    const skipped = incoming.length - ok.length;
    if (skipped) toast(`${plural(skipped, 'file')} skipped — ${t.name} works with ${formatsOf(t)}.`);
    if (!ok.length) return;

    if (state.stage === 'done') resetState(t);
    if (!t.multiple) {
      if (ok.length > 1) toast(`${t.name} works on one file at a time — using "${ok[0].name}".`);
      state.files.forEach(releaseFile);
      state.files = [];
    }
    for (const file of t.multiple ? ok : ok.slice(0, 1)) {
      const item = { id: nextId++, file, thumb: null, thumbOwned: false, info: '' };
      state.files.push(item);
      describe(item);
    }
    state.stage = 'files';
    state.error = null;
    renderWorkspace();
  }

  /** Build a thumbnail and a short description (page count / dimensions) for a file. */
  async function describe(item) {
    const f = item.file;
    const e = U.fileExt(f);
    try {
      if (e === 'pdf') {
        const { url, pages } = await U.pdfThumb(f);
        item.thumb = url;
        item.info = plural(pages, 'page');
      } else if (f.type.startsWith('image/') && !U.isHeic(f)) {
        item.thumb = URL.createObjectURL(f);
        item.thumbOwned = true;
        const img = new Image();
        img.src = item.thumb;
        await U.whenLoaded(img);
        if (img.naturalWidth) item.info = `${img.naturalWidth}×${img.naturalHeight}`;
      } else if (/^o[dt][tspg]$/.test(e)) {
        const { kind, thumb } = await window.ODF.describe(f);
        if (thumb) {
          item.thumb = URL.createObjectURL(thumb);
          item.thumbOwned = true;
        }
        item.info = kind;
      } else if (e === 'xlsx' || e === 'xlsm') {
        item.info = await window.Excel.describe(f);
      } else {
        return;
      }
    } catch (err) {
      item.info = /password/i.test(err.message) ? 'Password-protected' : 'Preview unavailable';
    }
    if (!state.files.includes(item)) return releaseFile(item);
    const li = document.querySelector(`.file-item[data-id="${item.id}"]`);
    if (li) li.outerHTML = fileItemHTML(item, state.files.indexOf(item));
  }

  /* ---------- run ---------- */

  async function runTool() {
    const t = state.tool;
    const runId = ++state.run;
    state.stage = 'working';
    state.error = null;
    renderWorkspace();

    const progress = (fraction, label) => {
      if (runId !== state.run) return;
      const pct = Math.max(3, Math.min(100, Math.round(fraction * 100)));
      const bar = document.getElementById('progress-bar');
      const lbl = document.getElementById('progress-label');
      if (bar) {
        bar.style.width = pct + '%';
        bar.parentElement.setAttribute('aria-valuenow', pct);
      }
      if (lbl && label) lbl.textContent = label;
    };

    try {
      const result = await t.run(state.files.map((f) => f.file), { ...state.opts }, { progress });
      if (runId !== state.run) return;
      progress(1, 'Done');
      state.outputs = U.uniqueNames(result.outputs).map((o) => ({ ...o, url: URL.createObjectURL(o.blob) }));
      state.summary = result.summary || null;
      state.stage = 'done';
    } catch (err) {
      if (runId !== state.run) return;
      console.error(err);
      state.error = (err && err.message) || 'Something went wrong. Please try again.';
      state.stage = 'files';
    }
    renderWorkspace();
    const ws = document.getElementById('workspace');
    if (ws && ws.getBoundingClientRect().top < 0) ws.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- results ---------- */

  function outputItemHTML(o) {
    const isImage = o.blob.type.startsWith('image/');
    const e = U.ext(o.name);
    return `
      <li class="file-item">
        <span class="file-thumb">${isImage ? `<img src="${o.url}" alt="" loading="lazy">` : `<span class="file-badge">${esc(e || 'file')}</span>`}</span>
        <span class="file-meta">
          <span class="file-name" title="${esc(o.name)}">${esc(o.name)}</span>
          <span class="file-info">${U.formatBytes(o.blob.size)}${o.note ? ' · ' + esc(o.note) : ''}</span>
        </span>
        <a class="icon-btn" href="${o.url}" target="_blank" rel="noopener" aria-label="Open ${esc(o.name)} in a new tab" title="Open">${icon('eye')}</a>
        <a class="btn btn-small" href="${o.url}" download="${esc(o.name)}" aria-label="Download ${esc(o.name)}">${icon('download')}<span>Download</span></a>
      </li>`;
  }

  function resultsHTML() {
    const n = state.outputs.length;
    const first = state.outputs[0];
    return `
      <div class="panel results">
        <div class="results-head">
          <span class="success-icon">${icon('check')}</span>
          <div>
            <h2>Done! ${n === 1 ? 'Your file is' : `Your ${n} files are`} ready</h2>
            ${state.summary ? `<p>${esc(state.summary)}</p>` : ''}
          </div>
        </div>
        <div class="results-actions">
          ${n > 1
            ? `<button type="button" class="btn btn-tool btn-lg" data-action="zip">${icon('download')} Download all (.zip)</button>`
            : `<a class="btn btn-tool btn-lg" href="${first.url}" download="${esc(first.name)}">${icon('download')} Download</a>`}
        </div>
        <ul class="file-list output-list">${state.outputs.map(outputItemHTML).join('')}</ul>
        <div class="results-footer">
          <button type="button" class="btn btn-ghost" data-action="back">${icon('arrowLeft')} Change options</button>
          <button type="button" class="btn btn-ghost" data-action="reset">${icon('refresh')} Start over</button>
          <a class="btn btn-ghost" href="#/">More tools</a>
        </div>
      </div>`;
  }

  /* ---------- page-wide drag & drop ---------- */

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const canDrop = () => state.tool && state.stage !== 'working';

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !canDrop()) return;
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault(); // also stops the browser from opening dropped files
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (canDrop()) addFiles(e.dataTransfer.files);
    else if (!state.tool) toast('Pick a tool first, then drop your files.');
  });

  /* ---------- toast & theme ---------- */

  let toastTimer;
  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
  }

  const themeBtn = document.getElementById('theme-toggle');
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  function paintThemeButton() {
    themeBtn.innerHTML = icon(isDark() ? 'sun' : 'moon');
    themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  }
  themeBtn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* storage unavailable */ }
    paintThemeButton();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeButton);
  paintThemeButton();

  /* ---------- page chrome: header icons, in-page scroll buttons, scroll meter, pixel cursor ---------- */

  document.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });

  app.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scroll]');
    if (btn) document.getElementById(btn.dataset.scroll).scrollIntoView({ behavior: 'smooth' });
  });

  const meter = document.getElementById('scroll-meter');
  let meterQueued = false;
  const paintMeter = () => {
    meterQueued = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    meter.style.height = `${max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0}%`;
  };
  const queueMeter = () => {
    if (!meterQueued) {
      meterQueued = true;
      requestAnimationFrame(paintMeter);
    }
  };
  window.addEventListener('scroll', queueMeter, { passive: true });
  window.addEventListener('resize', queueMeter);
  new ResizeObserver(queueMeter).observe(document.body);

  if (window.matchMedia('(pointer: fine)').matches) {
    const arrow = pixelArt([
      'K...........',
      'KK..........',
      'KWK.........',
      'KWWK........',
      'KWWWK.......',
      'KWWWWK......',
      'KWWWWWK.....',
      'KWWWWWWK....',
      'KWWWWWWWK...',
      'KWWWWWWWWK..',
      'KWWWWWWWWWK.',
      'KWWWWWWKKKKK',
      'KWWWKWWK....',
      'KWWKKWWK....',
      'KWK..KWWK...',
      'KK...KWWK...',
      'K.....KWWK..',
      '......KWWK..',
      '.......KK...',
    ], { K: '#0a0a0a', W: '#ffffff' }).replace('<svg ', '<svg width="24" height="38" ');
    document.documentElement.style.setProperty('--cursor', `url("data:image/svg+xml,${encodeURIComponent(arrow)}") 1 1, auto`);
  }

  document.getElementById('year').textContent = new Date().getFullYear();
  window.addEventListener('hashchange', route);
  route();
})();
