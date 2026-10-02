'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const safeJSON = value => JSON.stringify(value).replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const shared = new Set(['vfs', 'sse', 'zip', 'workspace-import', 'diff', 'md', 'lease']);
const configured = new Set(['vfs', 'workspace-import', 'lease']);

// Browser scripts use shared implementations, with page-specific policy adapters.
// CommonJS compatibility files remain available to existing callers and tests.
function scripts(files) {
  const seen = new Set();
  return files.flatMap(file => {
    const name = path.basename(file, '.js');
    return file.startsWith('src/') && shared.has(name)
      ? ['src/shared/' + name + '.js', ...(configured.has(name) ? [file] : [])]
      : [file];
  }).filter(file => !seen.has(file) && seen.add(file)).map(read).join('\n;\n');
}

function compose(template, styles, source) {
  return read(template).replace('/*__STYLES__*/', () => read(styles))
    .replace('/*__SCRIPTS__*/', () => source.replace(/<\/script/gi, '<\\/script'));
}
module.exports = { root, read, safeJSON, scripts, compose };
