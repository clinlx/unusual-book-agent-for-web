'use strict';
const fs=require('node:fs'),path=require('node:path');
const JavaScriptObfuscator=require('javascript-obfuscator');
const Build=require('./scripts/build-common.js');
const {buildWorldDesigner}=require('./scripts/build-world-designer.js');
const {root,read,safeJSON}=Build;
const prompts={};
for(const {id} of require('./src/game-prompts.js').list())prompts[id]=read('assets/prompts/'+id);
const ruleBooks={};
function collectBooks(dir,relative=''){
  if(!fs.existsSync(dir))return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const key=relative+entry.name,full=path.join(dir,entry.name);
    if(entry.isDirectory())collectBooks(full,key+'/');
    else if(entry.isFile()&&/\.(md|txt|json)$/i.test(entry.name))ruleBooks[key]=fs.readFileSync(full,'utf8');
  }
}
collectBooks(path.join(root,'assets','trpg_rule_books'));
const order=['vendor/marked.min.js','src/vfs.js','src/shared/file-write-validation.js','src/sse.js','src/zip.js','src/workspace-import.js','src/diff.js','src/md.js','src/lease.js','src/shared/api-url.js','src/shared/world-handoff.js','src/shared/transfer-dialog.js','src/shared/designer-projects.js','src/shared/back-navigation.js',
  'src/game-prompts.js','src/game-tools.js','src/game-data.js','src/game-history.js','src/game-presentation.js','src/game-core.js','src/game-import.js','src/game-catalog.js','src/game-store.js','src/game-transport.js','src/game-app.js','src/game-ui.js'];
const obfuscated=JavaScriptObfuscator.obfuscate(Build.scripts(order),{
  target:'browser-no-eval',compact:true,identifierNamesGenerator:'hexadecimal',
  renameGlobals:false,renameProperties:false,stringArray:true,stringArrayThreshold:0.75,
  stringArrayEncoding:['base64'],controlFlowFlattening:false,deadCodeInjection:false,
  selfDefending:false,debugProtection:false,sourceMap:false,seed:20260920
}).getObfuscatedCode();

const dice3d=read('node_modules/@3d-dice/dice-box-threejs/dist/dice-box-threejs.umd.js');
const scripts=dice3d+'\n;const BUNDLED_PROMPTS = '+safeJSON(prompts)+';\nconst BUNDLED_RULE_BOOKS = '+safeJSON(ruleBooks)+';\n'+obfuscated;
const html=Build.compose('src/template.html','src/game.css',scripts);
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
fs.writeFileSync(path.join(root,'dist','index.html'),html);

fs.copyFileSync(path.join(root,'assets/robots.txt'),path.join(root,'dist/robots.txt'));
console.log('Built dist/index.html with obfuscated inline JavaScript ('+Math.round(Buffer.byteLength(html)/1024)+' KiB), '+Object.keys(prompts).length+' prompt sources, '+Object.keys(ruleBooks).length+' rule book files.');
buildWorldDesigner();
