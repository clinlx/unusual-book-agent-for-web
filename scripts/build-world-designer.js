'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { root, safeJSON, scripts, compose } = require('./build-common.js');
const { buildSnapshot } = require('./bundle-skills.js');
const { bundleDocuments } = require('./bundle-documents.js');
const SKILLS = ['write-novel', 'desire-analysis', 'grilling', 'game-world-builder'];
const modules = ['00-config', 'vfs', 'tokens', 'temp-files', 'images', 'document-runtime', 'documents', 'compress',
  'sse', 'zip', 'workspace-import', 'skills', 'skill-loader', 'versioning', 'diff',
  'pending', 'md', 'db', 'storage', 'builder-tools', 'validation', 'agent', 'lease', 'resources', 'ui'];

function buildWorldDesigner() {
  const assets = path.join(root, 'assets/world-designer');
  const enabled = JSON.parse(fs.readFileSync(path.join(assets, 'skill_enable_list.json'), 'utf8'));
  if (JSON.stringify(enabled) !== JSON.stringify(SKILLS))
    throw Error('世界设计者的内置技能清单必须包含且仅包含指定的四个技能');
  const warnings = [];
  const bundled = buildSnapshot(assets, {
    skillDirectories: { 'game-world-builder': path.join(root, 'skills/game-world-builder') },
    warn: message => warnings.push(message),
  });
  if (!bundled || bundled.stats.length !== SKILLS.length || warnings.length)
    throw Error('世界设计者技能打包不完整：' + warnings.join('; '));
  const builderPrefix = 'skills/game-world-builder/';
  bundled.snapshot[builderPrefix + 'manifest.json'] = JSON.stringify({
    files: Object.keys(bundled.snapshot).filter(file => file.startsWith(builderPrefix))
      .map(file => file.slice(builderPrefix.length)).filter(file => file !== 'SKILL.md' && file !== 'manifest.json'),
  });
  const source = scripts(['vendor/marked.min.js', 'skills/game-world-builder/scripts/validate_game_structure.js', 'src/shared/api-url.js', 'src/shared/world-handoff.js', 'src/shared/transfer-dialog.js', 'src/shared/designer-projects.js', 'src/shared/back-navigation.js',
    ...modules.map(name => 'src/world-designer/' + name + '.js')]);
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'skills/game-world-builder/scripts/world-schema.json'), 'utf8'));
  const prefix = 'const BUNDLED_SKILLS = ' + safeJSON(bundled.snapshot) + ';\n'
    + 'const WORLD_BUILDER_SCHEMA = ' + safeJSON(schema) + ';\n'
    + 'const DOCUMENT_ASSETS = ' + safeJSON(bundleDocuments()) + ';\n';
  const settings = 'const WORLD_DESIGNER_STANDALONE = true;\n';
  const html = compose('src/world-designer/template.html', 'src/world-designer/styles.css', prefix + settings + source);
  fs.writeFileSync(path.join(root, 'dist/designer.html'), html);
  // Only remove the former generated designer artifacts, never source skills or other dist files.
  const dist = path.resolve(root, 'dist');
  for (const name of ['world-designer.html', 'world-designer.standalone.html', 'world-designer']) {
    const target = path.resolve(dist, name);
    if (path.dirname(target) !== dist) throw Error('Invalid obsolete output path');
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log('Built dist/designer.html (' + Math.round(Buffer.byteLength(html) / 1024) + ' KiB), 4 embedded isolated skills.');
}
module.exports = { buildWorldDesigner };
