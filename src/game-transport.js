'use strict';
const GameTransport=(()=>{
  const sse=typeof module!=='undefined'&&module.exports?require('./sse.js'):SSE;
  const tiers=new Map();
  function create(settings,tools,hooks={}){
    const fetcher=hooks.fetch||globalThis.fetch.bind(globalThis);
    return async function(messages){
      const base=String(settings.baseUrl||'').replace(/\/+$/,'');
      if(!/^https?:\/\//.test(base))throw Error('请在设置中填写有效的模型 API 地址');
      const url=base.endsWith('/chat/completions')?base:base+'/chat/completions';
      const key=base+'|'+settings.model;let tier=tiers.get(key)||0;
      const ctrl=new AbortController();
      const cancel=()=>ctrl.abort(hooks.signal?.reason);hooks.signal?.addEventListener('abort',cancel,{once:true});
      if(hooks.signal?.aborted)cancel();
      const timer=setTimeout(()=>ctrl.abort(Error('模型请求超时，请重试本回合')),Math.max(1,settings.httpTimeoutSeconds||180)*1000);
      try{
        let resp;
        for(let attempt=0;;){
          const body={model:settings.model,messages,stream:!!settings.stream,max_tokens:settings.maxOutputTokens||16384};
          if(tools?.length)body.tools=tools;
          const effort=settings.reasoningEffort||'high';
          const deepseek=/deepseek/i.test(base+' '+settings.model);
          if(!deepseek||effort==='none')body.temperature=Number(settings.temperature??0.7);
          if(tier===0){if(deepseek){body.thinking={type:effort==='none'?'disabled':'enabled'};if(effort!=='none')body.reasoning_effort=effort==='max'?'max':'high';}else body.reasoning_effort=effort;}
          if(ctrl.signal.aborted)throw ctrl.signal.reason||Error('已中止请求');
          if(hooks.onRequest)await hooks.onRequest(body);
          if(ctrl.signal.aborted)throw ctrl.signal.reason||Error('已中止请求');
          resp=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(settings.apiKey||'')},body:JSON.stringify(body),signal:ctrl.signal});
          if(resp.ok)break;
          const text=await resp.text();
          if(tier===0&&[400,422].includes(resp.status)&&/reasoning|thinking/i.test(text)){tier=1;continue;}
          if([429,500,502,503,504].includes(resp.status)&&attempt<(settings.maxRetries??2)){
            attempt++;await new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(t);reject(Error('已中止请求'));};const t=setTimeout(()=>{ctrl.signal.removeEventListener('abort',stop);resolve();},Math.min(1000*attempt,3000));ctrl.signal.addEventListener('abort',stop,{once:true});});continue;
          }
          throw Error('API '+resp.status+'：'+text.slice(0,500));
        }
        tiers.set(key,tier);
        if(!settings.stream){const data=await resp.json();const choice=data.choices?.[0];
          if(data.error)throw Error(data.error.message||'模型返回错误');
          if(!choice?.message)throw Error('模型响应缺少 message');
          if(choice.finish_reason==='length')throw Error('模型输出被截断，请增加输出上限后继续本回合');
          hooks.onUsage?.(data.usage);const m=choice.message;return {content:m.content||'',reasoning:sse.readReasoning(m),tool_calls:m.tool_calls||[]};}
        if(!resp.body)throw Error('模型未返回流式响应体');
        const reader=resp.body.getReader(),decoder=new TextDecoder(),acc=sse.createAccumulator();
        let buffer='',hasData=false,finishReason=null;
        function process(line){if(!line.startsWith('data:'))return;const text=line.slice(5).trim();if(!text||text==='[DONE]')return;
          const data=JSON.parse(text);if(data.error)throw Error(data.error.message||'模型流式响应错误');hasData=true;acc.add(data);
          const choice=data.choices?.[0],delta=choice?.delta;finishReason=choice?.finish_reason||finishReason;
          if(delta?.content)hooks.onDelta?.(delta.content);const reason=sse.readReasoning(delta);if(reason)hooks.onReasoningDelta?.(reason);
          if(delta?.tool_calls)hooks.onToolDelta?.(acc.partial());if(data.usage)hooks.onUsage?.(data.usage);
        }
        try{for(;;){if(ctrl.signal.aborted)throw ctrl.signal.reason||Error('已中止请求');const {value,done}=await reader.read();
          buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let i;while((i=buffer.indexOf('\n'))>=0){process(buffer.slice(0,i).replace(/\r$/,''));buffer=buffer.slice(i+1);}
          if(done){if(buffer.trim())process(buffer.replace(/\r$/,''));break;}
        }}finally{try{await reader.cancel();}catch(_){}}
        if(!hasData)throw Error('模型返回了空响应');if(finishReason==='length')throw Error('模型输出被截断，请增加输出上限后继续本回合');
        return acc.result();
      }catch(e){if(ctrl.signal.aborted)throw ctrl.signal.reason||Object.assign(Error('已中止请求'),{name:'AbortError'});throw e;}
      finally{clearTimeout(timer);hooks.signal?.removeEventListener('abort',cancel);}
    };
  }
  async function testConnection(settings,hooks={}){
    if(!String(settings.apiKey||'').trim())throw Error('请填写 API Key');
    if(!String(settings.model||'').trim())throw Error('请填写模型名称');
    const start=Date.now();
    await create({...settings,stream:false,maxOutputTokens:64,reasoningEffort:'none',maxRetries:0,httpTimeoutSeconds:30},[],hooks)([{role:'user',content:'Reply with OK.'}]);
    return {elapsedMs:Date.now()-start};
  }
  return {create,testConnection};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameTransport;
