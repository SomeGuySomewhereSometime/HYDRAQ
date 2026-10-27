// Opt-in subscription run: one conversation goes Normal → Dual → Geminex (Hydra in place) → Normal with the real Codex
// and agy. Fresh project folder and HYDRAQ data; agy uses the HYDRAQ hook and hydraq MCP route of the user's agy
// configuration. node validation/hydra-inplace-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
import {finalAnswer} from '../lib/handoff.mjs';

if(!process.argv.includes('--run'))throw Error('Passa --run explicitamente: este ensaio usa as contas do Codex e do agy.');
const evidence=path.resolve(process.argv.find((arg,i)=>i>1&&!arg.startsWith('--'))||'.hydraq/hydra-inplace-live-2026-10-27');
await mkdir(evidence,{recursive:true});
const directory=await mkdtemp('/tmp/hydraq-inplace-live-');
await writeFile(directory+'/plano.md','# Plano\nImportar tarefas de ficheiros JSON de várias instalações, sem perder registos locais. Validar o formato antes de juntar.\n');
const clients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:directory}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:directory}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:directory})};
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:directory,clients,git:async()=>[]});
const checks=[],events=[],decisions=new Map();let server;
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});console.log((ok?'PASS ':'FAIL ')+name+(detail===undefined?'':' — '+JSON.stringify(detail).slice(0,300)));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,ms,label)=>{const end=Date.now()+ms;while(!predicate()){if(Date.now()>end)throw Error('Tempo excedido: '+label);await sleep(500);}};
const idle=c=>!['starting','running','waiting'].includes(c.status);
try{
 await hub.load();await Promise.all(['codex','antigravity'].map(role=>clients[role].connect()));
 const pick=(role,id,effort)=>{const model=clients[role].models.find(m=>m.id===id);if(!model)throw Error('Modelo indisponível: '+role+'/'+id);return {model:model.id,effort:model.efforts.includes(effort)?effort:model.defaultEffort};};
 const sol=pick('codex','gpt-6.1-sol','low'),flash=pick('antigravity','gemini-3.8-flash','medium');
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 // Normal.
 const chat=await hub.create({provider:'codex',cwd:directory,...sol,sandbox:'read-only'}),c=clients.codex.conversation(chat.id);
 await hub.send(c.id,'Memoriza a palavra-código AZUL-7 para mais tarde. Responde só: guardado.','normal-1',{...sol,sandbox:'read-only'});
 await until(()=>c.turns.length===1&&idle(c),180000,'pedido normal');check('Normal: Codex respondeu',c.status==='completed',finalAnswer(c,'normal-1'));
 const codexThread=c.threadId;
 // Dual with agy, read-only through the hook.
 const {dual}=await hub.startDual(c.id,{provider:'antigravity',...flash});const agy=clients.antigravity.conversation(dual.members.b.conversationId);
 await hub.sendDual(dual.id,{requestId:'dual-1',text:'Leiam o ficheiro plano.md deste projeto e digam numa frase o objetivo. Não alterem ficheiros.'});
 await until(()=>agy.turns.length===1&&idle(agy)&&idle(c),300000,'ronda dual');
 check('Dual: os dois responderam',c.status==='completed'&&agy.status==='completed',{codex:c.error,agy:agy.error});
 check('Dual: agy em só leitura pela proteção',agy.turns[0].readOnlyGuard===true&&!agy.turns[0].guardViolation);
 const agyThread=agy.threadId;
 // Geminex in place.
 const cx=hub.claudex,created=await cx.create({requestId:randomUUID(),conversationId:c.id,roles:['codex','antigravity'],author:'codex',members:{codex:sol,antigravity:flash},guards:{turns:8,minutes:12},
  text:'Proponham juntos, em três pontos curtos, como validar o plano.md antes de o implementar. Na resposta comum, indiquem também a palavra-código que o utilizador pediu ao Codex para memorizar no início desta conversa.'});
 const r=cx.record(created.task.id);
 check('Hydra: na mesma conversa, com as sessões do Dual',r.inPlace&&r.members.codex.conversationId===c.id&&r.members.antigravity.conversationId===agy.id,r.members);
 const guardDir=clients.antigravity.guardDirectory,routeDir=clients.antigravity.routeDirectory;let routeSeen=false,signature='';
 const end=Date.now()+600000;
 while((cx.active(r)||cx.releasable(r))&&Date.now()<end){
  for(const id of [agy.threadId]){
   if(!id)continue;
   try{for(const line of (await readFile(path.join(guardDir,id+'.log'),'utf8')).split('\n').filter(Boolean)){const entry=JSON.parse(line);decisions.set(entry.at+entry.stepIdx,entry);}}catch{}
   try{await readFile(path.join(routeDir,id+'.json'));routeSeen=true;}catch{}
  }
  const next=JSON.stringify([r.status,c.status,agy.status,r.seq,r.candidates.length,Object.keys(r.approvals),r.members.codex.turns,r.members.antigravity.turns]);
  if(next!==signature){signature=next;const event={at:new Date().toISOString(),status:r.status,codex:c.status,agy:agy.status,messages:r.seq,candidates:r.candidates.length,approvals:Object.keys(r.approvals),turns:[r.members.codex.turns,r.members.antigravity.turns]};events.push(event);console.log(JSON.stringify(event));}
  await sleep(500);
 }
 if(cx.active(r)||r.status==='paused'){console.log('A tarefa não terminou sozinha ('+r.status+'): a parar e devolver a conversa.');await cx.stop(r.id);}
 await until(()=>r.released,60000,'devolução');
 const used=[...decisions.values()];
 check('Hydra: terminou com resposta comum',r.status==='completed',{status:r.status,error:r.error});
 check('Hydra: mesmas sessões nativas',c.threadId===codexThread&&agy.threadId===agyThread,{codex:[codexThread,c.threadId],agy:[agyThread,agy.threadId]});
 check('Hydra: agy usou o servidor fixo pela rota da conversa',routeSeen&&used.some(d=>d.name==='call_mcp_tool'&&d.decision==='ask'),used.map(d=>d.name+':'+d.decision));
 check('Hydra: nenhuma ferramenta de escrita autorizada ao agy',!used.some(d=>d.decision==='ask'&&/write|replace|edit/.test(d.name))&&!agy.turns.some(t=>t.guardViolation));
 check('Hydra: memória de antes (AZUL-7 na resposta comum)',/AZUL-7/.test(r.result?.text||''),r.result?.text?.slice(0,400));
 check('Devolvida: definições e acesso repostos, sem rota',!c.claudexTask&&!agy.claudexTask&&c.sandbox==='read-only'&&agy.sandbox==='plan'&&!(await readdir(routeDir).catch(()=>[])).includes(agy.threadId+'.json'));
 check('Devolvida: resultado publicado nesta conversa',c.turns.some(t=>t.source==='claudex-publication'));
 // Back to one model.
 await hub.endDual(dual.id);
 await hub.send(c.id,'Que palavra-código te pedi para memorizar no início, e qual foi o primeiro ponto da resposta comum da tarefa Geminex? Responde em duas linhas.','normal-2',{...sol,sandbox:'read-only'});
 await until(()=>c.turns.at(-1).requestId==='normal-2'&&idle(c),180000,'pedido depois do Hydra');
 const after=finalAnswer(c,'normal-2');
 check('Normal outra vez: mesma sessão, memória de antes e de durante',c.threadId===codexThread&&/AZUL-7/.test(after),after.slice(0,400));
 check('Normal outra vez: nota de regresso enviada uma vez',!c.hydraReturn);
 const files=(await readdir(directory)).filter(name=>!['codex','claude','antigravity','hub'].includes(name));
 check('Projeto sem alterações',files.join()==='plano.md',files);
}catch(error){check('Ensaio sem erros',false,error.message);}
finally{
 await writeFile(path.join(evidence,'summary.json'),JSON.stringify({directory,checks,events,decisions:[...decisions.values()]},null,2));
 server?.close();await hub.close().catch(()=>{});
 console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name),evidence}));
}
