import {WebSocketServer,WebSocket} from 'ws';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {chromium} from '/home/sauron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const dir=(await readFile('/tmp/hydraq-native-live-current','utf8')).trim(),info=JSON.parse(await readFile(dir+'/info.json','utf8'));
const home=dir+'/desktop-home',profile=dir+'/desktop-profile';for(const p of [home,profile])await mkdir(p,{recursive:true,mode:0o700});
const records=[];let connections=0,child,browser;
const wss=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>wss.once('listening',r));
wss.on('connection',down=>{connections++;const up=new WebSocket('ws+unix://'+info.socket+':/'),queue=[];up.on('error',()=>down.close());down.on('error',()=>{});up.on('open',()=>queue.splice(0).forEach(m=>up.send(m,{binary:false})));down.on('message',raw=>{const m=JSON.parse(String(raw));records.push({side:'desktop',method:m.method,keys:Object.keys(m.params||{}),threadId:m.params?.threadId});if(up.readyState===1)up.send(raw,{binary:false});else queue.push(raw);});up.on('message',raw=>{const m=JSON.parse(String(raw));if(m.error)records.push({side:'server',error:m.error});if(down.readyState===1)down.send(raw,{binary:false});});down.on('close',()=>up.terminate());up.on('close',()=>down.close());});
try {
 await rm(profile+'/DevToolsActivePort',{force:true});
 child=spawn('/usr/lib/chatgpt/ChatGPT',['--user-data-dir='+profile,'--remote-debugging-port=0','codex://threads/'+info.threadId],{cwd:dir,env:{...process.env,CODEX_HOME:home,CODEX_ELECTRON_USER_DATA_PATH:profile,CODEX_APP_SERVER_WS_URL:'ws://127.0.0.1:'+wss.address().port},stdio:['ignore','ignore','pipe'],detached:true});let diagnostic='';child.stderr.on('data',x=>diagnostic+=x.toString());
 let port;for(let i=0;i<80;i++){try{port=(await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0];break;}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!port)throw Error('Sem DevToolsActivePort; '+diagnostic.slice(-300));
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
 await new Promise(r=>setTimeout(r,12000));
 const pages=browser.contexts().flatMap(c=>c.pages());
 const result={connections,pages:[]};
 for(const [i,page] of pages.entries()){result.pages.push({url:page.url(),text:(await page.locator('body').innerText().catch(()=>'' )).slice(0,16000)});await page.screenshot({path:dir+'/desktop-'+i+'.png'}).catch(()=>{});}
 await writeFile(dir+'/desktop-authenticated.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(e){console.error(e.message);process.exitCode=1;}
finally{await writeFile(dir+'/desktop-methods.json',JSON.stringify(records,null,2));if(browser)await browser.close();if(child&&child.exitCode===null){process.kill(-child.pid,'SIGTERM');await new Promise(r=>child.once('exit',r));}for(const p of wss.clients)p.terminate();await new Promise(r=>wss.close(r));}
