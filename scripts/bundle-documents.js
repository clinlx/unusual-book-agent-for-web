'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { root } = require('./build-common');
function bundleDocuments() {
  const read = file => fs.readFileSync(path.join(root, 'node_modules', file), 'utf8');
  const resources = {};
  const licenses = {};
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    resources[dir] = {};
    const base = path.join(root, 'node_modules/pdfjs-dist', dir);
    for (const name of fs.readdirSync(base)) if (/\.(bcmap|ttf|pfb|wasm)$/.test(name))
      resources[dir][name] = fs.readFileSync(path.join(base, name)).toString('base64');
    for (const name of fs.readdirSync(base)) if (/^LICENSE/.test(name))
      licenses['pdfjs-dist/' + dir + '/' + name] = fs.readFileSync(path.join(base, name), 'utf8');
  }
  for (const file of ['pdfjs-dist/LICENSE', 'mammoth/LICENSE', 'docx-preview/LICENSE', 'html2canvas/LICENSE', 'jszip/LICENSE.markdown'])
    licenses[file] = read(file);
  return {
    pdf: read('pdfjs-dist/legacy/build/pdf.mjs'), worker: read('pdfjs-dist/legacy/build/pdf.worker.mjs'), resources, licenses,
    mammoth: read('mammoth/mammoth.browser.min.js'), jszip: read('jszip/dist/jszip.min.js'),
    docx: read('docx-preview/dist/docx-preview.min.js'), canvas: read('html2canvas/dist/html2canvas.min.js'),
  };
}
module.exports = { bundleDocuments };
