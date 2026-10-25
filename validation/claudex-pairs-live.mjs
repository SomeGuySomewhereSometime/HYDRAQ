// Opt-in subscription experiment. Fresh sessions and fixtures, never active HYDRAQ data.
// Controlled changing-evidence review, not a blind quality benchmark.
import {mkdtemp,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
const partner=process.env.CX_PARTNER||'codex';if(!['codex','claude'].includes(partner))throw Error('CX_PARTNER deve ser codex ou claude');
import {createHttpServer} from '../lib/http.mjs';
const directory=await mkdtemp('/tmp/hydraq-pairs-live-');
const clients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:directory}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:directory,questions:true}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:directory})};
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:directory,clients,git:async()=>[]});let server;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 await hub.load();await Promise.all([partner,'antigravity'].map(role=>clients[role].connect()));
 const catalog=Object.fromEntries(Object.entries(clients).map(([role,c])=>[role,{connection:c.connection,error:c.connectionError,models:c.models.map(m=>({id:m.id,name:m.name,efforts:m.efforts,defaultEffort:m.defaultEffort}))}]));
 console.log(JSON.stringify(process.argv.includes('--catalog')?{directory,catalog}:{directory,connections:Object.fromEntries(Object.entries(catalog).map(([k,v])=>[k,v.connection]))}));
 if(!process.argv.includes('--catalog')){
  if(!process.argv.includes('--run'))throw Error('Passa --catalog ou --run explicitamente.');
  const select=(role,id)=>{const model=clients[role].models.find(m=>m.id===id);if(!model)throw Error('Modelo pedido indisponível: '+role+'/'+id);return {model:model.id,effort:model.efforts.includes('low')?'low':model.defaultEffort};};
  const selected={[partner]:select(partner,partner==='codex'?'gpt-6.1-sol':'opus'),antigravity:select('antigravity',process.env.CX_AGY_MODEL||'gemini-4-argon')};
  const agyModel=clients.antigravity.models.find(m=>m.id===selected.antigravity.model);
  server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  await writeFile(directory+'/legacy-contract.md','# Contrato legado v1\nOs IDs numéricos são globalmente únicos entre instalações. O importador junta registos por id; colisões indicam versões da mesma tarefa. Preserve os restantes registos locais.\n');
  const cx=hub.claudex,events=[];let signature='',phase=1,bothRunning=false,receivedDuringBoth=false,pausedForAudit=false,nativeBefore,leaseFilesBefore,oldTokens;
  const publish=cx.publish.bind(cx);cx.publish=async r=>{if(phase===1&&r.candidates.length===1)return;return publish(r);};
  const created=await cx.create({requestId:randomUUID(),roles:[partner,'antigravity'],cwd:directory,members:selected,guards:{turns:12,minutes:8},text:'Analisem um plano curto para importar tarefas JSON de várias instalações locais, preservando os restantes registos locais. Investiguem o contrato legado em '+directory+'/legacy-contract.md e usem-no como pressuposto desta primeira versão: os IDs numéricos são globais. Proponham um plano concreto com identidade e colisões, sem implementar. Partilhem evidências e raciocínio útil, tratem objeções reais; não inventem desacordo. Não usem web nem escrevam ficheiros. A leitura dos ficheiros locais fornecidos é autorizada. Registem posições independentes, sigam o protocolo ClaudeX e proponham/aprovem um documento de até 180 palavras. Terminem o turno quando esperarem pelo colega, sem polling ou agradecimentos.',consensus:true,author:partner});
  const r=cx.record(created.task.id),end=Date.now()+480000;
  while((cx.active(r)||r.status==='paused'&&phase===1)&&Date.now()<end){
   const statuses=Object.fromEntries([partner,'antigravity'].map(role=>[role,cx.native(r,role).status]));if(Object.values(statuses).every(s=>s==='running'))bothRunning=true;
   if(Object.values(statuses).every(s=>s==='running')&&[partner,'antigravity'].some(role=>r.messages.some(m=>m.from!==role&&['discovery','objection'].includes(m.type)&&r.read[role]?.seq>=m.seq)))receivedDuringBoth=true;
   const next=JSON.stringify([phase,r.status,statuses,r.seq,r.candidates.length,Object.keys(r.approvals),r.members[partner].turns,r.members.antigravity.turns]);
   if(next!==signature){signature=next;const event={at:new Date().toISOString(),phase,status:r.status,statuses,messages:r.seq,candidates:r.candidates.length,approvals:Object.keys(r.approvals),turns:[r.members[partner].turns,r.members.antigravity.turns]};events.push(event);console.log(JSON.stringify(event));}
   if(phase===1&&r.candidates.length===1&&Object.values(statuses).every(status=>status==='completed')){
    nativeBefore=Object.fromEntries([partner,'antigravity'].map(role=>[role,{conversationId:cx.native(r,role).id,threadId:cx.native(r,role).threadId}]));
    oldTokens=[...cx.leases].filter(([,l])=>l.taskId===r.id).map(([token])=>token);leaseFilesBefore=[...cx.leases.values()].filter(l=>l.taskId===r.id).map(l=>l.config.file);
    if(cx.active(r))await cx.pause(r.id);pausedForAudit=r.status==='paused';
    await writeFile(directory+'/export-A.json',JSON.stringify({schemaVersion:1,installationId:'office-A',tasks:[{id:7,title:'Pagar fornecedor',done:false}]}));
    await writeFile(directory+'/export-B.json',JSON.stringify({schemaVersion:1,installationId:'home-B',tasks:[{id:7,title:'Consulta dentista',done:true}]}));
    phase=2;
    const drainDeadline=Date.now()+90000;while((r.pause?.draining||cx.jobs.has(r.id)||cx.pauseDrains.has(r.id)||[partner,'antigravity'].some(role=>['running','starting','waiting'].includes(cx.native(r,role).status)))&&Date.now()<drainDeadline)await sleep(100);
    await cx.resume(r.id,{requestId:'audit-new-evidence',text:'Auditoria com novas provas, preservando a mesma tarefa e sessões: leiam '+directory+'/export-A.json e '+directory+'/export-B.json. São exportações v1 reais do cenário simulado, de instalações distintas. Verifiquem se o pressuposto de identidade do contrato legado resiste e se a primeira candidata perde tarefas. Se encontrarem contradição, registem uma objection concreta ao colega citando ficheiro/campos/valores e a perda, antes de corrigirem o plano. Não simulem desacordo se a candidata já tratar isto. Primeira candidata:\n'+r.candidates[0].text+'\nRevejam com as provas e aprovem apenas a versão correta; incluam verificação que preserve ambas as tarefas e reimportação idempotente.'});
   }
   if(hub.snapshot().approvals.length)throw Error('Decisão nativa pendente; o ensaio não aprova ações automaticamente.');
   await sleep(100);
  }
  if(cx.active(r))await cx.pause(r.id);
  const nativeAfter=Object.fromEntries([partner,'antigravity'].map(role=>[role,{conversationId:cx.native(r,role).id,threadId:cx.native(r,role).threadId}]));
  const sameNative=JSON.stringify(nativeBefore)===JSON.stringify(nativeAfter),oldTokensRevoked=Boolean(oldTokens?.length)&&oldTokens.every(token=>!cx.leases.has(token));
  const objections=r.messages.filter(m=>m.type==='objection'&&[partner,'antigravity'].includes(m.from));
  const groundedObjection=objections.some(m=>/7|office-A|home-B|export-[AB]/.test(m.text)&&/colis|ident|perd|sobrescre|global/i.test(m.text));
  const evidence={directory,taskId:r.id,selected,resolvedAntigravity:{id:agyModel.id,name:agyModel.name},experiment:'controlled changing-evidence review; synthetic fixture exports, not production data or blind benchmark',bothRunning,receivedDuringBoth,pausedForAudit,sameNative,oldTokensRevoked,leaseFilesBefore,nativeBefore,nativeAfter,status:r.status,error:r.error,turns:Object.fromEntries([partner,'antigravity'].map(role=>[role,r.members[role].turns])),messageCount:r.messages.length,candidateCount:r.candidates.length,groundedObjection,objections,final:r.result?.text,hash:r.result?.hash,agreed:r.result?.agreed,approvals:r.result?.approvals,candidates:r.candidates.map(c=>({id:c.id,hash:c.hash,version:c.version,text:c.text})),events};
  await writeFile(directory+'/evidence.json',JSON.stringify(evidence,null,2));await writeFile(directory+'/detail.json',JSON.stringify(cx.detail(r.id),null,2));
  console.log(JSON.stringify({directory,selected,status:r.status,turns:evidence.turns,messageCount:evidence.messageCount,candidateCount:evidence.candidateCount,groundedObjection,pausedForAudit,sameNative,oldTokensRevoked,agreed:r.result?.agreed,hash:r.result?.hash,approvers:Object.keys(r.result?.approvals||{})}));
  if(r.status!=='completed'||!r.result?.agreed||!sameNative||!pausedForAudit||!oldTokensRevoked||r.candidates.length<2||!groundedObjection)process.exitCode=1;
 }
}finally{if(server){server.closeStreams();await new Promise(resolve=>server.close(resolve));}await hub.close();}
