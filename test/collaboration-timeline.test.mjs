import test from 'node:test';import assert from 'node:assert/strict';
import {collaborationTimeline} from '../lib/collaboration-timeline.mjs';
const at=n=>new Date(Date.UTC(2026,9,22,10,0,n)).toISOString();
const msg=(id,text,requestId,second,extra={})=>({id,role:'assistant',text,requestId,at:at(second),...extra});
function setup(){
 const s={createdAt:at(0),principal:{model:'sol'},executor:{model:'grok'},jobs:[{id:'j',requestId:'worker-j',instructions:'Implementar a soma',task:'implement',status:'completed',startedAt:at(2),completedAt:at(4),result:'Implementado',facts:{files:['a.mjs'],commands:[{command:'node --test'}]}}],reviews:[{id:'r',requestId:'review-r',conversationId:'review-c',model:'opus',status:'completed',startedAt:at(5),completedAt:at(6),result:'Revisão concluída'}]};
 const p={turns:[{id:'p1',requestId:'col-cycle',startedAt:at(0),status:'completed'},{id:'p2',requestId:'col-result-cycle-1',internal:'collaboration-result',startedAt:at(7),status:'completed'}],messages:[{id:'u',role:'user',requestId:'col-cycle',text:'Criar soma',at:at(0)},msg('p','Vou delegar','col-cycle',1),{id:'private',role:'user',internal:'collaboration-result',text:'PROMPT_INTERNO',requestId:'col-result-cycle-1',at:at(7)},msg('answer','Avaliei o trabalho','col-result-cycle-1',8,{internal:'collaboration-result'})]};
 const e={turns:[{id:'et',requestId:'worker-j',status:'completed'}],messages:[{role:'user',text:'PROMPT_EXECUTOR',requestId:'worker-j'},msg('ep','Estou a implementar','worker-j',2),msg('ef','Implementado','worker-j',4),msg('foreign','CONVERSA_ALHEIA','outro',3)]};
 const r={turns:[{id:'rt',requestId:'review-r',status:'completed'}],messages:[{role:'user',text:'PROMPT_REVISOR',requestId:'review-r'},msg('rf','Revisão concluída','review-r',6)]};
 return{s,p,e,r,read:id=>id==='review-c'?r:null};
}
test('chat ordena principal, progresso, relatório, revisão e avaliação sem prompts privados nem duplicados',()=>{
 const{s,p,e,read}=setup(),before=JSON.stringify({s,p,e}),t=collaborationTimeline(s,p,e,read);
 assert.deepEqual(t.entries.filter(e=>e.kind==='message').map(e=>e.text),['Criar soma','Vou delegar','Estou a implementar','Implementado','Revisão concluída','Avaliei o trabalho']);
 assert.deepEqual(t.entries.filter(e=>e.kind==='task').map(e=>e.role),['executor','reviewer']);assert.equal(t.omitted,0);
 assert.doesNotMatch(JSON.stringify(t),/PROMPT_INTERNO|PROMPT_EXECUTOR|PROMPT_REVISOR|CONVERSA_ALHEIA/);assert.equal(JSON.stringify({s,p,e}),before);
});
test('streaming atualiza a mesma entrada; parcial interrompido não aparece duplicado nem continua a escrever',()=>{
 const{s,p,e,read}=setup();s.jobs[0].status='running';s.jobs[0].result='';e.messages=e.messages.slice(0,2);e.messages[1].streaming=true;
 const a=collaborationTimeline(s,p,e,read).entries.find(m=>m.text==='Estou a implementar');assert.equal(a.streaming,true);
 e.messages[1].text+=' a soma';const b=collaborationTimeline(s,p,e,read).entries.find(m=>m.id===a.id);assert.equal(b.text,'Estou a implementar a soma');
 s.jobs[0].status='interrupted';s.jobs[0].partial=b.text;s.jobs[0].error='Pedido parado';const t=collaborationTimeline(s,p,e,read);assert.equal(t.entries.filter(m=>m.text===b.text).length,1);assert.equal(t.entries.find(m=>m.id===a.id).streaming,false);assert.ok(t.entries.some(m=>m.kind==='error'&&m.text==='Pedido parado'));
});
test('revisões anteriores usam a sessão respetiva e não a última sessão de outro parecer',()=>{
 const{s,p,e,r}=setup();s.reviews.push({id:'r2',requestId:'review-r2',conversationId:'review-other',model:'sonnet',status:'running',startedAt:at(9)});
 const other={turns:[{id:'r2',requestId:'review-r2'}],messages:[msg('r2m','Segunda revisão em curso','review-r2',10,{streaming:true}),msg('leak','NÃO_PUBLICAR','review-r',10)]};
 const t=collaborationTimeline(s,p,e,id=>id==='review-c'?r:other);assert.equal(t.entries.filter(m=>m.text==='Revisão concluída').length,1);assert.ok(t.entries.some(m=>m.text==='Segunda revisão em curso'&&m.streaming));assert.doesNotMatch(JSON.stringify(t),/NÃO_PUBLICAR/);
});
test('histórico antigo ou falha sem turno conserva relatório, erro e proveniência',()=>{
 const{s,p}=setup();s.jobs[0].status='failed';s.jobs[0].error='Cliente indisponível';const t=collaborationTimeline(s,p,null,()=>null);
 assert.ok(t.entries.some(m=>m.role==='executor'&&m.text==='Implementado'));assert.ok(t.entries.some(m=>m.kind==='error'&&m.text==='Cliente indisponível'));assert.ok(t.entries.some(m=>m.role==='reviewer'&&m.text==='Revisão concluída'));
});
test('parcial composto por vários blocos não repete todos os blocos no fim',()=>{
 const{s,p,e,read}=setup();s.jobs[0].result='';s.jobs[0].status='uncertain';s.jobs[0].partial='Estou a implementar\n\nImplementado';
 const t=collaborationTimeline(s,p,e,read);assert.equal(t.entries.filter(m=>m.role==='executor'&&m.kind==='message').length,2);
});
test('timestamps iguais respeitam a ordem principal, executor, revisor e avaliação',()=>{
 const{s,p,e,r,read}=setup();for(const t of p.turns)t.startedAt=at(0);for(const j of [...s.jobs,...s.reviews])j.startedAt=at(0);
 for(const c of [p,e,r])for(const m of c.messages)m.at=at(0);
 assert.deepEqual(collaborationTimeline(s,p,e,read).entries.filter(m=>m.kind==='message').map(m=>m.role),['user','principal','executor','executor','reviewer','principal']);
});
test('vista limitada sinaliza omissões e truncagem e filtra segredos sem alterar os originais',()=>{
 const{s}=setup();s.jobs=[];s.reviews=[];
 const p={turns:[],messages:Array.from({length:180},(_,i)=>msg('id-'+i,i===179?'TOKEN=segredo123456 '+ 'x'.repeat(61000):'Mensagem '+i,'q',i))};
 const t=collaborationTimeline(s,p,null,()=>null);assert.equal(t.entries.length,160);assert.equal(t.omitted,20);assert.equal(t.entries.at(-1).truncated,true);assert.doesNotMatch(t.entries.at(-1).text,/segredo123456/);assert.match(p.messages.at(-1).text,/segredo123456/);
});
test('relatório guardado abreviado não duplica uma mensagem nativa longa',()=>{
 const{s,p,e,read}=setup();const text='Relatório\n'+ 'x'.repeat(70000);e.messages=[msg('long',text,'worker-j',4)];s.jobs[0].result=text.slice(0,60000);s.jobs[0].resultTruncated=true;
 const entries=collaborationTimeline(s,p,e,read).entries.filter(m=>m.role==='executor'&&m.kind==='message');assert.equal(entries.length,1);assert.equal(entries[0].truncated,true);
});
