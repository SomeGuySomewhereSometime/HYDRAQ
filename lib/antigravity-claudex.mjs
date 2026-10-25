import {mkdir,readFile,writeFile,copyFile,access,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

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
 const args=['--die-with-parent','--unshare-pid','--unshare-ipc','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
 const bindings=new Set();
 const bind=async(p,writable=false)=>{if(bindings.has(p))return;try{await access(p);}catch(e){if(e.code==='ENOENT')return;throw e;}bindings.add(p);args.push(writable?'--bind':'--ro-bind',p,p);};
 for(const p of ['/usr','/bin','/lib','/lib64','/etc/ssl','/etc/ca-certificates','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/passwd','/etc/group','/etc/localtime'])await bind(p);
 // Keep the original executable path: the native credential service identifies this client.
 let binary=executable;
 if(!path.isAbsolute(binary)){binary=null;for(const folder of (env.PATH||'/usr/local/bin:/usr/bin:/bin').split(path.delimiter)){const candidate=path.resolve(folder,executable);try{await access(candidate);binary=candidate;break;}catch{}}if(!binary)throw Error('Executável Antigravity indisponível no PATH.');}
 await bind(binary);await bind(await realpath(binary));
 await bind(conversation.cwd);await bind(home,true);
 for(const name of ['config.json','mcp_config.json'])await bind(path.join(config,name));
 await bind(path.join(native,'settings.json'));
 // Authentication uses the existing desktop credential service, without copying its secrets.
 const bus=env.DBUS_SESSION_BUS_ADDRESS?.match(/(?:^|;)unix:path=([^,;]+)/)?.[1];if(bus)await bind(bus);
 if(contextMcp){await bind(path.dirname(fileURLToPath(new URL('./claudex-mcp-server.mjs',import.meta.url))));await bind(contextMcp.command);await bind(await realpath(contextMcp.command));await bind(contextMcp.file);}
 args.push('--setenv','HOME',home,'--setenv','XDG_CONFIG_HOME',path.join(home,'.config'),'--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--chdir',conversation.cwd,binary);
 return {executable:'bwrap',args,env:{...env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config')},home,key:contextMcp?.file||home};
}
