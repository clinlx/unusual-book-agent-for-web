const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function ui() { const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync('src/game-ui.js','utf8') + '\nthis.api = GameUI;',ctx); return ctx.api; }
test('round end uses a single timestamp without repeated round or world time',()=>{
 const ctx=vm.createContext({GamePresentation:require('../src/game-presentation')});vm.runInContext(fs.readFileSync('src/game-ui.js','utf8')+'\nthis.api=GameUI;',ctx);
 const html=ctx.api.eventHTML({type:'round_end',round:12,worldTime:'深夜',at:Date.UTC(2026,8,21)},'play');
 assert.match(html,/回合结束：/);assert.match(html,/2026/);assert.doesNotMatch(html,/第|深夜|event-meta/);
});
test('run phase uses current round calls and published stories',()=>{
 const api=ui(),s={running:true,active:{activeRound:{number:2,published:0},messages:[{round:1,tool_calls:[{}]}],events:[]},stream:{tools:[]}};
 assert.equal(api.runPhase(s),'正在请求');s.stream.tools=[{}];assert.equal(api.runPhase(s),'正在思考');
 s.stream.tools=[];s.active.messages.push({round:2,tool_calls:[{}]});assert.equal(api.runPhase(s),'正在思考');
 s.active.activeRound.published=1;assert.equal(api.runPhase(s),'主持人正在收尾和处理变更');s.running=false;assert.equal(api.runPhase(s),'');
});
test('continue appears only for an idle interrupted unfinished round',()=>{
 const api=ui();
 assert.ok(api.continuationHTML({running:false,active:{status:'interrupted',activeRound:{complete:false}}}).includes('data-action="resume"'));
 for(const state of [{running:true,active:{status:'interrupted',activeRound:{complete:false}}},{running:false,active:{status:'waiting',activeRound:{complete:true}}},{running:false,active:{status:'interrupted',activeRound:{complete:true}}},{running:false,active:null}])assert.equal(api.continuationHTML(state),'');
});
test('play includes player dice with a spoiler-free placeholder for secret results', () => {
 const api=ui(),secret={type:'dice',secret:true,content:'SECRET_RESULT',data:{raw:37},playerRelated:true};
 const events = [{type:'player'},{type:'story'},{type:'dice',secret:false,playerRelated:true},{type:'round_end'},secret,{type:'assistant',content:'secret'},{type:'tool',args:{secret:true}},{type:'error'}];
 assert.deepEqual(Array.from(api.visibleEvents(events,'play'),e=>e.type), ['player','story','dice','round_end','dice']);
 assert.equal(api.visibleEvents(events,'debug').length,8);
 const placeholder=api.eventHTML(secret,'play');
 assert.match(placeholder,/主持人进行了一次暗骰/);assert.doesNotMatch(placeholder,/SECRET_RESULT|37|dice-detail/);
 assert.match(api.eventHTML(secret,'debug'),/SECRET_RESULT/);
});

test('composer resume is a non-submit button only while the current round is interrupted',()=>{
 const api=ui(),state={running:false,active:{status:'interrupted',activeRound:{complete:false}}};
 assert.match(api.resumeButtonHTML(state),/type="button".*data-action="resume".*继续本轮/);
 for(const invalid of [{...state,running:true},{running:false,active:{status:'interrupted',activeRound:{complete:true}}},{running:false,active:{status:'waiting',activeRound:{complete:false}}}])assert.equal(api.resumeButtonHTML(invalid),'');
});
test('DEBUG fallback retains NPC dice and events marked as unrelated to the player',()=>{
 const api=ui(),events=[{type:'dice',secret:false,playerRelated:false},{type:'tool',playerRelated:false},{type:'error'}];
 assert.equal(api.visibleEvents(events,'debug').length,events.length);
 assert.deepEqual(Array.from(api.visibleEvents(events,'play')),[]);
});
test('rendered tool arguments and player input cannot inject HTML', () => {
 const api = ui(); const output=api.eventHTML({type:'tool',name:'<script>',args:{x:'<img src=x onerror=alert(1)>'},result:'ok'},'debug');
 assert.ok(!output.includes('<img')); assert.ok(output.includes('&lt;img')); assert.ok(!output.includes('<script>'));
 assert.ok(!api.eventHTML({type:'player',content:'<img src=x>'},'play').includes('<img'));
});

test('tool detail keys follow event identity when the history grows', () => {
 const api=ui(); const event={id:'call-42',type:'tool',name:'read_file',args:{path:'x'},result:'ok'};
 const output=api.eventHTML(event,'debug');
 assert.ok(output.includes('data-key="event:call-42:参数"'));
 assert.ok(output.includes('data-key="event:call-42:结果"'));
});

test('empty model replies have no bubble but thinking-only replies remain',()=>{const api=ui();assert.equal(api.eventHTML({type:'assistant',content:'  ',reasoning:'\n'},'debug'),'');assert.match(api.eventHTML({type:'assistant',content:'',reasoning:'思考'},'debug'),/思考/);});
test('estimated request progress follows split curve, story bonus and fixed width',()=>{
 const api=ui(),s={running:true,settings:{maxToolLoops:60},active:{activeRound:{requestCount:0,published:0}}};
 for(const [count,value]of [[0,'  0%'],[1,'  3%'],[20,' 60%'],[40,' 65%'],[60,' 70%'],[100,' 70%']]){s.active.activeRound.requestCount=count;assert.equal(api.requestProgress(s),value);}
 s.active.activeRound.published=1;assert.equal(api.requestProgress(s),'100%');s.active.activeRound.requestCount=20;assert.equal(api.requestProgress(s),' 90%');
 for(const m of [1,10,20]){s.settings.maxToolLoops=m;assert.equal(api.requestProgress(s),' 90%');}
});
