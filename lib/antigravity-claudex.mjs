import {mkdir,readFile,writeFile,copyFile,access,realpath,mkdtemp,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {startEgressProxy} from './antigravity-egress.mjs';

// Private native state and MCP configuration; the user's agy configuration is never rewritten.
export async function prepareAntigravityClaudeX({dataDir,conversation,contextMcp,executable,env=process.env}){
 if(process.platform!=='linux')throw Error('A colaboração com o Antigravity requer Linux e bubblewrap.');
 const home=path.join(dataDir,'claudex',conversation.id,'home'),native=path.join(home,'.gemini','antigravity-cli'),config=path.join(home,'.gemini','config'),original=env.HOME||os.homedir();
 await mkdir(native,{recursive:true,mode:0o700});await mkdir(config,{recursive:true,mode:0o700});await mkdir(path.join(home,'.config','antigravity'),{recursive:true,mode:0o700});
 for(const name of ['settings.json','jetski_state.pbtxt','installation_id']){
  const target=path.join(native,name);try{await access(target);}catch{await copyFile(path.join(original,'.gemini','antigravity-cli',name),target).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 const scope=path.join(original,'.config','antigravity','credential-user-scope');await copyFile(scope,path.join(home,'.config','antigravity','credential-user-scope')).catch(e=>{if(e.code!=='ENOENT')throw e;});
 let userSettings={};try{userSettings=JSON.parse(await readFile(path.join(original,'.gemini','config','config.json'),'utf8')).userSettings||{};}catch(e){if(e.code!=='ENOENT')throw e;}
 await writeFile(path.join(config,'config.json'),JSON.stringify({userSettings:{...userSettings,remoteControlEnabled:false},plugins:{},sidecars:{}}),{mode:0o600});
 await writeFile(path.join(config,'mcp_config.json'),JSON.stringify({mcpServers:contextMcp?{[contextMcp.name]:{command:contextMcp.command,args:contextMcp.args,env:contextMcp.env}}:{}}),{mode:0o600});
 const args=['--die-with-parent','--unshare-pid','--unshare-ipc','--unshare-net','--clearenv','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
 const bindings=new Set();
 const bind=async(p,writable=false)=>{if(bindings.has(p))return;try{await access(p);}catch(e){if(e.code==='ENOENT')return;throw e;}bindings.add(p);args.push(writable?'--bind':'--ro-bind',p,p);};
 for(const p of ['/usr','/bin','/lib','/lib64','/etc/ssl','/etc/ca-certificates','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/passwd','/etc/group','/etc/localtime'])await bind(p);
 // Keep the original executable path: the native credential service identifies this client.
 let binary=executable;
 if(!path.isAbsolute(binary)){binary=null;for(const folder of (env.PATH||'/usr/local/bin:/usr/bin:/bin').split(path.delimiter)){const candidate=path.resolve(folder,executable);try{await access(candidate);binary=candidate;break;}catch{}}if(!binary)throw Error('Executável Antigravity indisponível no PATH.');}
 await bind(binary);await bind(await realpath(binary));
 await bind(conversation.cwd);
 // A project may be HYDRAQ itself: do not expose its other clients' histories/credentials.
 const parentData=path.basename(dataDir)==='antigravity'?path.dirname(dataDir):dataDir;
 const hostData=parentData===conversation.cwd?dataDir:parentData;
 if(hostData!==conversation.cwd&&hostData.startsWith(conversation.cwd+path.sep))args.push('--tmpfs',hostData);
 await bind(home,true);
 for(const name of ['config.json','mcp_config.json'])await bind(path.join(config,name));
 await bind(path.join(native,'settings.json'));
 // Only the filtered credentials endpoint is mounted, never the host session bus.
 const busAddress=env.DBUS_SESSION_BUS_ADDRESS;
 if(busAddress)args.push('--ro-bind','@DBUS_PROXY@','/run/hydraq/credentials.sock');
 args.push('--ro-bind','@EGRESS_PROXY@','/run/hydraq/egress.sock');
 if(contextMcp){await bind(path.dirname(fileURLToPath(new URL('./claudex-mcp-server.mjs',import.meta.url))));await bind(contextMcp.command);await bind(await realpath(contextMcp.command));await bind(contextMcp.file);if(!contextMcp.socketPath)throw Error('O MCP privado do Antigravity requer transporte Unix.');await bind(contextMcp.socketPath);}
 const cleanEnv={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,XDG_CONFIG_HOME:path.join(home,'.config')};
 for(const name of ['USER','LOGNAME','LANG','TZ'])if(typeof env[name]==='string')cleanEnv[name]=env[name];
 for(const name of Object.keys(env))if(/^LC_[A-Z_]+$/.test(name))cleanEnv[name]=env[name];
 if(busAddress)cleanEnv.DBUS_SESSION_BUS_ADDRESS='unix:path=/run/hydraq/credentials.sock';
 for(const [name,value]of Object.entries(cleanEnv))args.push('--setenv',name,value);
 const bridge=fileURLToPath(new URL('./antigravity-net-bridge.mjs',import.meta.url));
 await bind(path.dirname(bridge));await bind(process.execPath);await bind(await realpath(process.execPath));
 args.push('--chdir',conversation.cwd,process.execPath,bridge,binary);
 return {executable:'bwrap',args,env:cleanEnv,home,key:'isolated-network-v2:'+(contextMcp?.file||home),busAddress};
}

/** Host-side services are reachable only through the explicitly mounted Unix sockets. */
export async function startAntigravityServices(launch){
 const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-agy-services-'));
 let proxy,bus,closing=false;
 const close=async()=>{if(closing)return;closing=true;if(bus){bus.stdio[3]?.destroy();bus.kill('SIGTERM');}await proxy?.close();await rm(directory,{recursive:true,force:true});};
 try{
  const egress=path.join(directory,'egress.sock');proxy=await startEgressProxy(egress);
  const credentials=path.join(directory,'credentials.sock');
  if(launch.busAddress){
   // fd 3 also ends the proxy if its parent disappears unexpectedly.
   bus=spawn('xdg-dbus-proxy',['--fd=3',launch.busAddress,credentials,'--filter','--talk=org.freedesktop.secrets'],{env:launch.env,stdio:['ignore','ignore','pipe','pipe']});
   let error;bus.once('error',e=>{error=e;});const deadline=Date.now()+5000;
   while(true){if(error||bus.exitCode!==null)throw Error('Não foi possível iniciar o acesso filtrado às credenciais.');try{if((await stat(credentials)).isSocket())break;}catch{}if(Date.now()>deadline)throw Error('O serviço filtrado de credenciais não iniciou.');await new Promise(resolve=>setTimeout(resolve,20));}
   bus.stdio[3]?.on('data',()=>{});bus.stderr.on('data',()=>{});
  }
  return {args:launch.args.map(arg=>arg==='@DBUS_PROXY@'?credentials:arg==='@EGRESS_PROXY@'?egress:arg),close,directory};
 }catch(error){await close();throw error;}
}
