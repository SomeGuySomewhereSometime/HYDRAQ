import {mkdtemp, writeFile, appendFile} from 'node:fs/promises';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {createHttpServer} from '../lib/http.mjs';
const directory=process.env.NATIVE_TEST_DIR||await mkdtemp('/tmp/hydraq-native-live-');
const codex=new Hydraq({dataDir:directory+'/state',defaultCwd:directory});
const hub=new Providers({dataDir:directory+'/state',defaultCwd:directory,clients:{codex},git:async()=>null});
// UI checks exercise the same route but launch the original CLI via pexpect,
// rather than opening an interactive window on the user's desktop.
const openTerminal=hub.nativeSessions.open.bind(hub.nativeSessions);hub.nativeSessions.open=(id)=>openTerminal(id,{launch:false});
const write=hub.nativeSessions.write.bind(hub.nativeSessions);hub.nativeSessions.write=(peer,m)=>{appendFile(directory+'/wire-sizes.jsonl',JSON.stringify({method:m.method,id:m.id,bytes:JSON.stringify(m).length,buffered:peer?.bufferedAmount})+'\n').catch(()=>{});return write(peer,m);};
const events=[];codex.client.on('notification',m=>{events.push({method:m.method,keys:Object.keys(m.params||{})});writeFile(directory+'/events.json',JSON.stringify(events,null,2)).catch(()=>{});});
const connect=hub.nativeSessions.connected.bind(hub.nativeSessions);hub.nativeSessions.connected=(s,p)=>{p.on('close',(code,reason)=>writeFile(directory+'/peer-close.json',JSON.stringify({code,reason:reason.toString()})));return connect(s,p);};
const methods=[];const dispatch=hub.nativeSessions.dispatch.bind(hub.nativeSessions);hub.nativeSessions.dispatch=async(s,m,p,id)=>{methods.push({method:m,keys:Object.keys(p),...(m==='config/batchWrite'?{edits:p.edits}: {}),...(m==='thread/resume'?{configKeys:Object.keys(p.config||{}),webSearch:p.config?.web_search,hasDeveloperInstructions:!!p.developerInstructions,hasBaseInstructions:!!p.baseInstructions}: {})});return dispatch(s,m,p,id);};
await hub.load();
const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let closed=false;
async function close(){if(closed)return;closed=true;await writeFile(directory+'/methods.json',JSON.stringify(methods,null,2));server.closeStreams();server.close();await hub.close();}
process.on('SIGTERM',()=>close());process.on('SIGINT',()=>close());
try {
 await hub.connect('codex');
 const model=codex.models.find(m=>m.id==='gpt-6.1-sol')||codex.models.find(m=>m.isDefault)||codex.models[0];
 let c=codex.conversations[0];
 if(!c){
 const project=await hub.createProject({name:'Validação terminal Codex',root:directory,revision:0});
 await hub.context.save(project.id,{revision:0,text:'Marcador de memória do ensaio: MEMORIA_NATIVA_731.'});
 const created=await hub.create({provider:'codex',projectId:project.id,revision:hub.projects.data.revision,cwd:directory,model:model.id,effort:model.efforts.includes('low')?'low':model.defaultEffort,sandbox:'read-only'});
 c=codex.conversation(created.id);
 await hub.send(c.id,'Responde apenas HYDRAQ_SEED_OK. Não uses ferramentas nem alteres ficheiros.','native-live-seed');
 const until=Date.now()+120000;while(['starting','running','waiting'].includes(c.status)){if(Date.now()>until)throw Error('Seed timeout');await new Promise(r=>setTimeout(r,100));}
 if(c.status!=='completed')throw Error(c.error||c.status);
 }
 const info=await hub.nativeSessions.open(c.id,{launch:false});
 const session=hub.nativeSessions.sessions.get(c.id);
 await writeFile(directory+'/info.json',JSON.stringify({directory,conversationId:c.id,threadId:c.threadId,socket:session.socket,model:model.id,port:server.address().port,seed:c.messages.at(-1).text}));
 await writeFile('/tmp/hydraq-native-live-current',directory);
 console.log(JSON.stringify({directory,seed:c.status,model:model.id,threadId:c.threadId}));
 codex.on('state',()=>writeFile(directory+'/observation.json',JSON.stringify({status:c.status,turns:c.turns,messages:c.messages,approvals:codex.snapshot().approvals},null,2)).catch(()=>{}));
} catch(e){console.error(e);await close();process.exitCode=1;}
