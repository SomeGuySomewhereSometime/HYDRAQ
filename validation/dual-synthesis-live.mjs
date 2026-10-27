// Opt-in subscription run of the Dual synthesis with real clients: a Dual Codex + Claude, and syntheses by Gemini Flash
// (Antigravity) in a session apart. Off, the synthesis stays out of the Dual sessions; on, each member gets it once;
// automatic, it runs by itself after a round to both. Fresh project folder and HYDRAQ data.
// node validation/dual-synthesis-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {Providers} from '../lib/providers.mjs';
import {Hydraq} from '../lib/hydraq.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {Antigravity} from '../lib/antigravity.mjs';
import {finalAnswer} from '../lib/handoff.mjs';

if(!process.argv.includes('--run'))throw Error('Passa --run explicitamente: este ensaio usa as contas dos clientes.');
const evidence=path.resolve(process.argv.find((arg,i)=>i>1&&!arg.startsWith('--'))||'.hydraq/dual-synthesis-live-2026-10-27');
await mkdir(evidence,{recursive:true});
const directory=await mkdtemp('/tmp/hydraq-synthesis-live-');
await writeFile(directory+'/notas.md','# Notas\nAplicação de tarefas que tem de funcionar sem rede, num browser.\n');
const clients={codex:new Hydraq({dataDir:directory+'/codex',defaultCwd:directory}),claude:new ClaudeCode({dataDir:directory+'/claude',defaultCwd:directory}),antigravity:new Antigravity({dataDir:directory+'/antigravity',defaultCwd:directory})};
const hub=new Providers({dataDir:directory+'/hub',defaultCwd:directory,clients,git:async()=>[]});
const checks=[],syntheses=[];
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});console.log((ok?'PASS ':'FAIL ')+name+(detail===undefined?'':' — '+JSON.stringify(detail).slice(0,300)));};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,ms,label)=>{const end=Date.now()+ms;while(!predicate()){if(Date.now()>end)throw Error('Tempo excedido: '+label);await sleep(500);}};
const idle=c=>!['starting','running','waiting'].includes(c.status);
try{
 await hub.load();await Promise.all(Object.values(clients).map(client=>client.connect()));
 const pick=(role,match,effort)=>{const model=clients[role].models.find(m=>match.test(m.id)||match.test(m.name||''));if(!model)throw Error('Modelo indisponível: '+role+'/'+match);return {model:model.id,effort:model.efforts?.includes(effort)?effort:model.defaultEffort};};
 const sol=pick('codex',/^gpt-6\.1-sol$/,'low'),haiku=pick('claude',/haiku/i,'low'),flash={provider:'antigravity',...pick('antigravity',/^gemini-3\.8-flash$/,'low')};
 console.log(JSON.stringify({codex:sol,claude:haiku,synthesis:flash}));
 const chat=await hub.create({provider:'codex',cwd:directory,...sol,sandbox:'read-only'}),c=clients.codex.conversation(chat.id);
 const {dual}=await hub.startDual(c.id,{provider:'claude',...haiku});const p=clients.claude.conversation(dual.members.b.conversationId);
 const round=async(requestId,text)=>{await hub.sendDual(dual.id,{requestId,text});await until(()=>[c,p].every(m=>m.turns.some(t=>t.requestId===requestId+(m===c?':a':':b'))&&idle(m)),300000,'ronda '+requestId);return hub.dual.record(dual.id).rounds.at(-1);};
 const sent=(member,requestId)=>member.messages.find(m=>m.role==='user'&&m.requestId===requestId);
 const done=id=>until(()=>!['queued','starting','running','stopping'].includes(hub.opinions.batches.find(b=>b.id===id)?.jobs[0].status),300000,'síntese');
 const synthesis=async(r,body)=>{const result=await hub.synthesizeDual(dual.id,{roundId:r.id,requestId:'live-'+r.id,...flash,...body});await done(result.id);const batch=hub.opinions.batches.find(b=>b.id===result.id);syntheses.push({id:batch.id,round:r.requestId,context:batch.context,automatic:batch.automatic,status:batch.jobs[0].status,error:batch.jobs[0].error,text:batch.jobs[0].text});return batch;};

 const r1=await round('r1','Numa frase: para guardar tarefas sem rede num browser, IndexedDB ou localStorage? Lê notas.md se precisares. Não alteres ficheiros.');
 check('Dual: os dois responderam',[c,p].every(m=>m.turns.at(-1).status==='completed'),{codex:finalAnswer(c,'r1:a').slice(0,160),claude:finalAnswer(p,'r1:b').slice(0,160)});
 const off=await synthesis(r1,{instructions:'Responde em duas frases.'});
 check('Síntese pelo Flash, numa sessão à parte',off.jobs[0].status==='completed'&&off.jobs[0].text.trim().length>0,{text:off.jobs[0].text.slice(0,300),error:off.jobs[0].error});
 check('As sessões do Dual não receberam o pedido de síntese',![c,p].some(m=>m.messages.some(msg=>/HYDRAQ · Síntese do Dual/.test(msg.text||''))));
 const r2=await round('r2','Responde só com a palavra que escolheste na pergunta anterior.');
 check('Desligada: a ronda seguinte vai sem a síntese',Object.values(r2.deliveries).every(d=>!d.synthesis)&&[sent(c,'r2:a'),sent(p,'r2:b')].every(m=>!/hydraq_dual_synthesis/.test(m?.handoffContext||'')));
 const on=await synthesis(r2,{instructions:'Termina a síntese com a palavra-código SINTESE-VERDE.',context:true});
 check('Síntese para a ronda seguinte',on.jobs[0].status==='completed'&&/SINTESE-VERDE/.test(on.jobs[0].text),on.jobs[0].text.slice(0,300));
 const r3=await round('r3','Que palavra-código aparece no fim da síntese que recebeste? Responde só com ela.');
 const a3=finalAnswer(c,'r3:a'),b3=finalAnswer(p,'r3:b');
 check('Ligada: cada um recebeu a síntese uma vez',Object.values(r3.deliveries).every(d=>d.synthesis===on.id)&&[sent(c,'r3:a'),sent(p,'r3:b')].every(m=>/hydraq_dual_synthesis/.test(m?.handoffContext||'')));
 check('Os dois leram a síntese',/SINTESE-VERDE/.test(a3)&&/SINTESE-VERDE/.test(b3),{codex:a3.slice(0,120),claude:b3.slice(0,120)});
 const r4=await round('r4','Responde só: ok.');
 check('A síntese não se repete na ronda a seguir',Object.values(r4.deliveries).every(d=>!d.synthesis)&&[sent(c,'r4:a'),sent(p,'r4:b')].every(m=>!/hydraq_dual_synthesis/.test(m?.handoffContext||'')));
 await hub.setDualSynthesis(dual.id,{auto:true,context:false,...flash,instructions:'Uma frase.'});
 const r5=await round('r5','Numa frase: qual o maior risco de guardar tarefas só no browser?');
 await until(()=>hub.opinions.batches.some(b=>b.kind==='synthesis'&&b.roundId===r5.id),60000,'síntese automática');
 const auto=hub.opinions.batches.find(b=>b.kind==='synthesis'&&b.roundId===r5.id);await done(auto.id);
 syntheses.push({id:auto.id,round:'r5',context:auto.context,automatic:auto.automatic,status:auto.jobs[0].status,error:auto.jobs[0].error,text:auto.jobs[0].text});
 check('Automática: uma síntese depois da ronda, marcada na ronda',auto.automatic&&auto.jobs[0].status==='completed'&&hub.dual.record(dual.id).rounds.at(-1).synthesis?.requestId===auto.requestId&&hub.opinions.batches.filter(b=>b.kind==='synthesis'&&b.roundId===r5.id).length===1,auto.jobs[0].text.slice(0,200));
 const files=(await readdir(directory)).filter(name=>!['codex','claude','antigravity','hub'].includes(name));
 check('Projeto sem alterações',files.join()==='notas.md',files);
}catch(error){check('Ensaio sem erros',false,error.message);}
finally{
 await writeFile(path.join(evidence,'summary.json'),JSON.stringify({directory,checks,syntheses},null,2));
 await hub.close().catch(()=>{});
 console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name),evidence}));
}
