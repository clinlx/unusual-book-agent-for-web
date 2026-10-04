'use strict';
const DocumentRuntime = (() => {
  let pdfLibrary, wordLibraries;
  function trustedScript(source) {
    const script = document.createElement('script');
    script.textContent = source; document.head.appendChild(script); script.remove();
  }
  async function loadPdf() {
    if (!pdfLibrary) pdfLibrary = (async () => {
      const url = URL.createObjectURL(new Blob([DOCUMENT_ASSETS.pdf], { type: 'text/javascript' }));
      try {
        const lib = await import(url);
        lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([DOCUMENT_ASSETS.worker], { type: 'text/javascript' }));
        return lib;
      } finally { URL.revokeObjectURL(url); }
    })().catch(e => { pdfLibrary = null; throw e; });
    return pdfLibrary;
  }
  async function loadWord(render) {
    if (!window.mammoth) trustedScript(DOCUMENT_ASSETS.mammoth);
    if (render && !wordLibraries) wordLibraries = Promise.resolve().then(() => {
      trustedScript(DOCUMENT_ASSETS.jszip); trustedScript(DOCUMENT_ASSETS.docx); trustedScript(DOCUMENT_ASSETS.canvas);
    }).catch(e => { wordLibraries = null; throw e; });
    if (render) await wordLibraries;
  }
  class EmbeddedBinaryData {
    async fetch({ kind, filename }) {
      const dir = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind];
      const data = DOCUMENT_ASSETS.resources[dir]?.[filename];
      if (!data) throw Error('缺少 PDF 资源: ' + filename);
      return Uint8Array.from(atob(data), c => c.charCodeAt(0));
    }
  }
  async function pageImage(canvas, page, check) {
    check();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw Error('无法生成文档页图');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const prepared = await Images.prepare(bytes);
    check();
    return { page, ...prepared, originalDataUrl: 'data:image/png;base64,' + Images.base64(bytes) };
  }
  async function pdf(bytes, args, options) {
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw Error('无效的 PDF 文件');
    const lib = await loadPdf(); options.check();
    const task = lib.getDocument({ data: bytes, useWorkerFetch: false, BinaryDataFactory: EmbeddedBinaryData,
      cMapUrl: 'embedded:/cmaps/', standardFontDataUrl: 'embedded:/standard_fonts/', wasmUrl: 'embedded:/wasm/', isEvalSupported: false });
    task.onPassword = () => task.destroy();
    const abort = () => { task.destroy().catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const doc = await task.promise; options.check();
      const info = options.pages(doc.numPages, args), text = [], images = [];
      for (let number = info.start_page; number <= info.end_page; number++) {
        options.check(); const page = await doc.getPage(number);
        try {
          if (args.format === 'text') {
            const content = await page.getTextContent();
            let line = '', previous;
            for (const item of content.items) {
              if (typeof item.str !== 'string') continue;
              const y = item.transform[5];
              if (previous !== undefined && Math.abs(y - previous) > Math.max(2, item.height / 2) && !line.endsWith('\n')) line += '\n';
              line += item.str + (item.hasEOL ? '\n' : ' '); previous = y;
            }
            if (line.trim()) text.push('第 ' + number + ' 页\n' + line.trim());
          } else {
            const initial = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(1.5, 2048 / Math.max(initial.width, initial.height)) });
            const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            const rendering = page.render({ canvasContext: canvas.getContext('2d'), viewport });
            const stop = () => rendering.cancel(); options.signal?.addEventListener('abort', stop, { once: true });
            try { await rendering.promise; images.push(await pageImage(canvas, number, options.check)); }
            finally { options.signal?.removeEventListener('abort', stop); canvas.width = canvas.height = 0; }
          }
        } finally { page.cleanup(); }
      }
      return { info, text: text.join('\n\n'), images };
    } catch (e) {
      if (options.signal?.aborted) options.check();
      throw Error('PDF 解析失败: ' + e.message);
    } finally { options.signal?.removeEventListener('abort', abort); await task.destroy(); }
  }
  async function docx(bytes, args, options) {
    if (bytes[0] !== 80 || bytes[1] !== 75) throw Error('无效的 DOCX 文件');
    await loadWord(args.format === 'images'); options.check();
    if (args.format === 'text') {
      if (args.start_page !== undefined || args.end_page !== undefined) throw Error('DOCX 纯文字无固定页码，请使用 offset/limit');
      const extracted = await window.mammoth.extractRawText({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      return { text: extracted.value, info: {}, images: [] };
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin'); frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:1100px;height:1600px;border:0;pointer-events:none';
    frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data: blob:"><style>body{margin:0;background:white}</style><body></body>';
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    document.body.appendChild(frame);
    try {
      await loaded; options.check(); const doc = frame.contentDocument;
      await window.docx.renderAsync(bytes, doc.body, doc.head, { breakPages: true, ignoreLastRenderedPageBreak: false,
        useBase64URL: true, renderAltChunks: false, renderComments: false });
      await doc.fonts.ready;
      await Promise.all([...doc.images].map(image => image.decode().catch(() => {}))); options.check();
      const slices = [];
      for (const section of doc.body.querySelectorAll('section.docx')) {
        const rect = section.getBoundingClientRect();
        const height = Math.max(rect.height, section.scrollHeight);
        const pageHeight = parseFloat(frame.contentWindow.getComputedStyle(section).minHeight) || 1123;
        for (let y = 0; y < height - 1; y += pageHeight) slices.push({ section, width: rect.width, y, height: Math.min(pageHeight, height - y) });
      }
      if (!slices.length) throw Error('DOCX 未生成可读取的页面');
      const info = { ...options.pages(slices.length, args), note: 'DOCX 图片按浏览器排版，页码以本工具返回为准。' }, images = [];
      for (let number = info.start_page; number <= info.end_page; number++) {
        options.check(); const slice = slices[number - 1];
        const canvas = await window.html2canvas(slice.section, { x: 0, y: slice.y, width: slice.width, height: slice.height,
          scale: Math.min(1.5, 2048 / Math.max(slice.width, slice.height)), backgroundColor: '#ffffff', logging: false,
          windowWidth: 1100, windowHeight: 1600 });
        try { images.push(await pageImage(canvas, number, options.check)); }
        finally { canvas.width = canvas.height = 0; }
      }
      return { info, images };
    } finally { frame.remove(); }
  }
  return { pdf, docx };
})();
