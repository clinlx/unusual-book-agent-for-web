'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const C=require('../../src/game-core'),V=require('../../src/vfs'),Sync=require('../../src/multiplayer-sync');
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('multiplayer terminal settlement resumes after a saved reward without rerolling, republishing or paying twice',async()=>{
 const tree=V.createTree();
 for(const id of ['a','b']){V.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,技能:{侦查:40},金钱:10}));V.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}
 let s=C.createSave('结算回归',tree);C.beginRound(s,'',true,'结算');
 const dice={description:'结算·侦查成长检定',roller:'a',related_attr:'侦查',is_secret:false,is_private:false,dice_dict:{成长:'1d100'},calculate_only:false,target_value:40,compare_mode:'gt',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{}};
 const story=(id,content)=>call(id,'append_story',{content,one_line_summary_of_content:content,self_accept:true});
 let rolls=0,requests=0;
 await a.rejects(C.run(s,async()=>{
   if(++requests===1)return {tool_calls:[story('ending','故事落幕。'),story('epilogue','同伴各自归家。'),call('check','roll_dice',dice),call('gain','roll_dice',{...dice,description:'结算·侦查成长增量',dice_dict:{增量:'1d10'},calculate_only:true,target_value:null,compare_mode:null}),call('read','read_multiple_files',{paths:['/workspace/Player-a/基础信息.json','/workspace/Player-b/基础信息.json']})]};
   return {tool_calls:[call('reward-a','apply_patch',{path:'/workspace/Player-a/基础信息.json',patches:[{old_str:'"侦查":40',new_str:'"侦查":50'},{old_str:'"金钱":10',new_str:'"金钱":110'}]}),call('reward-b','apply_patch',{path:'/workspace/Player-b/基础信息.json',old_str:'"金钱":10',new_str:'"金钱":60'}),call('private','private_append_story',{entries:[{id:'a',story:'个人结算：你的秘密委托已按约履行。'}]}),story('settled','结算：a 的侦查 40 → 50，酬劳 100；b 的酬劳 50。'),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏结束',game_over:true}})]};
 },{random:()=>{rolls++;return .99;},onStep:()=>{if(s.activeRound.receipts['reward-a']?.ok)throw Error('模拟断线');}}),/模拟断线/);
 s=structuredClone(s);a.equal(s.activeRound.complete,false);
 await C.run(s,()=>a.fail('pending settlement resumes without another AI request'),{random:()=>a.fail('no duplicate dice')});
 a.equal(rolls,2);a.equal(s.status,'ended');a.equal(s.round,1);
 const info=id=>JSON.parse(V.readFile(s.tree,`/workspace/Player-${id}/基础信息.json`).content);
 a.equal(info('a').技能.侦查,50);a.equal(info('a').金钱,110);a.equal(info('b').金钱,60);
 a.equal(s.events.filter(e=>e.type==='story'&&e.content==='故事落幕。').length,1);
 a.equal(s.events.filter(e=>e.callId==='reward-a').length,1);
 a.doesNotMatch(JSON.stringify(Sync.project(s,'b')),/秘密委托/);
 for(const id of ['a','b']){const view=Sync.project(s,id);a.equal(view.status,'ended');a.equal(view.events.filter(e=>e.type==='dice').length,2);a.ok(view.events.some(e=>e.type==='story'&&e.content.startsWith('结算：')));}
 a.ok(V.resolve(s.tree,['workspace','过往回合历史记忆']));
});
