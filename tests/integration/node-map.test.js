'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const M=require('../../src/node-map');
const V=require('../../src/vfs'),C=require('../../src/game-core'),P=require('../../src/game-presentation');
const Sync=require('../../src/multiplayer-sync'),History=require('../../src/game-history'),Tools=require('../../src/game-tools');
const node=(id,links=[],hidden=false,point)=>({'表面名字':'地点'+id,ID:id,'表面描述':'公开描述','剧情笔记':'SECRET_NOTE','连通性':links,'是否隐藏':hidden,...(point?{'位置参考坐标':point}:{})});
test('current location matches only unique public IDs, names or path endpoints without changing history',()=>{
 const map=M.snapshot([node('yard'),node('hall'),node('secret',[],true)],'yard'),before=structuredClone(map);
 for(const location of ['hall','地点hall','/workspace/存档-世界/house/hall',{ID:'hall'},{路径:'存档-世界/house/hall/场景台本.json'}])a.equal(M.matchLocation(map,location),'hall');
 for(const location of ['',null,'secret','可能在 hall 附近',{备注:'hall'}])a.equal(M.matchLocation(map,location),null);
 const ambiguous={...map,nodes:map.nodes.map(n=>({...n,name:'同名'}))};a.equal(M.matchLocation(ambiguous,'同名'),null);
 a.equal(M.focus(map,'hall').currentId,'hall');a.equal(M.focus(map,'secret').currentId,'yard');a.deepEqual(map,before);
});
test('location-only synchronization updates each player focus without changing the historical map',async()=>{
 const tree=V.createTree();for(const id of ['a','b']){V.writeFile(tree,'/workspace/Player-'+id+'/基础信息.json',JSON.stringify({当前位置:id==='a'?'yard':'hall'}));V.writeFile(tree,'/workspace/Player-'+id+'/背包.json','[]');}
 const s=C.createSave('定位同步',tree);s.events=[{type:'map',map:M.snapshot([node('yard'),node('hall')],'yard'),audience:'public',round:1}];
 const room={roomId:'map',epoch:0,members:{a:{actorId:'a',bindingVersion:1},b:{actorId:'b',bindingVersion:1},watch:{role:'spectator',permission:'all',view:'b',bindingVersion:1}}};
 const host=Sync.createHost({getSave:()=>s,getRoom:()=>room}),client=Sync.createClient();await client.apply(await host.sync('b'));
 a.deepEqual(client.getState().view.mapFocus,{eventId:'event-1',currentId:'hall'});a.equal(Sync.project(s,'a',{room,memberId:'a'}).mapFocus.currentId,'yard');
 a.equal(Sync.project(s,null,{room,memberId:'watch'}).mapFocus.currentId,'hall');room.members.watch.view='all';a.equal(Sync.project(s,null,{room,memberId:'watch'}).mapFocus,null);
 const before=client.request();V.writeFile(s.tree,'/workspace/Player-b/基础信息.json',JSON.stringify({当前位置:'yard'}));const update=await host.sync('b',before);a.equal(update.type,'incremental');a.deepEqual(update.events,[]);await client.apply(update);a.equal(client.getState().view.mapFocus.currentId,'yard');
 V.writeFile(s.tree,'/workspace/Player-b/基础信息.json',JSON.stringify({当前位置:'SECRET_UNMAPPED_LOCATION'}));const packet=await host.sync('b',client.request());a.doesNotMatch(JSON.stringify(packet),/SECRET_UNMAPPED_LOCATION|当前位置/);await client.apply(packet);a.equal(client.getState().view.mapFocus,null);
 a.equal(client.getState().view.events[0].map.currentId,'yard');
});
test('map validates all nodes before publishing and strips hidden nodes, links and notes',()=>{
 const raw=[node('a',['b','secret']),node('b',['a']),node('secret',[],true)];
 const snapshot=M.snapshot(raw,'a');
 a.equal(snapshot.nodes.length,2);a.equal(snapshot.edges.length,1);a.equal(snapshot.edges[0].directed,false);
 a.doesNotMatch(JSON.stringify(snapshot),/secret|SECRET_NOTE|剧情笔记/);
 a.throws(()=>M.snapshot(raw,'secret'),/隐藏/);a.throws(()=>M.snapshot(raw,'missing'),/当前位置/);
 a.throws(()=>M.snapshot([...raw,node('a')],''),/重复/);
 a.throws(()=>M.snapshot([node('a',['missing'])],''),/连通性/);
 a.throws(()=>M.snapshot([{...node('a'),'是否隐藏':'false'}],''),/是否隐藏/);
 a.throws(()=>M.snapshot([{...node('a'),'表面名字':' '}],''),/表面名字/);
 a.throws(()=>M.snapshot([node('a',[],false,{x:Infinity,y:0})],''),/坐标/);
 a.equal(M.snapshot(raw,'').currentId,'');a.deepEqual(M.snapshot([],''),{nodes:[],edges:[],currentId:''});
});
test('map tool schema keeps optional file and required current location, and tolerates empty highlights',()=>{
 const schema=Tools.build({toolDescription:n=>n}).find(t=>t.function.name==='show_map').function.parameters;
 a.deepEqual(schema.required,['current_id']);a.equal(schema.properties.current_id.type,'string');a.equal(schema.properties.current_id.minLength,undefined);
});
test('map snapshots survive round archives and context reconstruction without rereading the map',()=>{
 const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');
 const s=C.createSave('地图历史',tree);s.events=[{id:'map-one',type:'map',map:M.snapshot([node('a')],'a'),round:1,audience:'public'}];s.round=1;s.status='waiting';
 History.archive(s);const restored=C.createSave('恢复',structuredClone(s.tree));a.ok(History.restoreReference(restored));a.deepEqual(restored.events.find(e=>e.type==='map').map,s.events[0].map);
 C.rebuildContext(s);a.deepEqual(s.events.find(e=>e.type==='map').map,restored.events.find(e=>e.type==='map').map);
});
test('multiplayer map projection freezes old visibility and strips imported extension fields',()=>{
 const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');const s=C.createSave('地图同步',tree);
 const first=M.snapshot([node('a',['secret']),node('secret',[],true)],'a');first.notes='SECRET_EXTRA';first.nodes[0].剧情笔记='SECRET_EXTENSION';
 s.events=[{type:'map',map:first,audience:'public',round:1}];s.slots=[{id:'pc',path:'/workspace/Player-pc',kind:'player'}];
 const view=Sync.project(s,'pc');a.equal(view.events[0].type,'map');a.equal(view.events[0].map.nodes.length,1);a.doesNotMatch(JSON.stringify(view.events),/SECRET_|secret/);
 const newer=M.snapshot([node('a',['secret']),node('secret')],'secret');s.events.push({type:'map',map:newer,audience:'public',round:2});const next=Sync.project(s,'pc');a.equal(next.events[0].map.nodes.length,1);a.equal(next.events[1].map.nodes.length,2);
});
test('layout is deterministic, retains reference coordinates and separates unplaced nodes',()=>{
 const s=M.snapshot([node('a',['b'],false,{x:0,y:0}),node('b',['c']),node('c'),node('d')],'');
 const first=M.layout(s);a.deepEqual(first,M.layout(s));a.equal(first.nodes[0].x,0);a.equal(first.nodes[0].y,0);
 for(let i=0;i<first.nodes.length;i++)for(let j=0;j<i;j++)a.ok(Math.hypot(first.nodes[i].x-first.nodes[j].x,first.nodes[i].y-first.nodes[j].y)>=100);
 a.equal(first.edges[0].directed,true);
});
test('reference units do not change the fitted map or the screen size of its symbols',()=>{
 const make=unit=>M.snapshot([node('a',['b'],false,{x:0,y:0}),node('b',['c'],false,{x:-unit,y:unit}),node('c',[],false,{x:2*unit,y:unit})],'b');
 let expected;
 for(const unit of [.001,1,180,1000000]){
   const graph=M.layout(make(unit)),camera=M.fitView(graph,900,240),scene=M.project(graph,camera);
   a.ok(Math.hypot(scene.nodes[0].x-scene.nodes[1].x,scene.nodes[0].y-scene.nodes[1].y)>90);
   a.equal(scene.radius,8);a.equal(scene.fontSize,14);
   const points=scene.nodes.map(n=>[Math.round(n.x),Math.round(n.y)]);
   if(expected)a.deepEqual(points,expected);expected=points;
   for(const n of scene.nodes){a.ok(n.x>=40&&n.x<=860);a.ok(n.y>=40&&n.y<=200);}
 }
});
test('missing and coincident coordinates are laid out in the same normalized units',()=>{
 const make=unit=>M.snapshot([node('a',['b'],false,{x:0,y:0}),node('b',['c'],false,{x:unit,y:0}),node('c'),node('d',[],false,{x:0,y:0})],'');
 const small=M.layout(make(1)),large=M.layout(make(100000));a.deepEqual(small,large);
 for(let i=0;i<small.nodes.length;i++)for(let j=0;j<i;j++)a.ok(Math.hypot(small.nodes[i].x-small.nodes[j].x,small.nodes[i].y-small.nodes[j].y)>80);
 const camera=M.fitView(small,340,200),normal=M.project(small,camera),zoomed=M.project(small,{...camera,scale:camera.scale*2});
 a.ok(zoomed.radius>=normal.radius&&zoomed.radius<normal.radius*2,'symbols respond gently to view zoom, not map coordinate distance');
});
test('show_map requires current_id, defaults only omitted path, emits immutable safe snapshots and deduplicates receipts',()=>{
 const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');
 V.writeFile(tree,'/workspace/节点地图.json',JSON.stringify([node('a',['secret']),node('secret',[],true)]));
 const s=C.createSave('地图',tree);C.beginRound(s,'',true,'开局');
 a.equal(C.execute(s,'show_map',{},'missing').ok,false);
 a.equal(C.execute(s,'show_map',{path:'',current_id:''},'empty').ok,false);
 const args={current_id:'a'};a.equal(C.execute(s,'show_map',args,'map').ok,true);C.execute(s,'show_map',args,'map');
 a.equal(s.events.filter(e=>e.type==='map').length,1);
 V.writeFile(s.tree,'/workspace/节点地图.json','[]');
 const event=C.visibleEvents(s,'play').find(e=>e.type==='map');a.equal(event.map.nodes[0].name,'地点a');
 a.doesNotMatch(JSON.stringify(event),/secret|SECRET_NOTE/);
 const html=P.historyHTML(s);a.match(html,/node-map-card/);a.match(html,/地点a/);a.doesNotMatch(html,/地点secret|SECRET_NOTE/);
});
