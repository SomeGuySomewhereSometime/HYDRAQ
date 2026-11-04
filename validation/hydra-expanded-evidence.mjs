// Read-only recheck of a completed real trial. Does not invoke models or amend the original trial summary.
import {readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {inspectImage} from '../lib/attachments.mjs';
const out=path.resolve(process.argv[2]),r=JSON.parse(await readFile(out+'/detail.json','utf8')),summary=JSON.parse(await readFile(out+'/summary.json','utf8')),checks=[];
const check=(name,ok)=>checks.push({name,ok:Boolean(ok)}),w=r.workflow,roles=r.roles;
check('tarefa concluída e projeto aplicado',r.status==='completed'&&r.workspace.applied);
check('Codex e Claude executaram as duas etapas iniciais',w.completedSteps.slice(0,2).map(s=>s.role).join(',')==='codex,claude');
check('etapas adicionais são correções de executores autorizados',w.completedSteps.every(s=>r.writers.includes(s.role))&&w.completedSteps.filter(s=>s.phase==='fixing').every(s=>s.role===w.approvedPlan.implementation.fixer));
check('pastas independentes e resultado aplicado retirado da cópia',r.workspace.stages.length>=3&&r.workspace.removed);
check('projeto só mudou na aplicação final',summary.checks.find(c=>c.name==='projeto só mudou na aplicação final')?.ok);
check('soma corrigida',/a\s*\+\s*b/.test(await readFile(r.cwd+'/sum.mjs','utf8')));check('interface aplicada',(await readFile(r.cwd+'/index.html','utf8')).includes('Hydra por etapas'));
check('todos testaram e receberam o mosaico da última ronda',roles.every(role=>w.tests.some(t=>t.role===role&&t.round===w.round&&t.status==='passed'&&t.visual&&t.artifacts.some(a=>a.name==='mosaico.png'&&t.imagesDelivered?.[role]?.includes(a.id)))));
check('revisão visual declarada por todos na última ronda',roles.every(role=>w.reviews[role]?.visualReview?.status==='reviewed'));
check('ficheiros Blender exportados',await access(r.cwd+'/cube.glb').then(()=>true,()=>false)&&await access(r.cwd+'/render.png').then(()=>true,()=>false));
const glb=await readFile(r.cwd+'/cube.glb'),scene=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString());check('GLB contém apenas a cena criada para o ensaio',glb.toString('ascii',0,4)==='glTF'&&scene.scenes.length===1&&scene.scenes[0].name==='HYDRAQ_ensaio');
check('render é uma imagem válida',inspectImage(await readFile(r.cwd+'/render.png')).width>0);
check('MCP reservado ao principal e limitações na conclusão',r.externalCalls.length>0&&r.externalCalls.every(c=>c.role===r.author)&&r.result.text.includes('fora do isolamento'));
const result={source:'detail.json e ficheiros finais; summary.json original conservado',note:'A asserção original slice(-2) rejeitava uma correção adicional legítima; verificam-se as etapas iniciais e as correções separadamente.',checks};await writeFile(out+'/rechecked.json',JSON.stringify(result,null,2));console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).map(c=>c.name)}));if(checks.some(c=>!c.ok))process.exitCode=1;
