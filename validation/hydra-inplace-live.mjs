// Opt-in subscription run: one conversation goes Normal → Dual → Hydra in place → Dual → Normal with real clients.
// CX_PAIR picks the pair: geminex (Codex + agy, default), claudex (Codex + Claude; also CX_PARTNER=claude) or
// claudini (Claude + agy, the conversation starting with Claude). CX_CLAUDE_MODEL matches the Claude model (default haiku).
// Fresh project folder and HYDRAQ data; agy uses the HYDRAQ hook and hydraq MCP route of the user's agy configuration.
// node validation/hydra-inplace-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {createHttpServer} from '../lib/http.mjs';
import {finalAnswer} from '../lib/handoff.mjs';

if(!process.argv.includes('--run'))throw Error('Passa --run explicitamente: este ensaio usa as contas dos clientes.');
const pairs={geminex:['Geminex','codex','antigravity'],claudex:['ClaudeX','codex','claude'],claudini:['Claudini','claude','antigravity']};
const choice=process.env.CX_PAIR||(process.env.CX_PARTNER==='claude'?'claudex':'geminex');if(!pairs[choice])throw Error('CX_PAIR deve ser geminex, claudex ou claudini');
const [pair,base,partner]=pairs[choice],agyPartner=partner==='antigravity',names={codex:'Codex',claude:'Claude',antigravity:'agy'},baseName=names[base];
// The conversation starts read-only: Codex with read-only, Claude in plan mode.
const baseSandbox=base==='codex'?'read-only':'plan';
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
 await hub.load();await Promise.all([base,partner].map(role=>clients[role].connect()));
 const pick=(role,match,effort)=>{const model=clients[role].models.find(m=>match.test(m.id)||match.test(m.name||''));if(!model)throw Error('Modelo indisponível: '+role+'/'+match);return {model:model.id,effort:model.efforts?.includes(effort)?effort:model.defaultEffort};};
 const models={codex:()=>pick('codex',/^gpt-6\.1-sol$/,'low'),claude:()=>pick('claude',new RegExp(process.env.CX_CLAUDE_MODEL||'haiku','i'),'low'),antigravity:()=>pick('antigravity',/^gemini-3\.8-flash$/,'medium')};
 const first=models[base](),other=models[partner]();
 console.log(JSON.stringify({pair,[base]:first,[partner]:other}));
 server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 // Normal.
 const chat=await hub.create({provider:base,cwd:directory,...first,sandbox:baseSandbox}),c=clients[base].conversation(chat.id);
 await hub.send(c.id,'Memoriza a palavra-código AZUL-7 para mais tarde. Responde só: guardado.','normal-1',{...first,sandbox:baseSandbox});
 await until(()=>c.turns.length===1&&idle(c),180000,'pedido normal');check(`Normal: ${baseName} respondeu`,c.status==='completed',finalAnswer(c,'normal-1'));
 const baseThread=c.threadId;
 // Dual with the partner, read-only.
 const {dual}=await hub.startDual(c.id,{provider:partner,...other});const p=clients[partner].conversation(dual.members.b.conversationId);
 await hub.sendDual(dual.id,{requestId:'dual-1',text:'Leiam o ficheiro plano.md deste projeto e digam numa frase o objetivo. Não alterem ficheiros.'});
 await until(()=>p.turns.length===1&&idle(p)&&idle(c),300000,'ronda dual');
 check('Dual: os dois responderam',c.status==='completed'&&p.status==='completed',{[base]:c.error,[partner]:p.error});
 check('Dual: parceiro em só leitura',p.turns[0].sandbox==='plan'&&(!agyPartner||p.turns[0].readOnlyGuard===true&&!p.turns[0].guardViolation));
 const partnerThread=p.threadId;
 // Hydra in place.
 const cx=hub.claudex,created=await cx.create({requestId:randomUUID(),conversationId:c.id,roles:[base,partner],author:base,members:{[base]:first,[partner]:other},guards:{turns:8,minutes:12},
  text:`Proponham juntos, em três pontos curtos, como validar o plano.md antes de o implementar. Na resposta comum, indiquem também a palavra-código que o utilizador pediu ao ${baseName} para memorizar no início desta conversa.`});
 const r=cx.record(created.task.id);
 check('Hydra: na mesma conversa, com as sessões do Dual',r.inPlace&&r.members[base].conversationId===c.id&&r.members[partner].conversationId===p.id,r.members);
 const guardDir=clients.antigravity.guardDirectory,routeDir=clients.antigravity.routeDirectory;let routeSeen=false,signature='';
 const end=Date.now()+600000;
 while((cx.active(r)||cx.releasable(r))&&Date.now()<end){
  if(agyPartner&&p.threadId){
   try{for(const line of (await readFile(path.join(guardDir,p.threadId+'.log'),'utf8')).split('\n').filter(Boolean)){const entry=JSON.parse(line);decisions.set(entry.at+entry.stepIdx,entry);}}catch{}
   try{await readFile(path.join(routeDir,p.threadId+'.json'));routeSeen=true;}catch{}
  }
  const next=JSON.stringify([r.status,c.status,p.status,r.seq,r.candidates.length,Object.keys(r.approvals),r.members[base].turns,r.members[partner].turns]);
  if(next!==signature){signature=next;const event={at:new Date().toISOString(),status:r.status,[base]:c.status,[partner]:p.status,messages:r.seq,candidates:r.candidates.length,approvals:Object.keys(r.approvals),turns:[r.members[base].turns,r.members[partner].turns]};events.push(event);console.log(JSON.stringify(event));}
  await sleep(500);
 }
 if(cx.active(r)||r.status==='paused'){console.log('A tarefa não terminou sozinha ('+r.status+'): a parar e devolver a conversa.');await cx.stop(r.id);}
 await until(()=>r.released,60000,'devolução');
 const claude=base==='claude'?c:partner==='claude'?p:null,hydraTurns=new Set((claude?.turns||[]).filter(t=>t.internal==='claudex').map(t=>t.id));
 check('Hydra: terminou com resposta comum',r.status==='completed',{status:r.status,error:r.error});
 check('Hydra: mesmas sessões nativas',c.threadId===baseThread&&p.threadId===partnerThread,{[base]:[baseThread,c.threadId],[partner]:[partnerThread,p.threadId]});
 if(agyPartner){
  const used=[...decisions.values()];
  check('Hydra: agy usou o servidor fixo pela rota da conversa',routeSeen&&used.some(d=>d.name==='call_mcp_tool'&&d.decision==='ask'),used.map(d=>d.name+':'+d.decision));
  check('Hydra: nenhuma ferramenta de escrita autorizada ao agy',!used.some(d=>d.decision==='ask'&&/write|replace|edit/.test(d.name))&&!p.turns.some(t=>t.guardViolation));
 }
 if(claude){
  check('Hydra: o Claude usou as ferramentas da tarefa na mesma sessão',claude.items.some(i=>hydraTurns.has(i.turnId)&&/initial_position|read_dialogue|send_to_peer|ready_to_conclude|review_final/.test(String(i.tool||''))),claude.items.filter(i=>hydraTurns.has(i.turnId)).map(i=>i.tool).slice(0,12));
  check('Hydra: o Claude não escreveu nem correu comandos',!claude.items.some(i=>hydraTurns.has(i.turnId)&&['fileChange','commandExecution'].includes(i.type)&&i.status==='completed'));
 }
 check('Hydra: memória de antes (AZUL-7 na resposta comum)',/AZUL-7/.test(r.result?.text||''),r.result?.text?.slice(0,400));
 check('Devolvida: definições e acesso repostos',!c.claudexTask&&!p.claudexTask&&c.sandbox===baseSandbox&&p.sandbox==='plan'&&(!agyPartner||!(await readdir(routeDir).catch(()=>[])).includes(p.threadId+'.json')));
 check('Devolvida: resultado publicado nesta conversa',c.turns.some(t=>t.source==='claudex-publication'));
 // Dual again: both remember, the partner works without the task's tools.
 await hub.sendDual(dual.id,{requestId:'dual-2',text:`Que palavra-código foi pedida ao ${baseName} no início desta conversa? Responde só com ela.`});
 await until(()=>p.turns.at(-1).requestId==='dual-2:b'&&idle(p)&&idle(c)&&c.turns.at(-1).requestId==='dual-2:a',300000,'ronda dual depois do Hydra');
 const partnerAfter=finalAnswer(p,'dual-2:b');
 check('Dual outra vez: o parceiro lembra-se, na mesma sessão',p.threadId===partnerThread&&/AZUL-7/.test(partnerAfter),partnerAfter.slice(0,200));
 if(claude)check('Dual outra vez: o Claude foi relançado sem as ferramentas da tarefa',!String(clients.claude.session?.contextMcpKey||'').includes('/claudex/')&&!claude.turns.at(-1).internal,clients.claude.session?.contextMcpKey||null);
 check('Dual outra vez: nota de regresso entregue aos dois',!c.hydraReturn&&!p.hydraReturn);
 // Back to one model.
 await hub.endDual(dual.id);
 await hub.send(c.id,`Que palavra-código te pedi para memorizar no início, e qual foi o primeiro ponto da resposta comum da tarefa ${pair}? Responde em duas linhas.`,'normal-2',{...first,sandbox:baseSandbox});
 await until(()=>c.turns.at(-1).requestId==='normal-2'&&idle(c),180000,'pedido depois do Hydra');
 const after=finalAnswer(c,'normal-2');
 check('Normal outra vez: mesma sessão, memória de antes e de durante',c.threadId===baseThread&&/AZUL-7/.test(after),after.slice(0,400));
 const files=(await readdir(directory)).filter(name=>!['codex','claude','antigravity','hub'].includes(name));
 check('Projeto sem alterações',files.join()==='plano.md',files);
}catch(error){check('Ensaio sem erros',false,error.message);}
finally{
 await writeFile(path.join(evidence,'summary.json'),JSON.stringify({pair,directory,checks,events,decisions:[...decisions.values()]},null,2));
 server?.close();await hub.close().catch(()=>{});
 console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name),evidence}));
}
