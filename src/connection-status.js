'use strict';
const ConnectionStatus=(()=>{
  const transportErrors=new Set(['ConnectionLost','ConnectFailed','ConnectionFailed','HandshakeTimeout','ConnectionTimeout','ConnectTimeout','ConnectionClosed','TransportClosed','HeartbeatTimeout','SendFailed','ServerShutdown','IdleTimeout','NetworkError','TransportError','RequestTimeout']);
  function describe(state={},failure=null){
    const n=state.network,r=state.room;
    const result=(color,label,message=label,abnormal=false)=>({color,label,message,abnormal,key:[color,label,message].join(':')});
    if(failure)return result(transportErrors.has(failure.code)?'red':'purple','联机操作异常',failure.message||'联机操作未完成',true);
    if(!n)return result('purple',state.client?'尚未加入房间':'房间未开放',state.client?'粘贴邀请链接或加入密钥后连接房主':'当前离线；开放玩家槽位后连接服务器');
    if(['connecting','reconnecting'].includes(n.status))return result('yellow',n.status==='reconnecting'?'正在重新连接':'正在连接',n.message||'正在连接联机服务',n.status==='reconnecting');
    if(n.status==='connected'){
      if(state.client&&!r)return result('yellow','正在同步房间');
      if(r?.online)return result('green',state.client?'已连接房主':'房间正常开放');
      return result('purple',state.client?'房主未开放房间':'房间未开放');
    }
    const failed=transportErrors.has(n.code)||(n.status==='disconnected'&&!n.code);
    return result(failed?'red':'purple',failed?'无法连接服务器':n.code==='HostDisconnected'?'房主已离开':n.code==='RoomNotFound'?'房主未开放房间':'房间连接异常',n.message||'连接已关闭，请检查邀请或联系房主',true);
  }
  return {describe};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=ConnectionStatus;
