'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function available(port){const socket=net.createServer();try{await new Promise((resolve,reject)=>socket.once('error',reject).listen(port,'127.0.0.1',resolve));return socket.address().port;}finally{if(socket.listening)await new Promise(resolve=>socket.close(resolve));}}
async function staticSite(){
  const root=path.resolve(__dirname,'../../dist'),server=http.createServer((req,res)=>{
    if(req.url==='/favicon.ico')return res.writeHead(204).end();
    const file=path.resolve(root,'.'+req.url.split('?')[0]);if(!file.startsWith(root+path.sep))return res.writeHead(404).end();
    fs.readFile(file,(error,bytes)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream');res.end(bytes);});
  });
  try{await new Promise((resolve,reject)=>server.once('error',reject).listen(4173,'127.0.0.1',resolve));}
  catch(error){if(error.code!=='EADDRINUSE')throw error;const response=await fetch('http://127.0.0.1:4173/index.html');const actual=Buffer.from(await response.arrayBuffer());if(!response.ok||!actual.equals(fs.readFileSync(path.join(root,'index.html'))))throw Error('4173 已由其他服务占用；未停止该服务');return {origin:'http://127.0.0.1:4173',close:async()=>{}};}
  return {origin:'http://127.0.0.1:4173',close:()=>new Promise(resolve=>server.close(resolve))};
}
async function startBridge(){
  if(process.env.BRIDGE_URL)return {url:process.env.BRIDGE_URL,external:true,close:async()=>{}};
  const repo=path.resolve(process.env.BRIDGE_REPO||path.join(__dirname,'../../../Bridge'));
  const executable=path.resolve(process.env.BRIDGE_EXE||path.join(repo,'artifacts/win-x64/RoomBridge.exe'));
  if(!fs.existsSync(executable))throw Error('缺少 Bridge 可执行文件，请在 Bridge 项目发布，或设置 BRIDGE_EXE / BRIDGE_URL');
  let port;try{port=await available(8080);}catch(error){if(error.code!=='EADDRINUSE')throw error;port=await available(0);}
  const child=spawn(executable,port===8080?[]:['--urls','http://127.0.0.1:'+port],{cwd:path.dirname(executable),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',failed;child.on('error',error=>{failed=error;});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output=(output+bytes).slice(-12000);});
  const close=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();});};
  try{
    const until=Date.now()+20000;let ready=false;
    while(Date.now()<until){if(failed)throw failed;if(child.exitCode!==null)throw Error('Bridge 提前退出：'+output);try{const response=await fetch('http://127.0.0.1:'+port+'/health');if(response.ok&&(await response.text())==='ok'){ready=true;break;}}catch{}await delay(100);}
    if(!ready)throw Error('Bridge 启动超时：'+output);
    return {url:'ws://127.0.0.1:'+port,pid:child.pid,executable,external:false,close};
  }catch(error){await close();throw error;}
}
module.exports={staticSite,startBridge};
