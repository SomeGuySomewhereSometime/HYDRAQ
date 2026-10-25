import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareAntigravityClaudeX} from '../lib/antigravity-claudex.mjs';

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
 const contextMcp={name:'claudex',command:process.execPath,args:[path.resolve('lib/claudex-mcp-server.mjs'),file],env:{CLAUDEX_TEST:'yes'},file};
 return {root,original,dataDir,conversation:{id:'test-session',cwd},contextMcp,executable:process.execPath,env:{HOME:original,PATH:process.env.PATH},globalConfig,globalMcp};
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
 assert.deepEqual(prepared.args.slice(-3),['--chdir',f.conversation.cwd,process.execPath]);
 assert.equal(bindings.some(b=>b.source===f.original),false);
});

test('renewed leases replace MCP credentials and leaving ClaudeX removes its MCP configuration',async t=>{
 const f=await fixture(t),first=await prepareAntigravityClaudeX(f),file=path.join(f.root,'lease-b.json');await writeFile(file,JSON.stringify({token:'temporary-b'}));
 await writeFile(path.join(f.original,'.config','antigravity','credential-user-scope'),'scope-b');
 const contextMcp={...f.contextMcp,file,args:[f.contextMcp.args[0],file]},second=await prepareAntigravityClaudeX({...f,contextMcp});
 assert.equal(second.home,first.home);assert.notEqual(second.key,first.key);assert.equal(second.key,file);
 assert.deepEqual((await json(path.join(second.home,'.gemini','config','mcp_config.json'))).mcpServers.claudex.args,contextMcp.args);
 assert.equal(await readFile(path.join(second.home,'.config','antigravity','credential-user-scope'),'utf8'),'scope-b');
 assert.equal(mounts(second.args).some(b=>b.source===f.contextMcp.file),false);
 const outside=await prepareAntigravityClaudeX({...f,contextMcp:null});
 assert.notEqual(outside.key,second.key);assert.deepEqual(await json(path.join(outside.home,'.gemini','config','mcp_config.json')),{mcpServers:{}});
 assert.equal(mounts(outside.args).some(b=>b.source===file||b.source===f.contextMcp.file),false);
 assert.deepEqual(await json(path.join(f.original,'.gemini','config','mcp_config.json')),f.globalMcp);
});

// Opt in because nested sandbox environments may prohibit creating Linux namespaces.
test('kernel refuses workspace and lease writes while private HOME and tmp remain usable',{skip:process.env.HYDRAQ_TEST_BWRAP!=='1'},async t=>{
 const f=await fixture(t),prepared=await prepareAntigravityClaudeX(f);
 const probe=`const fs=require('node:fs');const checks=[];for(const file of ${JSON.stringify([path.join(f.conversation.cwd,'forbidden.txt'),f.contextMcp.file])}){try{fs.writeFileSync(file,'forbidden');checks.push('WRITABLE')}catch(e){checks.push(e.code)}};fs.writeFileSync(process.env.HOME+'/allowed.txt','ok');fs.writeFileSync('/tmp/allowed.txt','ok');console.log(JSON.stringify(checks));`;
 const result=spawnSync(prepared.executable,[...prepared.args,'-e',probe],{env:prepared.env,encoding:'utf8',timeout:15000});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),['EROFS','EROFS']);
 assert.equal(await readFile(path.join(prepared.home,'allowed.txt'),'utf8'),'ok');assert.deepEqual(await json(f.contextMcp.file),{token:'temporary-a'});
});
