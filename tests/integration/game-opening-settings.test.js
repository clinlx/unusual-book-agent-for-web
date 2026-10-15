'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function app(storage){
 const context=vm.createContext({structuredClone,GameCore:require('../../src/game-core'),GamePresentation:require('../../src/game-presentation'),
  GameStore:{create:()=>({open:async()=>{},list:async()=>[],getSettings:async()=>structuredClone(storage.settings||{}),putSettings:async value=>{storage.settings=structuredClone(value);}})},
  BridgeTransport:{validateServerUrl:value=>value}});
 vm.runInContext(fs.readFileSync(require.resolve('../../src/game-app'),'utf8')+'\nthis.app=GameApp;',context);return context.app;
}
test('opening preload defaults on for new and existing browser settings',async()=>{
 for(const settings of [{},{manualDice:true}]){const storage={settings},game=app(storage);await game.init();assert.equal(game.getState().settings.openingPreload,true);assert.equal(storage.settings.openingPreload,true);}
});
test('opening preload off persists through reload and unrelated setting updates',async()=>{
 const storage={},game=app(storage);await game.init();await game.updateSettings({openingPreload:false});assert.equal(storage.settings.openingPreload,false);
 const reloaded=app(storage);await reloaded.init();assert.equal(reloaded.getState().settings.openingPreload,false);
 await reloaded.updateSettings({manualDice:true});assert.equal(storage.settings.openingPreload,false);
 await reloaded.updateSettings({openingPreload:true});assert.equal(storage.settings.openingPreload,true);
});
