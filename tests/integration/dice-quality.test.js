'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Quality=require('../../src/dice-quality');
function fixture(){
  const events=new Map(),disposed=new Set(),texture={isTexture:true,dispose(){disposed.add(this);}},geometry={dispose(){disposed.add(this);}};
  const material={map:texture,dispose(){disposed.add(this);}};
  const env={devicePixelRatio:3,addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
  const box={container:{clientWidth:600,clientHeight:300,isConnected:true},display:{},world:{gravity:420},diceList:[{result:[{value:6}]}],
    renderer:{capabilities:{maxTextureSize:4096,getMaxAnisotropy:()=>8},shadowMap:{},setPixelRatio(value){this.ratio=value;},render(){},dispose(){this.disposed=true;},forceContextLoss(){}},
    scene:{traverse(fn){fn({geometry,material});}},
    setDimensions(){this.display.currentWidth=this.container.clientWidth/2;this.display.currentHeight=this.container.clientHeight/2;this.light={shadow:{mapSize:{set(x,y){this.x=x;this.y=y;}}}};},
    DiceFactory:{calc_texture_size:()=>64,createMaterials:()=>[material],materials_cache:{face:{composite:texture}},geometries:{d6:geometry}}};
  return {box,env,events,disposed,texture};
}
test('quality scales rendering and textures while preserving dice and physics state',()=>{
  for(const [name,ratio,shadow,textureSize]of [['low',1,0,64],['standard',1.5,1024,64],['high',2,2048,128],['ultra',3,2048,128]]){
    const {box,env,texture}=fixture(),before=JSON.stringify([box.world,box.diceList]);
    Quality.install(box,name,env);box.setDimensions();box.DiceFactory.createMaterials();
    assert.equal(box.renderer.ratio,ratio);assert.equal(box.renderer.shadowMap.enabled,shadow>0);
    if(shadow)assert.equal(box.light.shadow.mapSize.x,shadow);
    assert.equal(box.DiceFactory.calc_texture_size(1),textureSize);assert.ok(texture.anisotropy<=8);
    assert.equal(JSON.stringify([box.world,box.diceList]),before);
  }
});
test('large and resized trays obey pixel and GPU limits and release shared resources once',()=>{
  const {box,env,events,disposed}=fixture();Quality.install(box,'ultra',env);box.setDimensions();box.resizeWorld();
  box.container.clientWidth=5000;box.container.clientHeight=3000;events.get('resize')();
  const ratio=box.renderer.ratio;assert.ok(5000*3000*ratio*ratio<=6000001);assert.ok(5000*ratio<=4096);
  assert.equal(box.light.shadow.mapSize.x,2048);
  box.renderer.capabilities.maxTextureSize=128;assert.ok(box.DiceFactory.calc_texture_size(500)*4<=128);
  box.disposeQuality();box.disposeQuality();assert.equal(events.size,0);assert.equal(disposed.size,3);assert.equal(box.renderer.disposed,true);
});
test('unknown quality falls back to standard',()=>{
  const {box,env}=fixture();Quality.install(box,'invalid',env);box.setDimensions();assert.equal(box.renderer.ratio,1.5);
});
