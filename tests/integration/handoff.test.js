'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const ZIP=require('../../src/shared/zip');
const Handoff=require('../../src/shared/world-handoff');
const VFS=require('../../src/world-designer/vfs');
const fs=require('node:fs'),path=require('node:path');
test('async archive preserves bytes, empty directories, timestamps and allows rendering during a large file',async()=>{
 const entries=[{name:'中文.txt',text:'世界内容',mtime:1700000000000},{name:'empty/'},{name:'picture.png',bytes:new Uint8Array(8*1024*1024).fill(128)}];
 let ticks=0;const timer=setInterval(()=>ticks++,0),progress=[];
 let blob;try{blob=await ZIP.makeZipAsync(entries,p=>progress.push(p));}finally{clearInterval(timer);}
 assert.ok(ticks>0);assert.ok(progress.length>=2);assert.equal(progress.at(-1).completed,3);
 assert.deepEqual(Buffer.from(await blob.arrayBuffer()),Buffer.from(await ZIP.makeZip(entries).arrayBuffer()));
 const files=await ZIP.parseZip(await blob.arrayBuffer());
 assert.equal(files.length,3);assert.equal(files[2].bytes.length,entries[2].bytes.length);assert.equal(files[2].bytes[400],128);
});
test('world roots select only workspace worlds and preserve parent-world boundaries',()=>{
 const tree=VFS.createTree();
 VFS.mkdir(tree,'/workspace/世界甲/Player-a');VFS.mkdir(tree,'/workspace/世界乙/Player-b');
 assert.deepEqual(Handoff.roots(tree),['/workspace/世界甲','/workspace/世界乙']);
 VFS.mkdir(tree,'/workspace/Player-c');assert.deepEqual(Handoff.roots(tree),['/workspace']);
});
test('handoff links contain a validated ID and unavailable storage never silently becomes memory-only',async()=>{
 const id='12345678-1234-1234-1234-123456789abc';
 assert.equal(Handoff.fromHash('#handoff='+id),id);assert.equal(Handoff.saveId(id),'world-handoff-'+id);
 assert.equal(Handoff.fromHash('#other'),null);assert.throws(()=>Handoff.fromHash('#handoff=../bad'));
 await assert.rejects(Handoff.create(null).put(new Blob(['world']),'world'),/不支持/);
});
test('application scripts do not call native alert, confirm or prompt',()=>{
 function scan(dir){for(const file of fs.readdirSync(dir,{withFileTypes:true})){const name=path.join(dir,file.name);if(file.isDirectory())scan(name);else if(name.endsWith('.js'))assert.doesNotMatch(fs.readFileSync(name,'utf8'),/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/,name);}}
 scan(path.join(__dirname,'../../src'));
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../../src/game-app.js'),'utf8'),/\.returnValue\s*=/);
});
