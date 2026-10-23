'use strict';
const DiceQuality=(()=>{
  const profiles={
    low:{ratio:1,pixels:1000000,shadow:0,anisotropy:1,textureScale:1,textureLimit:512},
    standard:{ratio:1.5,pixels:2000000,shadow:1024,anisotropy:4,textureScale:1,textureLimit:1024},
    high:{ratio:2,pixels:4000000,shadow:2048,anisotropy:8,textureScale:2,textureLimit:1024},
    ultra:{ratio:3,pixels:6000000,shadow:2048,anisotropy:16,textureScale:2,textureLimit:2048},
  };
  function install(box,value,env=globalThis){
    const profile=profiles[value]||profiles.standard;
    let disposed=false,resize=null;
    box.shadows=profile.shadow>0;
    function apply(){
      if(disposed||!box.renderer)return;
      const renderer=box.renderer,w=Math.max(1,box.container.clientWidth),h=Math.max(1,box.container.clientHeight);
      const limit=Math.min(4096,renderer.capabilities.maxTextureSize||4096);
      const ratio=Math.min(Math.max(1,Number(env.devicePixelRatio)||1),profile.ratio,Math.sqrt(profile.pixels/(w*h)),limit/w,limit/h);
      renderer.setPixelRatio(ratio);
      renderer.shadowMap.enabled=box.shadows;
      if(box.light){
        box.light.castShadow=box.shadows;
        const size=Math.min(profile.shadow||512,limit);
        box.light.shadow.mapSize.set(size,size);
      }
      if(box.desk)box.desk.receiveShadow=box.shadows;
    }
    // The library sizes its canvas in CSS pixels and recreates lights on resize.
    const dimensions=box.setDimensions.bind(box);
    box.setDimensions=function(...args){const result=dimensions(...args);apply();return result;};
    // Own the resize listener so closing a tray also releases the renderer it retains.
    box.resizeWorld=function(){
      if(resize)return;
      resize=()=>{
        if(disposed||!box.container.isConnected)return;
        const w=box.container.clientWidth,h=box.container.clientHeight;
        if(w!==box.display.currentWidth*2||h!==box.display.currentHeight*2)box.setDimensions({x:w,y:h});
        else apply();
        box.renderer.render(box.scene,box.camera);
      };
      env.addEventListener?.('resize',resize);
    };
    const factory=box.DiceFactory,textureSize=factory.calc_texture_size.bind(factory),materials=factory.createMaterials.bind(factory);
    factory.calc_texture_size=function(size){
      // DiceFactory multiplies this result by four when allocating face canvases.
      const limit=Math.min(profile.textureLimit,box.renderer?.capabilities.maxTextureSize||profile.textureLimit);
      return Math.min(textureSize(size)*profile.textureScale,Math.pow(2,Math.floor(Math.log2(Math.max(4,limit))))/4);
    };
    factory.createMaterials=function(...args){
      const result=materials(...args),max=box.renderer?.capabilities.getMaxAnisotropy?.()||1;
      for(const material of result)for(const texture of [material.map,material.bumpMap])if(texture){texture.anisotropy=Math.min(profile.anisotropy,max);texture.needsUpdate=true;}
      return result;
    };
    box.disposeQuality=function(){
      if(disposed)return;
      disposed=true;box.renderDisposed=true;box.running=false;box.rolling=false;
      if(resize)env.removeEventListener?.('resize',resize);
      const resources=new Set();
      const collectMaterial=material=>{if(!material)return;resources.add(material);for(const value of Object.values(material))if(value?.isTexture)resources.add(value);};
      box.scene?.traverse(node=>{if(node.geometry)resources.add(node.geometry);for(const material of [].concat(node.material||[]))collectMaterial(material);if(node.shadow?.map)resources.add(node.shadow.map);});
      for(const entry of Object.values(factory.materials_cache||{}))for(const texture of Object.values(entry||{}))if(texture?.isTexture)resources.add(texture);
      for(const geometry of Object.values(factory.geometries||{}))resources.add(geometry);
      for(const resource of resources)resource.dispose?.();
      box.renderer?.dispose();box.renderer?.forceContextLoss?.();
      factory.materials_cache={};factory.geometries={};
    };
    return profile;
  }
  return {install};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=DiceQuality;
