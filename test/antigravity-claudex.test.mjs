import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {prepareAntigravityClaudeX,startAntigravityServices} from '../lib/antigravity-claudex.mjs';

async function fixture(t){
 const root=await mkdtemp('/tmp/hydraq-agy-isolation-');t.after(()=>rm(root,{recursive:true,force:true}));
 const original=path.join(root,'original'),dataDir=path.join(root,'data'),cwd=path.join(root,'workspace');
 await Promise.all([mkdir(path.join(original,'.gemini','config'),{recursive:true}),mkdir(path.join(original,'.gemini','antigravity-cli'),{recursive:true}),mkdir(path.join(original,'.config','antigravity'),{recursive:true}),mkdir(cwd)]);
 const globalConfig={userSettings:{theme:'dark',remoteControlEnabled:true},plugins:{external:true},sidecars:{outside:true}};
 const globalMcp={mcpServers:{unrelated:{command:'unrelated'}}};
 await writeFile(path.join(original,'.gemini','config','config.json'),JSON.stringify(globalConfig));
 await writeFile(path.join(original,'.gemini','config','mcp_config.json'),JSON.stringify(globalMcp));
 for(const [name,content] of [['settings.json',JSON.stringify({toolPermission:'always-proceed'})],['jetski_state.pbtxt','native-state'],['installation_id','installation-test']])await writeFile(path.join(original,'.gemini','antigravity-cli',name),content);
 await writeFile(path.join(original,'.config','antigravity','credential-user-scope'),'scope-a');
 const file=path.join(root,'lease-a.json');await writeFile(file,JSON.stringify({token:'temporary-a'}));
 const socketPath=path.join(root,'mcp.sock');await writeFile(socketPath,'placeholder');
 const contextMcp={socketPath,name:'claudex',command:process.execPath,args:[path.resolve('lib/claudex-mcp-server.mjs'),file],env:{CLAUDEX_TEST:'yes'},file};
 return {root,original,dataDir,conversation:{id:'test-session',cwd},contextMcp,executable:process.execPath,env:{HOME:original,PATH:process.env.PATH,GROQ_API_KEY:'must-not-enter',NODE_OPTIONS:'--trace-warnings',HTTP_PROXY:'http://private-host:4318',LD_PRELOAD:'/tmp/untrusted.so',DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS},globalConfig,globalMcp};
}
const json=async file=>JSON.parse(await readFile(file,'utf8'));
function mounts(args){const values=[];for(let i=0;i<args.length;i++)if(['--bind','--ro-bind'].includes(args[i]))values.push({mode:args[i],source:args[i+1],destination:args[i+2]});return values;}

test('ClaudeX prepares private MCP and native state without changing global configuration',async t=>{
 const f=await fixture(t),prepared=await prepareAntigravityClaudeX(f),config=path.join(prepared.home,'.gemini','config');
 assert.deepEqual(await json(path.join(config,'mcp_config.json')),{mcpServers:{claudex:{command:f.contextMcp.command,args:f.contextMcp.args,env:f.contextMcp.env}}});
 assert.deepEqual(await json(path.join(config,'config.json')),{userSettings:{theme:'dark',remoteControlEnabled:false},plugins:{},sidecars:{}});
 assert.deepEqual(await json(path.join(f.original,'.gemini','config','config.json')),f.globalConfig);
 assert.deepEqual(await json(path.join(f.original,'.gemini','config','mcp_config.json')),f.globalMcp);
 assert.equal(await readFile(path.join(prepared.home,'.gemini','antigravity-cli','jetski_state.pbtxt'),'utf8'),'native-state');
 assert.equal(await readFile(path.join(prepared.home,'.config','antigravity','credential-user-scope'),'utf8'),'scope-a');
 assert.equal(prepared.env.HOME,prepared.home);assert.equal(prepared.env.XDG_CONFIG_HOME,path.join(prepared.home,'.config'));
});

test('bubblewrap exposes workspace and MCP lease read-only with only private HOME writable',async t=>{
 const f=await fixture(t),prepared=await prepareAntigravityClaudeX(f),bindings=mounts(prepared.args);
 assert.equal(prepared.executable,'bwrap');
 assert.deepEqual(bindings.filter(b=>b.mode==='--bind'),[{mode:'--bind',source:prepared.home,destination:prepared.home}]);
 for(const source of [f.conversation.cwd,f.contextMcp.file,path.dirname(f.contextMcp.args[0]),path.join(prepared.home,'.gemini','config','config.json'),path.join(prepared.home,'.gemini','config','mcp_config.json'),path.join(prepared.home,'.gemini','antigravity-cli','settings.json')])assert.ok(bindings.some(b=>b.mode==='--ro-bind'&&b.source===source&&b.destination===source),source);
 assert.ok(prepared.args.some((arg,i)=>arg==='--tmpfs'&&prepared.args[i+1]==='/tmp'));
 assert.ok(prepared.args.includes('--unshare-pid'));assert.ok(prepared.args.includes('--unshare-ipc'));
 assert.deepEqual(prepared.args.slice(-5),['--chdir',f.conversation.cwd,process.execPath,path.resolve('lib/antigravity-net-bridge.mjs'),process.execPath]);
 assert.ok(prepared.args.includes('--unshare-net'));assert.ok(prepared.args.includes('--clearenv'));assert.equal(prepared.env.GROQ_API_KEY,undefined);
 for(const name of ['NODE_OPTIONS','LD_PRELOAD','HTTP_PROXY','GROQ_API_KEY'])assert.equal(prepared.env[name],undefined);
 assert.equal(prepared.args.includes(f.env.DBUS_SESSION_BUS_ADDRESS),false);assert.equal(bindings.some(b=>b.source==='/run/user/1000/bus'),false);
 assert.equal(bindings.some(b=>b.source===f.original),false);
});

test('renewed leases replace MCP credentials and leaving ClaudeX removes its MCP configuration',async t=>{
 const f=await fixture(t),first=await prepareAntigravityClaudeX(f),file=path.join(f.root,'lease-b.json');await writeFile(file,JSON.stringify({token:'temporary-b'}));
 await writeFile(path.join(f.original,'.config','antigravity','credential-user-scope'),'scope-b');
 const contextMcp={...f.contextMcp,file,args:[f.contextMcp.args[0],file]},second=await prepareAntigravityClaudeX({...f,contextMcp});
 assert.equal(second.home,first.home);assert.notEqual(second.key,first.key);assert.ok(second.key.endsWith(file));
 assert.deepEqual((await json(path.join(second.home,'.gemini','config','mcp_config.json'))).mcpServers.claudex.args,contextMcp.args);
 assert.equal(await readFile(path.join(second.home,'.config','antigravity','credential-user-scope'),'utf8'),'scope-b');
 assert.equal(mounts(second.args).some(b=>b.source===f.contextMcp.file),false);
 const outside=await prepareAntigravityClaudeX({...f,contextMcp:null});
 assert.notEqual(outside.key,second.key);assert.deepEqual(await json(path.join(outside.home,'.gemini','config','mcp_config.json')),{mcpServers:{}});
 assert.equal(mounts(outside.args).some(b=>b.source===file||b.source===f.contextMcp.file),false);
 assert.deepEqual(await json(path.join(f.original,'.gemini','config','mcp_config.json')),f.globalMcp);
});

// Opt in because nested sandboxes may prohibit network/PID namespaces and desktop DBus.
test('kernel blocks writes and host networking; environment and session bus are restricted',{skip:process.env.HYDRAQ_TEST_BWRAP!=='1'},async t=>{
 const f=await fixture(t),prepared=await prepareAntigravityClaudeX(f),services=await startAntigravityServices(prepared);t.after(()=>services.close());
 const target=path.join(f.root,'escaped-systemd.txt');
 const probe=`const fs=require('node:fs');const cp=require('node:child_process');const net=require('node:net');(async()=>{const checks={};for(const file of ${JSON.stringify([path.join(f.conversation.cwd,'forbidden.txt'),f.contextMcp.file])}){try{fs.writeFileSync(file,'forbidden');checks[file]='WRITABLE'}catch(e){checks[file]=e.code}};fs.writeFileSync(process.env.HOME+'/allowed.txt','ok');fs.writeFileSync('/tmp/allowed.txt','ok');checks.secret=process.env.GROQ_API_KEY||null;const http=require('node:http');const proxy=new URL(process.env.HTTP_PROXY);checks.proxyBootstrap=await new Promise(resolve=>{const r=http.get({hostname:proxy.hostname,port:proxy.port,path:'http://127.0.0.1:4318/api/bootstrap'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});r.on('error',e=>resolve(e.code))});checks.bootstrap=await new Promise(resolve=>{const s=net.connect(4318,'127.0.0.1');s.once('connect',()=>{resolve('CONNECTED');s.destroy()});s.once('error',e=>resolve(e.code));s.setTimeout(1500,()=>{resolve('TIMEOUT');s.destroy()})});if(process.env.DBUS_SESSION_BUS_ADDRESS){const r=cp.spawnSync('systemd-run',['--user','--quiet','/usr/bin/touch',${JSON.stringify(target)}],{encoding:'utf8',timeout:5000});checks.systemd=r.status;const b=cp.spawnSync('busctl',['--address='+process.env.DBUS_SESSION_BUS_ADDRESS,'call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','ListUnits'],{encoding:'utf8',timeout:5000});checks.busDenied=b.status!==0&&!!b.stderr.match(/denied|not provided|not found|permission|not available|ServiceUnknown/i);checks.busError=b.stderr;}console.log(JSON.stringify(checks))})().catch(e=>{console.error(e);process.exitCode=1});`;
 const result=await new Promise((resolve,reject)=>{const child=spawn(prepared.executable,[...services.args,'-e',probe],{env:prepared.env});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.once('error',reject);child.once('close',status=>resolve({status,stdout,stderr}));});
 assert.equal(result.status,0,result.stderr);const checks=JSON.parse(result.stdout.trim());
 for(const file of [path.join(f.conversation.cwd,'forbidden.txt'),f.contextMcp.file])assert.equal(checks[file],'EROFS');
 assert.equal(checks.secret,null);assert.equal(checks.proxyBootstrap,403);assert.notEqual(checks.bootstrap,'CONNECTED');
 if(f.env.DBUS_SESSION_BUS_ADDRESS){assert.notEqual(checks.systemd,0);assert.equal(checks.busDenied,true,checks.busError);}
 await assert.rejects(readFile(target),{code:'ENOENT'});assert.equal(await readFile(path.join(prepared.home,'allowed.txt'),'utf8'),'ok');
});

test('HYDRAQ project hides unrelated client state without hiding project files',async t=>{
 const f=await fixture(t);const dataDir=path.join(f.conversation.cwd,'.hydraq','antigravity');
 const prepared=await prepareAntigravityClaudeX({...f,dataDir});
 assert.ok(prepared.args.some((v,i)=>v==='--tmpfs'&&prepared.args[i+1]===path.dirname(dataDir)));
 const temp=await prepareAntigravityClaudeX({...f,dataDir:path.join(f.conversation.cwd,'antigravity')});
 assert.ok(!temp.args.some((v,i)=>v==='--tmpfs'&&temp.args[i+1]===f.conversation.cwd));
});
