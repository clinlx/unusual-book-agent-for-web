'use strict';
const GameCatalog=(()=>{
  const zip=typeof module!=='undefined'&&module.exports?require('./zip.js'):ZIP;
  const MAX_BYTES=100*1024*1024;
  const MAX_COVER_BYTES=8*1024*1024;
  const DEFAULT_SOURCE='./modules.json';
  class DownloadError extends Error {constructor(code,message){super(message);this.name='DownloadError';this.code=code;}}
  const failure=(code,message)=>new DownloadError(code,message);
  function link(value){
    if(typeof value!=='string'||!value.trim()||/[\\\u0000-\u0020]/.test(value)||value.startsWith('//'))throw failure('INVALID_URL','链接格式不正确：请使用 HTTP / HTTPS 地址或站内路径，例如 /files/world.zip。');
    const relative=!/^[a-z][a-z\d+.-]*:/i.test(value);
    let u;try{u=new URL(value,'https://catalog.invalid/');}catch(_){throw failure('INVALID_URL','链接格式不正确，请检查 ZIP 下载地址。');}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw failure('INVALID_URL','无法使用此链接：请提供不含账号密码的 HTTP / HTTPS 地址或站内路径。');
    return relative?value:u.href;
  }
  function url(value,pageUrl=globalThis.location?.href){
    const checked=link(value);if(/^https?:/i.test(checked))return checked;
    let page;try{page=new URL(pageUrl);}catch(_){}
    if(!page||!['http:','https:'].includes(page.protocol))throw failure('LOCAL_RELATIVE_URL','站内链接需要通过网站打开页面才能下载。当前页面没有 HTTP / HTTPS 站点地址，请从网站访问，或下载 ZIP 后选择“从文件导入”。');
    return new URL(checked,page).href;
  }
  function source(value){
    const raw=String(value??'').trim();
    if(!raw)return DEFAULT_SOURCE;
    if(/[\\\u0000-\u0020]/.test(raw)||raw.startsWith('//'))throw Error('世界列表源格式不正确：请使用 HTTP / HTTPS 地址或站内路径。');
    const relative=!/^[a-z][a-z\d+.-]*:/i.test(raw);
    let u;try{u=new URL(raw,'https://catalog.invalid/');}catch(_){throw Error('世界列表源格式不正确，请检查地址。');}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('世界列表源仅支持不含账号密码的 HTTP / HTTPS 地址或站内路径。');
    return relative?raw:u.href;
  }
  function httpError(status){
    const known={401:['AUTH_REQUIRED','此链接需要登录（HTTP 401）。请使用无需登录的公开下载链接，或下载 ZIP 后选择“从文件导入”。'],403:['ACCESS_DENIED','服务器拒绝访问（HTTP 403），可能没有下载权限或启用了防盗链。请检查分享权限，或下载 ZIP 后选择“从文件导入”。'],404:['NOT_FOUND','文件不存在（HTTP 404）。链接可能有误或文件已被删除，请向提供者获取新的 ZIP 链接。'],410:['EXPIRED','下载链接已失效（HTTP 410）。请向提供者获取新的链接。'],408:['TIMEOUT','服务器等待请求超时（HTTP 408）。请检查网络后重试。'],429:['RATE_LIMITED','下载请求过于频繁（HTTP 429）。请稍后再试。']};
    if(known[status])return failure(...known[status]);
    if(status>=500)return failure('SERVER_ERROR',`下载服务器暂时出错（HTTP ${status}）。请稍后重试，或联系文件提供者。`);
    return failure('HTTP_ERROR',`服务器无法提供此文件（HTTP ${status}）。请检查下载链接，或下载 ZIP 后选择“从文件导入”。`);
  }
  function connectionError(error,{address,pageUrl,online,signal,reading=false}){
    if(error instanceof DownloadError)return error;
    const reason=signal?.aborted?signal.reason:error;
    if(reason?.name==='TimeoutError')return failure('TIMEOUT','下载超时。请检查网络连接，稍后重新导入。');
    if(signal?.aborted||reason?.name==='AbortError')return failure('CANCELLED','下载已取消，未导入存档。需要时可重新选择此模组。');
    if(online===false)return failure('OFFLINE','当前网络已断开。请恢复网络连接后重新导入。');
    if(reading)return failure('DOWNLOAD_INTERRUPTED','下载中断，文件尚未接收完整。请检查网络后重新导入；本次未写入存档。');
    let page;try{page=new URL(pageUrl);}catch(_){}
    const target=new URL(address);
    if(page?.protocol==='https:'&&target.protocol==='http:')return failure('INSECURE_LINK','安全连接受限：当前页面使用 HTTPS，HTTP 下载可能被浏览器拦截。请改用 HTTPS 链接，或下载 ZIP 后选择“从文件导入”。');
    if(page&&(page.protocol==='file:'||page.origin!==target.origin))return failure('CROSS_ORIGIN_OR_NETWORK','无法跨站下载：可能是文件服务器未允许跨域访问（CORS），也可能是网络、证书或连接问题；浏览器未提供具体原因。请先确认链接可直接下载；若可以，请联系提供者开启跨域访问，或下载 ZIP 后选择“从文件导入”。');
    return failure('NETWORK_ERROR','无法连接下载服务器。请检查网络和链接是否有效；也可能是证书或浏览器访问限制。可尝试下载 ZIP 后选择“从文件导入”。');
  }
  const COVER_FITS=new Set(['auto','horizontal','vertical','stretch','none']);
  function cover(value){
    if(value==null||value==='')return '';
    if(typeof value!=='string'||/[\\\u0000-\u0020]/.test(value)||value.startsWith('//'))throw Error('封面链接格式不正确：请使用 HTTP / HTTPS 地址或站内路径。');
    const relative=!/^[a-z][a-z\d+.-]*:/i.test(value);
    let u;try{u=new URL(value,'https://catalog.invalid/');}catch(_){throw Error('封面链接格式不正确，请检查图片地址。');}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('封面链接仅支持不含账号密码的 HTTP / HTTPS 地址或站内路径。');
    return relative?value:u.href;
  }
  function coverFit(value){
    const fit=String(value??'').trim().toLowerCase();
    return COVER_FITS.has(fit)?fit:'auto';
  }
  function parse(items){
    if(!Array.isArray(items))throw Error('模组列表必须是数组');
    return items.map((item,i)=>{
      if(!item||typeof item.Name!=='string'||!item.Name.trim())throw Error('模组 '+(i+1)+' 缺少名称');
      const tags=item.Tags??[];if(!Array.isArray(tags))throw Error('模组标签必须是数组');
      const fit=coverFit(item.CoverFit);
      return {Name:item.Name,Introduction:String(item.Introduction??''),Text:String(item.Text??''),Link:link(item.Link),Cover:fit==='none'?'':cover(item.Cover),CoverFit:fit,Tags:tags.map(t=>{if(!t||typeof t.TagName!=='string'||!/^#[\da-f]{6}$/i.test(t.Color))throw Error('标签需要名称和六位十六进制颜色');return {TagName:t.TagName,Color:t.Color};})};
    });
  }
  async function load({fetch:request=globalThis.fetch,source:sourceValue=DEFAULT_SOURCE,signal,pageUrl=globalThis.location?.href}={}){
    const address=source(sourceValue);
    let response;
    try{response=await request(address,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:'application/json'},signal});}
    catch(e){
      if(signal?.aborted||e?.name==='AbortError')throw Error('世界列表加载已取消或超时。');
      throw Error('世界列表源无法连接。请检查地址、网络连接以及外部服务器的 CORS 设置。');
    }
    if(!response.ok)throw Error('世界列表加载失败（HTTP '+response.status+'）');
    let value;try{value=await response.json();}catch(_){throw Error('世界列表不是有效的 JSON。');}
    let items;try{items=parse(value);}catch(e){throw Error('世界列表格式错误：'+e.message);}
    let base;
    try{
      const requested=/^https?:/i.test(address)?address:new URL(address,pageUrl).href;
      base=response.url||requested;
    }catch(_){}
    if(base)for(const item of items){
      if(item.Link&&!/^https?:/i.test(item.Link))item.Link=new URL(item.Link,base).href;
      if(item.Cover&&!/^https?:/i.test(item.Cover))item.Cover=new URL(item.Cover,base).href;
    }
    return items;
  }
  const PNG_SIG=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
  const concat=(parts,total)=>{const out=new Uint8Array(total);let off=0;for(const part of parts){out.set(part,off);off+=part.length;}return out;};
  const isPngStart=bytes=>bytes.length>=8&&PNG_SIG.every((b,i)=>bytes[i]===b);
  async function fallbackCover(linkValue,{fetch:request=globalThis.fetch,signal,pageUrl=globalThis.location?.href,maxBytes=MAX_COVER_BYTES}={}){
    const address=url(linkValue,pageUrl),limit=Math.max(65536,Math.min(MAX_COVER_BYTES,Number(maxBytes)||MAX_COVER_BYTES));
    const opts={cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal};
    let start=0,span=65536,parts=[],total=0;
    while(start<limit){
      const end=Math.min(limit-1,start+span-1);
      let response;
      try{response=await request(address,{...opts,headers:{Range:`bytes=${start}-${end}`,Accept:'image/png,*/*;q=0.8'}});}
      catch(_){return null;}
      if(!(response.ok||response.status===206))return null;
      if(response.status===206){
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(!bytes.length)return null;
        parts.push(bytes);total+=bytes.length;
        const merged=concat(parts,total);
        if(start===0&&!isPngStart(merged))return null;
        const pngEnd=zip.findPngEnd(merged);
        if(Number.isInteger(pngEnd)&&pngEnd>0)return new Blob([merged.subarray(0,pngEnd)],{type:'image/png'});
        if(pngEnd===-1||total>=limit||bytes.length<end-start+1)return null;
        start+=bytes.length;span=Math.min(span*2,1024*1024);continue;
      }
      const reader=response.body?.getReader();
      if(!reader){try{await response.body?.cancel();}catch(_){}return null;}
      parts=[];total=0;
      try{
        while(total<limit){
          const {done,value}=await reader.read();if(done)break;
          if(!value?.length)continue;
          const room=limit-total,part=value.length>room?value.subarray(0,room):value;
          parts.push(part);total+=part.length;
          const merged=concat(parts,total);
          if(total>=8&&!isPngStart(merged)){await reader.cancel().catch(()=>{});return null;}
          const pngEnd=zip.findPngEnd(merged);
          if(Number.isInteger(pngEnd)&&pngEnd>0){await reader.cancel().catch(()=>{});return new Blob([merged.subarray(0,pngEnd)],{type:'image/png'});}
          if(pngEnd===-1){await reader.cancel().catch(()=>{});return null;}
          if(total>=limit){await reader.cancel().catch(()=>{});return null;}
        }
      }catch(_){return null;}finally{reader.releaseLock();}
      return null;
    }
    return null;
  }

  function fromQuery(search){
    const params=new URLSearchParams(search);
    return params.has('url')?link(params.get('url')):null;
  }
  async function download(link,{fetch:request=globalThis.fetch,signal,onProgress=()=>{},pageUrl=globalThis.location?.href,online}={}){
    const address=url(link,pageUrl),size=r=>{const n=Number(r.headers.get('content-length'));return Number.isFinite(n)&&n>0?n:null;};
    const explain=(e,reading=false)=>connectionError(e,{address,pageUrl,online:online??globalThis.navigator?.onLine,signal,reading});
    const check=n=>{if(n>MAX_BYTES)throw failure('TOO_LARGE','世界资源超过 100 MB，无法导入。请使用更小的文件。');};
    let head;try{head=await request(address,{method:'HEAD',signal,credentials:'omit',referrerPolicy:'no-referrer'});}catch(e){if(signal?.aborted||e?.name==='AbortError')throw explain(e);}
    if(head?.ok)check(size(head));
    let response;try{response=await request(address,{method:'GET',signal,credentials:'omit',referrerPolicy:'no-referrer'});}catch(e){throw explain(e);}
    if(!response.ok){try{await response.body?.cancel();}catch(_){}throw httpError(response.status);}
    const total=size(response);try{check(total);}catch(e){try{await response.body?.cancel();}catch(_){}throw e;}
    let received=0;const chunks=[];onProgress({received,total});
    const reader=response.body?.getReader();
    try{
      if(reader){while(true){const {done,value}=await reader.read();if(done)break;received+=value.byteLength;check(received);chunks.push(value);onProgress({received,total});}}
      else{const bytes=new Uint8Array(await response.arrayBuffer());received=bytes.length;check(received);chunks.push(bytes);onProgress({received,total});}
    }catch(e){await reader?.cancel().catch(()=>{});throw explain(e,true);}finally{reader?.releaseLock();}
    const blob=new Blob(chunks),buffer=await blob.arrayBuffer(),signature=new Uint8Array(buffer,0,Math.min(8,buffer.byteLength));
    if(!blob.size)throw failure('EMPTY_FILE','下载到的文件为空。请向提供者确认世界资源是否上传完整。');
    const startsZip=signature[0]===80&&signature[1]===75&&((signature[2]===3&&signature[3]===4)||(signature[2]===5&&signature[3]===6));
    const startsPng=isPngStart(signature);
    if(!startsZip&&!startsPng)throw failure('NOT_WORLD','链接返回的内容既不是 ZIP，也不是可识别的 PNG 世界资源。可能是分享页面、登录页或错误页面。');
    if(startsPng&&!zip.zipArchiveBase(buffer))throw failure('PNG_NO_WORLD','该资源是普通 PNG 图片，不包含可导入的世界信息（ZIP 数据）。请检查世界资源格式。');
    if(startsZip&&!zip.zipArchiveBase(buffer))throw failure('INVALID_ZIP','ZIP 数据不完整或格式损坏，无法读取世界信息。');
    let name=startsPng?'module.png':'module.zip';
    try{const last=decodeURIComponent(new URL(response.url||address).pathname.split('/').pop());if(/\.(zip|png)$/i.test(last))name=last;}catch(_){}
    return {name,arrayBuffer:async()=>buffer};
  }
  return {MAX_BYTES,MAX_COVER_BYTES,DEFAULT_SOURCE,url,source,parse,load,fallbackCover,fromQuery,download};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameCatalog;
