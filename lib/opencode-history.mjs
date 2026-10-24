import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {observeAction} from './turn-facts.mjs';

const active=new Set(['starting','running','waiting','uncertain']);
const iso=t=>new Date(t).toISOString();
const text=m=>(m.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
const types=new Set(['agent-switched','model-switched','location-switched','user','synthetic','system','skill','shell','assistant','compaction','idle']);

/** Validate the entire native snapshot before changing the visible history. A failed page is never an empty history. */
export function reconcileOpenCode(conversation,messages,{publicText=value=>value}={}) {
  for(const m of messages){
    if(!types.has(m.type)||!Number.isFinite(m.time?.created)||!Number.isFinite(new Date(m.time.created).getTime())||
      m.type==='user'&&typeof m.text!=='string'||
      m.type==='assistant'&&(!Array.isArray(m.content)||m.content.some(p=>!['text','reasoning','tool'].includes(p.type)||(p.type==='text'||p.type==='reasoning')&&typeof p.text!=='string'||p.type==='tool'&&(!p.id||!p.name||!p.state)))||
      m.type==='idle'&&!['succeeded','failed','interrupted'].includes(m.outcome))throw Error('Histórico OpenCode incompleto ou com formato não suportado.');
  }
  const c=structuredClone(conversation);
  // ACP and HTTP share the private database. Migrate only uniquely identifiable inputs, preserving local annotations.
  if(!c.nativeHistory?.initialized&&c.turns.some(t=>!t.nativeInputId)){
    const used=new Set();
    for(const turn of c.turns.filter(t=>!t.nativeInputId)){
      const user=c.messages.find(m=>m.turnId===turn.id&&m.role==='user'&&m.kind!=='steer');
      const candidates=messages.filter(m=>m.type==='user'&&!used.has(m.id)&&(m.text===user?.text||m.text.endsWith('\n\n'+user?.text)));
      if(candidates.length!==1){if(['failed','interrupted'].includes(turn.status)&&turn.delivery==='preparing')continue;throw Error('Não foi possível associar sem ambiguidade o histórico ACP à sessão nativa. O histórico local foi preservado; nada foi enviado.');}
      const native=candidates[0];used.add(native.id);turn.nativeInputId=native.id;user.nativeId=native.id;
      const index=messages.indexOf(native),end=messages.findIndex((m,i)=>i>index&&m.type==='user');
      const segment=messages.slice(index+1,end<0?undefined:end),old=c.messages.filter(m=>m.turnId===turn.id&&m.role==='assistant');
      if(old.length&&old.map(m=>m.text).join('')!==segment.filter(m=>m.type==='assistant').map(text).join(''))throw Error('O histórico nativo anterior difere do histórico ACP. Ambos foram preservados; é necessária revisão antes de continuar.');
      c.messages=c.messages.filter(m=>m.turnId!==turn.id||m.role!=='assistant');
    }
  }
  let turn;
  const touched=new Set(),compactions=new Set(c.nativeHistory?.compactions||[]);
  for(const native of messages){
    if(native.type==='user'){
      let user=c.messages.find(m=>m.nativeId===native.id||m.nativeInputId===native.id);
      turn=c.turns.find(t=>t.nativeInputId===native.id)||(user&&c.turns.find(t=>t.id===user.turnId));
      if(!turn){
        const source=c.terminal?'terminal':'native';
        turn={id:randomUUID(),nativeInputId:native.id,requestId:'opencode:'+native.id,startedAt:iso(native.time.created),status:'running',delivery:'accepted',interactions:[],source,model:c.model,effort:c.effort,sandbox:c.sandbox};c.turns.push(turn);
      }
      if(!user){user={id:'opencode:'+native.id,nativeId:native.id,role:'user',text:native.text,at:iso(native.time.created),turnId:turn.id,requestId:turn.requestId,source:turn.source,model:turn.model,effort:turn.effort};c.messages.push(user);}
      user.nativeId=native.id;
      if(user.kind==='steer')user.delivery='accepted';
      touched.add(turn.id);
      continue;
    }
    if(native.type==='compaction'&&!compactions.has(native.id)){compactions.add(native.id);c.contextEpoch=(c.contextEpoch||0)+1;}
    if(!turn)continue;
    if(native.type==='assistant'){
      if(turn.source&&native.model){turn.model=native.model.providerID+'/'+native.model.id;turn.effort=native.model.variant||'default';}
      let message=c.messages.find(m=>m.nativeId===native.id);
      const body=publicText(text(native),Number.isFinite(native.time.completed));
      if(body){
        if(!message){message={id:'opencode:'+native.id,nativeId:native.id,role:'assistant',turnId:turn.id,requestId:turn.requestId,at:iso(native.time.created),...(turn.internal?{internal:turn.internal}:{}),source:turn.source};c.messages.push(message);}
        Object.assign(message,{text:body,model:native.model?`${native.model.providerID}/${native.model.id}`:turn.model,effort:native.model?.variant||'default',streaming:!native.time.completed,phase:'commentary'});
      }
      for(const [index,part] of native.content.entries()){
        if(part.type==='text')continue;
        const id='opencode:'+native.id+':'+(part.id||index);
        let item=c.items.find(i=>i.id===id);
        if(!item){item={id,nativeId:part.id||id,turnId:turn.id,at:iso(native.time.created)};c.items.push(item);}
        if(part.type==='reasoning'){Object.assign(item,{type:'reasoning',summary:publicText(part.text,Number.isFinite(native.time.completed)),status:native.time.completed?'completed':'inProgress'});continue;}
        const state=part.state,input=state.input||{},output=(state.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
        Object.assign(item,{type:'mcpToolCall',server:'OpenCode',tool:part.name,parameters:input,aggregatedOutput:publicText(output,['completed','error'].includes(state.status)),status:state.status==='completed'?'completed':state.status==='error'?'failed':'inProgress'});
        if(part.name==='execute'&&Array.isArray(state.metadata?.toolCalls)){
          item.nativeTools=state.metadata.toolCalls.map(t=>({tool:t.tool,status:t.status}));
          if(item.nativeTools.length)item.tool=item.nativeTools.map(t=>t.tool).join(', ');
          if(state.metadata.error){item.status='failed';item.error='A execução de ferramentas terminou com erro.';}
        }
        if(['bash','shell'].includes(part.name)){item.type='commandExecution';item.command=input.command||input.description||part.name;}
        if(['write','edit','patch','apply_patch','multiedit'].includes(part.name)){
          item.type='fileChange';item.changes=[...new Set([input.path,input.filePath,input.file_path,...(native.snapshot?.files||[])].filter(p=>typeof p==='string'&&p))].map(p=>({path:path.resolve(c.cwd,p),diff:''}));
        }
        if(state.error){item.error=state.error.message;item.permissionDenied=/permission.*reject|denied/i.test(state.error.type+' '+state.error.message);if(item.permissionDenied)item.status='declined';}
        if(Number.isInteger(state.metadata?.exit))item.exitCode=state.metadata.exit;
        observeAction(c,turn,item);
      }
      if(native.time.completed&&Array.isArray(native.snapshot?.files)&&native.snapshot.files.length){
        const id='opencode:'+native.id+':snapshot-files';let item=c.items.find(i=>i.id===id);
        if(!item){item={id,turnId:turn.id,type:'fileChange',status:'completed',at:iso(native.time.completed)};c.items.push(item);}
        item.changes=native.snapshot.files.filter(p=>typeof p==='string'&&p).map(p=>({path:path.resolve(c.cwd,p),diff:''}));observeAction(c,turn,item);
      }
    }
    if(native.type==='idle'){
      turn.status=({succeeded:'completed',failed:'failed',interrupted:'interrupted'})[native.outcome];turn.completedAt=iso(native.time.created);turn.delivery='confirmed';turn.error=native.error?.message||null;
    }
  }
  for(const id of touched){
    const t=c.turns.find(t=>t.id===id),answers=c.messages.filter(m=>m.turnId===id&&m.role==='assistant');
    const start=messages.findIndex(m=>m.id===t.nativeInputId),end=messages.findIndex((m,i)=>i>start&&m.type==='user'&&!c.messages.some(x=>x.kind==='steer'&&x.nativeId===m.id));
    const assistants=messages.slice(start+1,end<0?undefined:end).filter(m=>m.type==='assistant');
    const usage=assistants.map(m=>m.tokens).filter(Boolean);
    if(usage.length&&usage.every(u=>[u.input,u.output,u.reasoning,u.cache?.read,u.cache?.write].every(n=>Number.isFinite(n)&&n>=0)))t.usage={inputTokens:usage.reduce((n,u)=>n+u.input,0),outputTokens:usage.reduce((n,u)=>n+u.output,0),reasoningOutputTokens:usage.reduce((n,u)=>n+u.reasoning,0),cachedInputTokens:usage.reduce((n,u)=>n+u.cache.read,0),cacheWriteInputTokens:usage.reduce((n,u)=>n+u.cache.write,0)};
    if(assistants.length&&assistants.every(m=>typeof m.cost==='number'&&m.cost>=0))t.costUSD=assistants.reduce((n,m)=>n+m.cost,0);
    if(!active.has(t.status)){
      for(const m of answers)m.streaming=false;
      if(t.status==='completed'){t.finalAnswer=answers.map(m=>m.text).join('\n\n');if(answers.at(-1))answers.at(-1).phase='final_answer';}
    }
  }
  const last=c.turns.at(-1);
  // Native projections may briefly expose idle before the final assistant update. Confirm a stable
  // snapshot on a later read before releasing the turn and allowing queues/reviews to start.
  const signature=createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  let settling=false;
  if(last&&touched.has(last.id)&&!active.has(last.status)&&
    (!conversation.turns.some(t=>t.id===last.id)||active.has(conversation.turns.find(t=>t.id===last.id)?.status)||c.nativePendingCompletion)){
    const previous=c.nativePendingCompletion;
    const hasAnswer=c.messages.some(m=>m.turnId===last.id&&m.role==='assistant'&&m.text.trim());
    const finalAssistants=messages.slice(messages.findIndex(m=>m.id===last.nativeInputId)+1).filter(m=>m.type==='assistant');
    const unfinished=last.status==='completed'&&finalAssistants.some(m=>!Number.isFinite(m.time.completed));
    const waitMs=last.status==='completed'&&!hasAnswer?5000:200;
    if(!previous||previous.signature!==signature||Date.now()-previous.observedAt<waitMs||unfinished){
      c.nativePendingCompletion={signature,observedAt:previous?.signature===signature?previous.observedAt:Date.now()};
      last.status='running';last.delivery='accepted';last.completedAt=null;settling=true;
    }else delete c.nativePendingCompletion;
  }
  if(last?.status==='completed'&&!c.messages.some(m=>m.turnId===last.id&&m.role==='assistant'&&m.text.trim())&&!c.items.some(i=>i.turnId===last.id&&i.status==='completed'&&i.type!=='reasoning')){
    last.status='failed';last.error='O OpenCode terminou sem uma resposta.';
  }
  if(last&&touched.has(last.id)){c.status=last.status;c.turnId=active.has(last.status)?last.id:null;c.error=last.error||null;}
  c.nativeHistory={initialized:true,status:'complete',empty:messages.length===0,count:messages.length,checkedAt:new Date().toISOString(),compactions:[...compactions],settling};
  if(messages.length)c.updatedAt=iso(messages.at(-1).time.created);
  // Consumers and in-flight admissions keep references to turns/messages/interactions. Commit the
  // validated draft in place so a simultaneous receipt or permission reply updates the saved object.
  const retain=(before,after)=>{const prior=new Map(before.map(v=>[v.id,v]));return after.map(value=>{const old=prior.get(value.id);if(!old)return value;if(old.interactions&&value.interactions)value.interactions=retain(old.interactions,value.interactions);for(const key of Object.keys(old))if(!Object.hasOwn(value,key))delete old[key];return Object.assign(old,value);});};
  for(const key of ['messages','items','turns'])c[key]=retain(conversation[key],c[key]);
  for(const key of Object.keys(conversation))if(!Object.hasOwn(c,key))delete conversation[key];
  Object.assign(conversation,c);
  return conversation;
}
