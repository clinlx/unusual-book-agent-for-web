'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Config=require('../src/frontend-config');

test('central defaults preserve each frontend profile and return independent settings',()=>{
  const game=Config.defaults('game'),designer=Config.defaults('designer'),client=Config.defaults('client');
  assert.equal(game.baseUrl,'https://api.deepseek.com/v1');
  assert.equal(game.model,'deepseek-flash');
  assert.equal(game.maxContextK,240);
  assert.equal(designer.maxContextK,256);
  assert.equal(designer.contextOverflow,'disabled');
  assert.equal(game.maxOutputTokens,16384);
  assert.equal(game.bridgeUrl,Config.links.relay);
  assert.deepEqual(client,{reverseSendNewline:false,roundNotifications:false,skipMultiplayerManualDice:false,diceQuality:'standard'});
  game.promptOverrides.custom='local';
  assert.deepEqual(Config.defaults('game').promptOverrides,{});
  assert.deepEqual(require('../src/world-designer/00-config').DEFAULT_SETTINGS,designer);
  assert.equal(require('../src/shared/output-limit').tokens(),Config.common.maxOutputTokens);
  assert.equal(require('../src/game-catalog').DEFAULT_SOURCE,Config.links.worldCatalog);
});

test('browser config is standalone and has the same profiles as Node',()=>{
  const context=vm.createContext({structuredClone});
  vm.runInContext(fs.readFileSync(require.resolve('../src/frontend-config'),'utf8'),context);
  for(const profile of ['game','designer','client']){
    assert.deepEqual(vm.runInContext(`FrontendConfig.defaults('${profile}')`,context),Config.defaults(profile));
  }
});

test('standalone story exports use the configured project URL and escape HTML attributes',()=>{
  const context=vm.createContext({
    FrontendConfig:{...Config,links:{...Config.links,github:'https://example.test/project?a=1&b="two"'}},
    GameData:require('../src/game-data'),NodeMap:require('../src/node-map'),BUNDLED_GAME_ICON:'',BUNDLED_GAME_FAVICON:'',BUNDLED_GAME_STYLES:'',
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/game-presentation'),'utf8'),context);
  const html=vm.runInContext('GamePresentation.historyHTML({name:"测试",events:[],snapshots:[]})',context);
  assert.match(html,/href="https:\/\/example.test\/project\?a=1&amp;b=&quot;two&quot;"/);
  assert.ok(!html.includes(Config.links.github));
});
