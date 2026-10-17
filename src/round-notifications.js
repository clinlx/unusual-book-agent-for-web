'use strict';
const RoundNotifications=(()=>{
  function permissionMessage(env=globalThis){
    if(env.isSecureContext===false)return '系统通知需要 HTTPS 或本机地址。';
    if(!env.Notification)return '当前浏览器不支持系统通知。';
    return env.Notification.permission==='granted'?'已获得浏览器通知权限。':env.Notification.permission==='denied'?'浏览器已阻止通知，请在网站权限中允许。':'开启时会请求浏览器通知权限。';
  }
  async function requestPermission(env=globalThis){
    if(env.isSecureContext===false||!env.Notification)return {enabled:false,message:permissionMessage(env)};
    try{
      const permission=env.Notification.permission==='default'?await env.Notification.requestPermission():env.Notification.permission;
      return {enabled:permission==='granted',message:permission==='granted'?'通知已允许，保存设置后生效。':permission==='denied'?'浏览器已阻止通知，请在网站权限中允许。':'未授予通知权限，开关未启用。'};
    }catch(error){return {enabled:false,message:'无法申请通知权限：'+(error.message||'请检查浏览器设置')};}
  }
  async function send({round,tag},env=globalThis){
    if(!env.Notification||env.Notification.permission!=='granted')return false;
    const title='异闻手记 · 回合完成',options={body:'第 '+round+' 回合已完成，返回查看剧情。',tag};
    try{
      const notification=new env.Notification(title,options);
      notification.onclick=()=>{env.focus?.();notification.close();};
      notification.onerror=error=>env.console?.warn('[RoundNotifications] 系统未能显示通知',error);
      return true;
    }catch(error){
      // Mobile browsers commonly require notifications from a local service worker.
      try{
        if(!env.navigator?.serviceWorker)throw error;
        const url=new URL(env.location.href);url.search='';url.hash='';
        const registration=await env.navigator.serviceWorker.register(new URL('notification-sw.js',url).href);
        if(!registration.active)await new Promise((resolve,reject)=>{
          const worker=registration.installing||registration.waiting;
          if(!worker)return reject(Error('通知服务未就绪'));
          const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('statechange',changed);};
          const changed=()=>{if(worker.state==='activated'){cleanup();resolve();}else if(worker.state==='redundant'){cleanup();reject(Error('通知服务启动失败'));}};
          const timer=setTimeout(()=>{cleanup();reject(Error('通知服务启动超时'));},5000);
          worker.addEventListener('statechange',changed);changed();
        });
        await registration.showNotification(title,{...options,data:{url:url.href}});return true;
      }catch(failure){env.console?.warn('[RoundNotifications] 无法发送回合完成通知',failure);return false;}
    }
  }
  function create({send:deliver=send}={}){
    let scope=null,completed=0,disconnected=false,disconnectedSave=null;
    function update(state){
      const save=state.active;if(!save){scope=null;return;}
      const room=state.room,key=JSON.stringify([save.id,room?.roomId,room?.epoch,room?.memberId,room?.bindingVersion]);
      const offline=state.client&&state.network&&state.network.status!=='connected';
      if(scope!==key){scope=key;completed=save.round||0;disconnected=!!offline;disconnectedSave=offline?save:null;return;}
      if(offline){disconnected=true;disconnectedSave=save;return;}
      if(disconnected){if(save===disconnectedSave)return;disconnected=false;disconnectedSave=null;completed=save.round||0;return;}
      if(state.running||!['waiting','ended'].includes(save.status)||save.activeRound?.complete===false||['executing','interrupted','rolling_back'].includes(room?.status))return;
      if((save.round||0)<=completed)return;
      completed=save.round;
      if(state.settings?.roundNotifications===true)try{
        Promise.resolve(deliver({round:completed,tag:'trpg-round:'+save.id+':'+(room?.epoch||0)+':'+completed})).catch(()=>{});
      }catch(_){}
    }
    return {update};
  }
  return {create,send,requestPermission,permissionMessage};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=RoundNotifications;
