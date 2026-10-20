/*
 * Tool definitions. Each tool describes its inputs, options, and a run() function that
 * receives File objects and returns { outputs: [{ name, blob, note? }], summary? }.
 * Everything runs in the browser — no file ever leaves the user's device.
 */
(function () {
  'use strict';
  const U = window.Util;

  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'avif', 'svg'];
  const IMAGE_FORMATS = 'JPG, PNG, WEBP, HEIC, GIF, BMP, AVIF, SVG';
  const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] }; // points
  const PAGE_MM = { a4: [210, 297], letter: [215.9, 279.4] };

  const pdfOutput = (name, bytes) => ({ name, blob: new Blob([bytes], { type: 'application/pdf' }) });

  function sizeChange(before, after) {
    const pct = Math.round((1 - after / before) * 100);
    return `${U.formatBytes(before)} → ${U.formatBytes(after)} (${pct >= 0 ? '−' + pct : '+' + -pct}%)`;
  }

  function savingsSummary(files, outputs) {
    const before = files.reduce((n, f) => n + f.size, 0);
    const after = outputs.reduce((n, o) => n + o.blob.size, 0);
    const pct = Math.round((1 - after / before) * 100);
    return pct > 0 ? `You saved ${pct}% — ${U.formatBytes(before)} down to ${U.formatBytes(after)}.` : null;
  }

  async function encodeImage(canvas, format, quality) {
    if (format === 'bmp') return U.encodeBMP(canvas);
    const blob = await U.canvasToBlob(canvas, IMAGE_TYPES[format], quality);
    if (blob.type !== IMAGE_TYPES[format]) throw new Error(`Your browser can't create ${format.toUpperCase()} images. Try another format.`);
    return blob;
  }

  /* ---------- tools ---------- */

  window.TOOLS = [
    {
      id: 'pdf-to-jpg',
      name: 'PDF to JPG',
      desc: 'Turn each page of a PDF into a JPG or PNG image.',
      icon: 'pdfToImage',
      tags: ['pdf', 'convert', 'image'],
      exts: ['pdf'],
      noun: 'PDF',
      multiple: true,
      action: 'Convert to images',
      options: [
        { key: 'format', label: 'Image format', type: 'choice', choices: [['jpg', 'JPG'], ['png', 'PNG']], default: 'jpg' },
        { key: 'dpi', label: 'Image quality', type: 'choice', choices: [['72', 'Low'], ['150', 'Medium'], ['300', 'High']], default: '150',
          hint: (o) => `${o.dpi} DPI${o.dpi === '300' ? ' — best for printing, larger files' : ''}` },
      ],
      async run(files, o, ctx) {
        const outputs = [];
        const type = o.format === 'png' ? 'image/png' : 'image/jpeg';
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const doc = await U.openPdfJs(f);
          try {
            for (let p = 1; p <= doc.numPages; p++) {
              ctx.progress((i + (p - 1) / doc.numPages) / files.length,
                `Rendering page ${p} of ${doc.numPages}${files.length > 1 ? ` (file ${i + 1} of ${files.length})` : ''}`);
              const { canvas } = await U.renderPdfPage(doc, p, +o.dpi / 72);
              const blob = await U.canvasToBlob(canvas, type, 0.92);
              const suffix = doc.numPages > 1 ? `-page-${p}` : '';
              outputs.push({ name: `${U.baseName(f.name)}${suffix}.${o.format}`, blob });
            }
          } finally {
            doc.destroy();
          }
        }
        return { outputs };
      },
    },

    {
      id: 'jpg-to-pdf',
      name: 'JPG to PDF',
      desc: 'Combine photos and images — JPG, PNG, HEIC and more — into a PDF.',
      icon: 'imageToPdf',
      tags: ['image', 'convert', 'pdf'],
      exts: IMAGE_EXTS,
      formats: IMAGE_FORMATS,
      noun: 'image',
      multiple: true,
      sortable: true,
      action: 'Create PDF',
      options: [
        { key: 'pageSize', label: 'Page size', type: 'choice', choices: [['a4', 'A4'], ['letter', 'US Letter'], ['fit', 'Fit image']], default: 'a4' },
        { key: 'orientation', label: 'Orientation', type: 'choice', choices: [['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], default: 'auto',
          showIf: (o) => o.pageSize !== 'fit' },
        { key: 'margin', label: 'Margin', type: 'choice', choices: [['0', 'None'], ['18', 'Small'], ['40', 'Large']], default: '18' },
        { key: 'combine', label: 'Merge all images into one PDF', type: 'toggle', default: true, showIf: (o, files) => files.length > 1 },
      ],
      async run(files, o, ctx) {
        const { PDFDocument } = await U.lib('pdfLib');
        const margin = +o.margin;
        const single = o.combine || files.length === 1;
        const outputs = [];
        let doc = single ? await PDFDocument.create() : null;

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          ctx.progress(i / files.length, `Adding image ${i + 1} of ${files.length}`);
          if (!single) doc = await PDFDocument.create();

          // Graphics keep PNG (lossless, transparency); photos are stored as JPG.
          const lossless = /png|gif|bmp|svg/.test(`${f.type} ${U.fileExt(f)}`);
          const canvas = await U.imageToCanvas(f, { background: lossless ? null : '#fff' });
          const encoded = await U.canvasToBlob(canvas, lossless ? 'image/png' : 'image/jpeg', 0.92);
          const bytes = new Uint8Array(await encoded.arrayBuffer());
          const img = lossless ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

          let pw;
          let ph;
          if (o.pageSize === 'fit') {
            const k = Math.min(0.75, (14400 - 2 * margin) / Math.max(img.width, img.height)); // px → pt, PDF max page size
            pw = img.width * k + 2 * margin;
            ph = img.height * k + 2 * margin;
          } else {
            [pw, ph] = PAGE_SIZES[o.pageSize];
            const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && img.width > img.height);
            if (landscape) [pw, ph] = [ph, pw];
          }
          const s = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height);
          const w = img.width * s;
          const h = img.height * s;
          doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });

          if (!single) outputs.push(pdfOutput(`${U.baseName(f.name)}.pdf`, await doc.save()));
          await U.tick();
        }
        if (single) {
          ctx.progress(0.95, 'Saving PDF…');
          outputs.push(pdfOutput(files.length === 1 ? `${U.baseName(files[0].name)}.pdf` : 'images.pdf', await doc.save()));
        }
        return { outputs };
      },
    },

    {
      id: 'merge-pdf',
      name: 'Merge PDF',
      desc: 'Combine several PDFs into one document, in the order you want.',
      icon: 'merge',
      tags: ['pdf'],
      exts: ['pdf'],
      noun: 'PDF',
      multiple: true,
      sortable: true,
      minFiles: 2,
      action: 'Merge PDFs',
      options: [],
      async run(files, o, ctx) {
        const { PDFDocument } = await U.lib('pdfLib');
        const merged = await PDFDocument.create();
        for (let i = 0; i < files.length; i++) {
          ctx.progress(i / files.length, `Adding ${files[i].name}`);
          const src = await U.openPdf(files[i]);
          const pages = await merged.copyPages(src, src.getPageIndices());
          pages.forEach((p) => merged.addPage(p));
        }
        ctx.progress(0.95, 'Saving merged PDF…');
        return { outputs: [pdfOutput('merged.pdf', await merged.save())] };
      },
    },

    {
      id: 'split-pdf',
      name: 'Split PDF',
      desc: 'Pull pages out of a PDF, or split it into several smaller files.',
      icon: 'split',
      tags: ['pdf'],
      exts: ['pdf'],
      noun: 'PDF',
      multiple: false,
      action: 'Split PDF',
      options: [
        { key: 'mode', label: 'How to split', type: 'choice', choices: [['ranges', 'By ranges'], ['every', 'Every page'], ['extract', 'Extract pages']], default: 'ranges' },
        { key: 'ranges', label: 'Pages', type: 'text', placeholder: 'e.g. 1-3, 5, 8-10', default: '', showIf: (o) => o.mode !== 'every',
          hint: (o) => (o.mode === 'extract' ? 'The pages you list are combined into one new PDF.' : 'Each range becomes its own PDF.') },
      ],
      async run([file], o, ctx) {
        const { PDFDocument } = await U.lib('pdfLib');
        const src = await U.openPdf(file);
        const total = src.getPageCount();
        const base = U.baseName(file.name);

        let groups;
        if (o.mode === 'every') {
          if (total === 1) throw new Error('This PDF only has one page, so there is nothing to split.');
          groups = Array.from({ length: total }, (_, i) => ({ pages: [i + 1], name: `${base}-page-${i + 1}.pdf` }));
        } else {
          const ranges = U.parseRanges(o.ranges, total);
          if (o.mode === 'extract') {
            const label = ranges.map((r) => r.label).join('_');
            groups = [{ pages: ranges.flatMap(U.rangePages), name: `${base}-${label.length > 30 ? 'extracted' : 'pages-' + label}.pdf` }];
          } else {
            groups = ranges.map((r) => ({ pages: U.rangePages(r), name: `${base}-${r.from === r.to ? 'page' : 'pages'}-${r.label}.pdf` }));
          }
        }

        const outputs = [];
        for (let i = 0; i < groups.length; i++) {
          ctx.progress(i / groups.length, `Creating file ${i + 1} of ${groups.length}`);
          const doc = await PDFDocument.create();
          const pages = await doc.copyPages(src, groups[i].pages.map((n) => n - 1));
          pages.forEach((p) => doc.addPage(p));
          outputs.push(pdfOutput(groups[i].name, await doc.save()));
        }
        return { outputs };
      },
    },

    {
      id: 'compress-pdf',
      name: 'Compress PDF',
      desc: 'Shrink PDF file size so it’s easier to email and share.',
      icon: 'compress',
      tags: ['pdf'],
      exts: ['pdf'],
      noun: 'PDF',
      multiple: true,
      action: 'Compress PDF',
      options: [
        { key: 'level', label: 'Compression', type: 'choice', choices: [['light', 'Light'], ['recommended', 'Recommended'], ['strong', 'Strong']], default: 'recommended',
          hint: (o) => ({
            light: 'Lossless clean-up. Text stays selectable, but savings are usually small.',
            recommended: 'Pages are re-saved as good-quality images. Big savings; text can no longer be selected.',
            strong: 'Smallest file, lower image quality. Great for scans you just need to send.',
          })[o.level] },
      ],
      async run(files, o, ctx) {
        const { PDFDocument } = await U.lib('pdfLib');
        const outputs = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const at = (x) => (i + x) / files.length;
          let bytes;
          if (o.level === 'light') {
            ctx.progress(at(0.3), `Optimizing ${f.name}`);
            bytes = await (await U.openPdf(f)).save({ useObjectStreams: true });
          } else {
            const [dpi, quality] = o.level === 'strong' ? [85, 0.5] : [125, 0.7];
            const src = await U.openPdfJs(f);
            const doc = await PDFDocument.create();
            try {
              for (let p = 1; p <= src.numPages; p++) {
                ctx.progress(at((p - 1) / src.numPages), `Compressing page ${p} of ${src.numPages}`);
                const { canvas, width, height } = await U.renderPdfPage(src, p, dpi / 72);
                const jpg = await U.canvasToBlob(canvas, 'image/jpeg', quality);
                const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
                doc.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
              }
            } finally {
              src.destroy();
            }
            bytes = await doc.save();
          }
          if (bytes.length >= f.size) {
            outputs.push({ name: f.name, blob: f, note: 'Already well optimized — kept the original' });
          } else {
            outputs.push({ ...pdfOutput(`${U.baseName(f.name)}-compressed.pdf`, bytes), note: sizeChange(f.size, bytes.length) });
          }
        }
        return { outputs, summary: savingsSummary(files, outputs) };
      },
    },

    {
      id: 'rotate-pdf',
      name: 'Rotate PDF',
      desc: 'Rotate all pages of a PDF, or just the ones you pick.',
      icon: 'rotate',
      tags: ['pdf'],
      exts: ['pdf'],
      noun: 'PDF',
      multiple: true,
      action: 'Rotate PDF',
      options: [
        { key: 'angle', label: 'Rotate', type: 'choice', choices: [['90', 'Right 90°'], ['180', '180°'], ['270', 'Left 90°']], default: '90' },
        { key: 'which', label: 'Pages', type: 'choice', choices: [['all', 'All pages'], ['some', 'Specific pages']], default: 'all' },
        { key: 'pages', label: 'Page numbers', type: 'text', placeholder: 'e.g. 1, 3-5', default: '', showIf: (o) => o.which === 'some' },
      ],
      async run(files, o, ctx) {
        const { degrees } = await U.lib('pdfLib');
        const outputs = [];
        for (let i = 0; i < files.length; i++) {
          ctx.progress(i / files.length, `Rotating ${files[i].name}`);
          const doc = await U.openPdf(files[i]);
          const only = o.which === 'some' ? new Set(U.parseRanges(o.pages, doc.getPageCount()).flatMap(U.rangePages)) : null;
          doc.getPages().forEach((page, idx) => {
            if (!only || only.has(idx + 1)) page.setRotation(degrees((page.getRotation().angle + +o.angle) % 360));
          });
          outputs.push(pdfOutput(`${U.baseName(files[i].name)}-rotated.pdf`, await doc.save()));
        }
        return { outputs };
      },
    },

    {
      id: 'word-to-pdf',
      name: 'Word to PDF',
      desc: 'Convert Word documents (.docx) into PDF files.',
      icon: 'word',
      tags: ['convert', 'pdf'],
      exts: ['docx'],
      formats: 'DOCX (Word 2007 and newer)',
      noun: 'Word document',
      multiple: true,
      action: 'Convert to PDF',
      note: 'Text, headings, lists, tables and images are kept. Complex layouts (columns, text boxes, headers and footers) come out simplified.',
      options: [
        { key: 'size', label: 'Page size', type: 'choice', choices: [['a4', 'A4'], ['letter', 'US Letter']], default: 'a4' },
        { key: 'margin', label: 'Margins', type: 'choice', choices: [['25', 'Normal'], ['15', 'Narrow']], default: '25' },
      ],
      async run(files, o, ctx) {
        const mammoth = await U.lib('mammoth');
        const outputs = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          ctx.progress(i / files.length, `Reading ${f.name}`);
          let html;
          try {
            ({ value: html } = await mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() }));
          } catch (e) {
            throw new Error(`"${f.name}" couldn't be read. Only .docx files (Word 2007 and newer) are supported.`);
          }
          ctx.progress((i + 0.2) / files.length, `Laying out ${f.name}`);
          const [width, height] = PAGE_MM[o.size];
          const m = +o.margin;
          const blob = await window.Render.flowToPdf(html, { width, height, margin: { top: m, right: m, bottom: m, left: m } }, {
            contentClass: 'docx-render',
            onPage: (p, n) => ctx.progress((i + 0.2 + (0.8 * p) / n) / files.length, `Rendering page ${p + 1} of ${n}`),
          });
          outputs.push({ name: `${U.baseName(f.name)}.pdf`, blob });
        }
        return { outputs };
      },
    },

    {
      id: 'excel-to-pdf',
      name: 'Excel to PDF',
      desc: 'Turn Excel spreadsheets (XLSX, XLS) and CSV files into tidy PDF pages.',
      icon: 'sheet',
      tags: ['convert', 'pdf'],
      exts: ['xlsx', 'xlsm', 'xls', 'xlsb', 'csv'],
      formats: 'XLSX, XLSM, XLS, XLSB, CSV',
      noun: 'spreadsheet',
      multiple: true,
      action: 'Convert to PDF',
      note: 'Values, number formats, fonts, colours, borders and merged cells are kept, and wide sheets shrink to fit the page. Charts, images and comments are left out; older .xls files keep their values but not their colours.',
      options: [
        { key: 'size', label: 'Page size', type: 'choice', choices: [['auto', 'As in file'], ['a4', 'A4'], ['letter', 'US Letter']], default: 'auto' },
        { key: 'sheets', label: 'Sheets', type: 'choice', choices: [['all', 'All sheets'], ['first', 'First sheet only']], default: 'all' },
        { key: 'gridlines', label: 'Show gridlines', type: 'toggle', default: true },
      ],
      async run(files, o, ctx) {
        const outputs = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const blob = await window.Excel.toPdf(f, {
            pageSize: o.size === 'auto' ? null : PAGE_MM[o.size],
            gridlines: o.gridlines,
            firstOnly: o.sheets === 'first',
          }, (frac, label) => ctx.progress((i + frac) / files.length, files.length > 1 ? `${label} (file ${i + 1} of ${files.length})` : label));
          outputs.push({ name: `${U.baseName(f.name)}.pdf`, blob });
        }
        return { outputs };
      },
    },

    {
      id: 'odf-to-pdf',
      name: 'ODF to PDF',
      desc: 'Convert OpenDocument files from LibreOffice or OpenOffice (ODT, ODS, ODP) into PDF.',
      icon: 'odf',
      tags: ['convert', 'pdf'],
      exts: ['odt', 'ods', 'odp', 'odg', 'ott', 'ots', 'otp'],
      formats: 'ODT, ODS, ODP, ODG (LibreOffice / OpenOffice)',
      noun: 'document',
      multiple: true,
      action: 'Convert to PDF',
      note: 'Text formatting, lists, tables, images, spreadsheets and slide layouts are kept. Charts, embedded objects and headers/footers are left out.',
      options: [
        { key: 'size', label: 'Page size', type: 'choice', choices: [['auto', 'As in file'], ['a4', 'A4'], ['letter', 'US Letter']], default: 'auto',
          hint: 'Presentations always keep their slide size.' },
        { key: 'gridlines', label: 'Show spreadsheet gridlines', type: 'toggle', default: true,
          showIf: (o, files) => files.some((f) => /^o[dt]s$/.test(U.fileExt(f.file))) },
      ],
      async run(files, o, ctx) {
        const outputs = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const blob = await window.ODF.toPdf(f, { pageSize: o.size === 'auto' ? null : PAGE_MM[o.size], gridlines: o.gridlines },
            (frac, label) => ctx.progress((i + frac) / files.length, files.length > 1 ? `${label} (file ${i + 1} of ${files.length})` : label));
          outputs.push({ name: `${U.baseName(f.name)}.pdf`, blob });
        }
        return { outputs };
      },
    },

    {
      id: 'pdf-to-text',
      name: 'PDF to Text',
      desc: 'Pull all the text out of a PDF into a plain .txt file.',
      icon: 'text',
      tags: ['pdf', 'convert'],
      exts: ['pdf'],
      noun: 'PDF',
      multiple: true,
      action: 'Extract text',
      options: [
        { key: 'markPages', label: 'Mark where each page starts', type: 'toggle', default: true },
      ],
      async run(files, o, ctx) {
        const outputs = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const doc = await U.openPdfJs(f);
          const pages = [];
          try {
            for (let p = 1; p <= doc.numPages; p++) {
              ctx.progress((i + (p - 1) / doc.numPages) / files.length, `Reading page ${p} of ${doc.numPages}`);
              const page = await doc.getPage(p);
              const content = await page.getTextContent();
              let text = '';
              for (const item of content.items) {
                if (!('str' in item)) continue;
                text += item.str;
                if (item.hasEOL) text += '\n';
              }
              pages.push(text.replace(/[ \t]+\n/g, '\n').trim());
              page.cleanup();
            }
          } finally {
            doc.destroy();
          }
          const words = pages.join(' ').split(/\s+/).filter(Boolean).length;
          const body = o.markPages ? pages.map((t, n) => `--- Page ${n + 1} ---\n${t}`).join('\n\n') : pages.join('\n\n');
          outputs.push({
            name: `${U.baseName(f.name)}.txt`,
            blob: new Blob([body], { type: 'text/plain;charset=utf-8' }),
            note: words ? `${words.toLocaleString()} words` : 'No text found — this may be a scanned PDF',
          });
        }
        return { outputs };
      },
    },

    {
      id: 'image-converter',
      name: 'Convert Image',
      desc: 'Change images between JPG, PNG, WEBP and BMP — iPhone HEIC photos too.',
      icon: 'convert',
      tags: ['image', 'convert'],
      exts: IMAGE_EXTS,
      formats: IMAGE_FORMATS,
      noun: 'image',
      multiple: true,
      action: 'Convert images',
      options: [
        { key: 'format', label: 'Convert to', type: 'choice', choices: [['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WEBP'], ['bmp', 'BMP']], default: 'jpg' },
        { key: 'quality', label: 'Quality', type: 'range', min: 10, max: 100, step: 5, default: 90, unit: '%', showIf: (o) => o.format === 'jpg' || o.format === 'webp' },
        { key: 'scale', label: 'Size', type: 'select', choices: [['100', 'Original size'], ['75', '75%'], ['50', '50%'], ['25', '25%']], default: '100' },
      ],
      async run(files, o, ctx) {
        const outputs = [];
        const opaque = o.format === 'jpg' || o.format === 'bmp';
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          ctx.progress(i / files.length, `Converting ${f.name}`);
          const canvas = await U.imageToCanvas(f, { scale: +o.scale / 100, background: opaque ? '#fff' : null });
          const blob = await encodeImage(canvas, o.format, +o.quality / 100);
          outputs.push({ name: `${U.baseName(f.name)}.${o.format}`, blob, note: `${canvas.width}×${canvas.height}` });
          await U.tick();
        }
        return { outputs };
      },
    },

    {
      id: 'compress-image',
      name: 'Compress Image',
      desc: 'Make photos and images smaller while keeping them looking good.',
      icon: 'compressImage',
      tags: ['image'],
      exts: IMAGE_EXTS,
      formats: IMAGE_FORMATS,
      noun: 'image',
      multiple: true,
      action: 'Compress images',
      options: [
        { key: 'quality', label: 'Quality', type: 'range', min: 10, max: 95, step: 5, default: 70, unit: '%', hint: 'Lower quality gives a smaller file.' },
        { key: 'maxDim', label: 'Maximum size', type: 'select', default: '0',
          choices: [['0', 'Keep original dimensions'], ['3840', '3840 px (4K)'], ['2560', '2560 px'], ['1920', '1920 px (Full HD)'], ['1280', '1280 px'], ['800', '800 px']] },
        { key: 'format', label: 'Output format', type: 'choice', choices: [['auto', 'Auto'], ['jpg', 'JPG'], ['webp', 'WEBP']], default: 'auto',
          hint: (o) => (o.format === 'auto' ? 'JPGs stay JPG; other images become WEBP, which keeps transparency.' : '') },
      ],
      async run(files, o, ctx) {
        const outputs = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          ctx.progress(i / files.length, `Compressing ${f.name}`);
          const srcExt = U.fileExt(f);
          const isJpeg = srcExt === 'jpg' || srcExt === 'jpeg';
          const format = o.format === 'auto' ? (isJpeg ? 'jpg' : 'webp') : o.format;
          const canvas = await U.imageToCanvas(f, { maxDim: +o.maxDim, background: format === 'jpg' ? '#fff' : null });
          const blob = await encodeImage(canvas, format, +o.quality / 100);
          const sameFormat = (format === 'jpg' && isJpeg) || (format === 'webp' && srcExt === 'webp');
          if (sameFormat && blob.size >= f.size) {
            outputs.push({ name: f.name, blob: f, note: 'Already optimized — kept the original' });
          } else {
            outputs.push({ name: `${U.baseName(f.name)}-compressed.${format}`, blob, note: sizeChange(f.size, blob.size) });
          }
          await U.tick();
        }
        return { outputs, summary: savingsSummary(files, outputs) };
      },
    },
  ];
})();
