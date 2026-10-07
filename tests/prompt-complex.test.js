'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Prompts=require('../src/game-prompts'),Tools=require('../src/game-tools');
test('complex prompts are fully loaded with resolvable references and tool descriptions',()=>{
 const sources=Object.fromEntries(Prompts.list().map(({id})=>[id,fs.readFileSync(path.join(__dirname,'../assets/prompts',id),'utf8')]));
 for(const [id,text]of Object.entries(sources)){
  assert.ok(text.trim(),id);
  assert.doesNotMatch(text,/update_story|xx\/xx\/xx/,id);
  for(const match of text.matchAll(/\/\.reference\/([^\s`"，；）)\]]+?\.md)/g))if(!match[1].includes('*')&&!match[1].startsWith('trpg_rule_books/'))assert.ok(fs.existsSync(path.join(__dirname,'../assets/prompts/reference',match[1])),id+' has missing reference');
 }
 const p=Prompts.create(sources),system=p.buildSystem();
 for(const term of ['玩家','暗骰','phase_plan','Countdowns','Pending_Triggers','Forced_Checks','append_story','one_line_summary_of_content','NEXT_TURN_CACHE','Story_Phase','game_over','/workspace','/.reference'])assert.ok(system.includes(term),term);
 for(const tool of Tools.build(p))assert.ok(tool.function.description.trim(),tool.function.name);
 assert.match(p.get('reference/游戏前准备.md'),/不少于 500 字/);
 assert.match(p.get('reference/游戏结束.md'),/第二次 `append_story`/);
 assert.match(p.flows().flow_after_story,/end_the_round/);
});
