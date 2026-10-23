import {elicitationForm} from './elicitation.js';
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity',opencode:'OpenCode · gratuitos',cursor:'Cursor'};
const statuses={queued:'Em fila',starting:'A preparar',running:'A responder',stopping:'A parar',completed:'Concluído',failed:'Falhou',uncertain:'Resultado incerto',interrupted:'Interrompido'};
const effortLabels={none:'Sem raciocínio',minimal:'Mínimo',low:'Leve',medium:'Médio',high:'Alto',xhigh:'Muito alto',max:'Máximo',ultra:'Ultra'};
const active=j=>['queued','starting','running','stopping'].includes(j.status);
const reviewModes={comment:'Comentar resposta',plan:'Criticar plano',implementation:'Rever implementação'};
const cycleStates={'waiting-main':'Resposta inicial em curso',preparing:'Resposta inicial pronta · a consultar revisores',reviewing:'Revisores a analisar',delivering:'Pareceres prontos · a enviar ao principal',assessing:'Principal a preparar resposta final',completed:'Revisão concluída',skipped:'Revisão dispensada',failed:'Revisão falhou',suspended:'Revisão suspensa',cancelled:'Revisão parada','needs-decision':'Decisão de envio pendente'};
const shortNames={codex:'Codex',claude:'Claude',antigravity:'Antigravity',opencode:'OpenCode',cursor:'Cursor'};
const glyphPaths={
 opinion:['M3.5 6A2.5 2.5 0 0 1 6 3.5h7A2.5 2.5 0 0 1 15.5 6v4a2.5 2.5 0 0 1-2.5 2.5H8.5L5 15.5v-3.1A2.5 2.5 0 0 1 3.5 10z','M18.5 8.5h.5a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2v3l-3.5-3H12a2 2 0 0 1-2-2v-.5'],
 alternative:['M12 21v-7','M12 14 6.5 7.5','M12 14l5.5-6.5','M6 11.5V7h4.5','M18 11.5V7h-4.5'],
 close:['M6 6l12 12','M18 6 6 18'],
};
// Inline SVG built through the DOM, so the CSP needs no exceptions.
const glyph=(name,cls='opinion-glyph')=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:cls}))svg.setAttribute(k,v);for(const d of glyphPaths[name]){const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);}return svg;};
export const opinionMessageKey=(message,index)=>message.id||`${message.requestId||message.turnId||'legacy'}:${message.role}:${index}`;
// Presentation only: keep independent alternatives after the original reply.
export function opinionResultAnchors(timeline){
 const requests=new Map(),turns=new Map(),fallback=[];let last=-1;
 const id=(owner,value)=>JSON.stringify([owner.id,value]);
 for(let i=timeline.length-1;i>=0;i--){const {owner,message:m}=timeline[i];if(m.internal)continue;
  if(m.role==='assistant'){
   if(m.requestId&&!requests.has(id(owner,m.requestId)))requests.set(id(owner,m.requestId),i);
   if(m.turnId&&!turns.has(id(owner,m.turnId)))turns.set(id(owner,m.turnId),i);
   if(last<0)last=i;
  }else if(m.role==='user'){fallback[i]=last<0?i:last;if(m.kind!=='steer')last=-1;}
 }
 return timeline.map(({owner,message:m},i)=>{if(m.role!=='user'||m.internal)return i;const match=(m.requestId?requests.get(id(owner,m.requestId)):undefined)??(m.turnId?turns.get(id(owner,m.turnId)):undefined);return match>i?match:(fallback[i]??i);});
}
// A projection of public review records only; native histories and delivery stay untouched.
export function opinionTranscriptGroups(timeline, state = {}) {
 state ||= {};
 const groups = new Map(), batches = state.batches || [], cycles = state.automatic?.cycles || [], merges = state.merges || [];
 const eligible = cycle => cycle && automaticReturnMode(cycle.config)!=='manual' && cycle.status!=='skipped';
 const sameTurn = (a,b) => a.requestId && b.requestId ? a.requestId === b.requestId : Boolean(a.turnId && a.turnId === b.turnId);
 const add = (ownerId, source, batch, cycle) => {
  const at = timeline.findIndex(({owner,message},i) => owner.id === ownerId && message.role === 'assistant' && !message.internal && (source ? opinionMessageKey(message,owner.messages?.indexOf(message) ?? i) === source : message.requestId === cycle.requestId));
  const anchor = at >= 0 ? at : cycle?.status==='waiting-main' ? timeline.findIndex(({owner,message})=>owner.id===ownerId&&message.role==='user'&&!message.internal&&message.requestId===cycle.requestId) : -1;
  if (anchor < 0) return;
  const original = at<0?[]:timeline.map(({owner,message},i) => owner.id === ownerId && message.role === 'assistant' && !message.internal && (i === at || sameTurn(message,timeline[at].message)) ? i : -1).filter(i=>i>=0);
  const id = JSON.stringify([ownerId,timeline[anchor].message.requestId || timeline[anchor].message.turnId || source || anchor]);
  if (!groups.has(id)) groups.set(id,{id,ownerId,anchor,original,batchIds:[],cycleIds:[],deliveries:[],finals:[],questions:[]});
  const group=groups.get(id);
  if(batch&&!group.batchIds.includes(batch.id))group.batchIds.push(batch.id);
  if(cycle&&!group.cycleIds.includes(cycle.id))group.cycleIds.push(cycle.id);
 };
 for(const batch of batches){const cycle=cycles.find(c=>c.id===batch.automaticCycleId);if(!eligible(cycle))continue;const source=timeline.find(({owner,message},i)=>owner.id===batch.conversationId&&opinionMessageKey(message,owner.messages?.indexOf(message)??i)===batch.sourceKey);if(source?.message.role==='assistant')add(batch.conversationId,batch.sourceKey,batch,cycle);}
 for(const cycle of cycles)if(cycle.requestId&&eligible(cycle))add(cycle.conversationId,null,null,cycle);
 for(const group of groups.values()){
  const ownBatches=batches.filter(b=>group.batchIds.includes(b.id)), ownCycles=cycles.filter(c=>group.cycleIds.includes(c.id));
  const jobIds=new Set(ownBatches.flatMap(b=>b.jobs.map(j=>j.id)));
  const returns=new Set([...ownCycles.map(c=>c.returnRequestId),...merges.filter(m=>m.conversationId===group.ownerId&&m.jobIds?.some(id=>jobIds.has(id))).map(m=>m.requestId)].filter(Boolean));
  timeline.forEach(({owner,message},i)=>{if(owner.id!==group.ownerId||message.internal)return;if(message.role==='user'&&sameTurn(message,timeline[group.anchor].message))group.questions.push(i);if(returns.has(message.requestId)){if(message.role==='user')group.deliveries.push(i);else if(message.role==='assistant')group.finals.push(i);}});
 }
 return [...groups.values()].sort((a,b)=>a.anchor-b.anchor);
}
export const automaticParticipants = config => config?.participants || (config?.participant ? [config.participant] : []);
export const automaticReturnMode = config => config?.returnMode ?? (config?.returnToPrincipal === false ? 'manual' : 'always');
export function reviewProgress(cycle, jobs = []) {
 const done=jobs.filter(j=>j.status==='completed'&&j.text?.trim()).length;
 const failed=jobs.filter(j=>['failed','uncertain','interrupted'].includes(j.status)).length;
 const pending=jobs.filter(j=>j.approvals?.length).length;
 const count=jobs.length?`${done}/${jobs.length} pareceres prontos${failed?` · ${failed} sem parecer`:''}`:'';
 const phase=cycle?.status==='waiting-main'?'Resposta inicial a ser escrita':cycle?.status==='preparing'?'Resposta inicial pronta · a consultar revisores':cycle?.status==='reviewing'?(pending?'Aguarda a tua decisão':'Revisores a analisar'):cycleStates[cycle?.status]||'Consulta concluída';
 return [phase,count].filter(Boolean).join(' · ');
}
export function opinionContextLabel(job, delivery) {
 if (delivery.state !== 'separate') return delivery.label;
 const recommendation = job.recommendation;
 if (recommendation?.status === 'pending') return 'Separado · decisão de envio pendente';
 if (recommendation?.status === 'decided') return recommendation.sendToPrincipal ? 'Separado · revisor recomenda enviar' : 'Separado · revisor não recomendou enviar';
 return delivery.label;
}
export function opinionDelivery(jobId, merges = []) {
 const deliveries = merges.filter(merge => merge.jobIds?.includes(jobId));
 if (deliveries.some(merge => merge.status === 'submitted')) return {state:'submitted', label:'Enviado ao principal'};
 if (deliveries.some(merge => merge.status === 'uncertain')) return {state:'uncertain', label:'Entrega incerta · não reenviado'};
 if (deliveries.some(merge => merge.status === 'sending')) return {state:'sending', label:'A enviar ao principal'};
 if (deliveries.some(merge => merge.status === 'failed')) return {state:'separate', label:'Envio falhou · separado do contexto principal'};
 return {state:'separate', label:'Separado · ainda não enviado ao principal'};
}
export class OpinionUI{
 constructor({getState,api,getTarget,getSettings,getKey,refresh,toast,markdown}){Object.assign(this,{getState,api,getTarget,getSettings,getKey,refresh,toast,markdown});this.refreshState=refresh;delete this.refresh;this.selected=new Set();this.deliveryFilters=new Map();this.slots=new Set();this.submissions=new Map();this.quickDrafts=new Map();this.automaticDrafts=new Map();this.archived=new Map();this.archiveRevision=0;this.sequence=0;this.dialog=node('dialog','opinion-dialog');this.dialog.setAttribute('aria-label','Consultar outros modelos');document.body.append(this.dialog);
  this.folds=new Map();this.reviewGroups=new Set();this.seenApprovals=new Set();
  this.quick=node('section','opinion-quick');this.quick.id='opinion-quick';this.quick.hidden=true;this.quick.setAttribute('role','dialog');this.quick.setAttribute('aria-modal','false');this.quick.setAttribute('aria-label','Escolha rápida de modelos');document.body.append(this.quick);
  this.quick.addEventListener('pointerenter',()=>clearTimeout(this.hoverClose));this.quick.addEventListener('pointerleave',()=>this.scheduleClose());
  document.getElementById('review-toggle')?.addEventListener('click',()=>this.configureAutomatic());
  document.addEventListener('pointerdown',event=>{if(!this.quick.hidden&&!this.quick.contains(event.target)&&!this.quickAnchor?.contains(event.target))this.closeQuick();});
  document.addEventListener('focusin',event=>{if(!this.quick.hidden&&!this.quick.contains(event.target)&&!this.quickAnchor?.contains(event.target))this.closeQuick();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!this.quick.hidden){event.preventDefault();event.stopPropagation();this.closeQuick(true);}});
  window.addEventListener('resize',()=>this.positionQuick());document.addEventListener('scroll',event=>{if(!this.quick.contains(event.target))this.positionQuick();},true);
  this.quickObserver=new ResizeObserver(()=>this.positionQuick());this.quickObserver.observe(this.quick);
 }
 button(text,fn,cls='secondary-button'){const b=node('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;}
 fold(id,cls,label,open=false){const details=node('details',cls),summary=node('summary','',label);details.dataset.foldId=id;details.open=this.folds.get(id)??open;let previous=details.open;details.append(summary);details.addEventListener('toggle',()=>{if(details.open===previous)return;previous=details.open;if(details.isConnected)this.folds.set(id,details.open);});return details;}
 openAncestors(element){for(let parent=element;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'){parent.open=true;if(parent.dataset.foldId)this.folds.set(parent.dataset.foldId,true);}}
 foldMessage(article,owner,message){
  const header=article.querySelector(':scope > .message-header');if(!header)return;
  const key='message:'+owner.id+':'+opinionMessageKey(message,owner.messages.indexOf(message)),body=node('div','message-body');
  body.id='message-body-'+(++this.sequence);while(header.nextSibling)body.append(header.nextSibling);article.append(body);
  const button=this.button('',()=>{this.folds.set(key,body.hidden);sync();},'message-fold-toggle');
  const sync=()=>{body.hidden=!(this.folds.get(key)??true);article.classList.toggle('message-folded',body.hidden);button.textContent=body.hidden?'Expandir':'Recolher';button.setAttribute('aria-expanded',String(!body.hidden));button.dataset.tip=body.hidden?'Mostrar esta mensagem completa':'Recolher o texto desta mensagem';};
  button.setAttribute('aria-controls',body.id);header.append(button);sync();
 }
 submission(message,owner){if(message.role!=='user')return null;const state=this.viewState();return state?.merges.find(m=>m.requestId===message.requestId&&m.conversationId===owner.id)||state?.automatic?.cycles.find(c=>c.returnRequestId===message.requestId&&c.conversationId===owner.id);}
 organizeTranscript(view,timeline){
  for(const slot of this.slots)if(!slot.isConnected)this.slots.delete(slot);
  for(const details of this.reviewGroups)if(!details.isConnected)this.reviewGroups.delete(details);
  const state=this.viewState(),groups=opinionTranscriptGroups(timeline,state),articles=new Map([...view.querySelectorAll(':scope > [data-timeline-index]')].map(e=>[Number(e.dataset.timelineIndex),e]));
  for(const group of groups){
   const first=articles.get(group.anchor);if(!first)continue;
   const cycle=(state?.automatic?.cycles||[]).find(c=>group.cycleIds.includes(c.id));
   const writing=cycle?.status==='waiting-main';
   const details=this.fold('process:'+group.id,'review-process','Resposta inicial e revisão',!group.finals.length),body=node('div','review-process-body');details.dataset.reviewGroup=group.id;details.reviewGroup=group;details.append(body);group.original.length?first.before(details):first.after(details);
   const original=this.fold('original:'+group.id,'review-original',`Resposta inicial · ${names[timeline[group.anchor].owner.provider]} · ${writing?'a responder':'pronta para consultar'}`,writing);body.append(original);
   for(const at of group.original){const article=articles.get(at);if(article){const message=timeline[at].message;article.prepend(node('p','review-message-phase',message.phase==='final_answer'||!writing&&at===group.original.at(-1)?'Resposta inicial':'Progresso da resposta inicial'));original.append(article);}}
   const source=timeline[group.anchor],turn=source.owner.turns?.find(t=>t.requestId===source.message.requestId||t.id===source.message.turnId),items=source.owner.items?.filter(i=>i.turnId===turn?.id).slice(-8)||[];
   if(items.length){const activity=this.fold('initial-activity:'+group.id,'review-activity','Raciocínio e atividade comunicados pelo cliente',writing);for(const item of items){activity.append(node('p','opinion-caption',`${item.type==='reasoning'?'A analisar o pedido':item.command||item.title||item.tool||item.type} · ${item.status||''}`));if(item.type==='reasoning'&&item.summary?.length)activity.append(node('p','opinion-caption',Array.isArray(item.summary)?item.summary.join('\n'):String(item.summary)));}original.append(activity);}
   const sourceIndices=new Set([...group.original,...group.questions]);
   for(const slot of this.slots)if(slot.isConnected&&sourceIndices.has(Number(slot.dataset.sourceIndex)))body.append(slot);
   for(const at of group.deliveries){const article=articles.get(at);if(article)body.append(article);}
   const sentIds=new Set((state?.merges||[]).filter(m=>group.deliveries.some(i=>timeline[i].message.requestId===m.requestId)).flatMap(m=>m.jobIds||[]));
   const reviewers=(state?.batches||[]).filter(b=>group.batchIds.includes(b.id)).flatMap(b=>b.jobs).filter(j=>sentIds.has(j.id));
   if(group.finals.length>1){const assessment=this.fold('assessment:'+group.id,'review-original','Etapas da avaliação do principal');for(const at of group.finals.slice(0,-1)){const article=articles.get(at);if(article)assessment.append(article);}body.append(assessment);}
   const finalAt=group.finals.at(-1),final=articles.get(finalAt);
   if(final){const {owner,message}=timeline[finalAt],turn=owner.turns?.find(t=>t.requestId===message.requestId||t.id===message.turnId),confirmed=turn?.status==='completed';final.classList.add('review-final');const label=node('div','review-final-label',confirmed?'Resposta final':message.streaming||['running','starting','waiting'].includes(turn?.status)?'A preparar resposta final':'Resposta da avaliação · parcial');if(confirmed)label.append(node('span','review-final-hint','· após os pareceres recebidos'));for(const provider of new Set(reviewers.map(j=>j.provider))){const badge=node('span','opinion-provider review-provider-badge',names[provider]);badge.dataset.provider=provider;badge.title='Parecer recebido deste cliente; a resposta indica quais as sugestões aceites.';label.append(badge);}final.prepend(label);}
   this.reviewGroups.add(details);this.updateGroup(details);
   if(body.querySelector('.opinion-approval'))this.openAncestors(body.querySelector('.opinion-approval'));
  }
 }
 updateGroup(details){const state=this.viewState(),group=details.reviewGroup,cycles=(state?.automatic?.cycles||[]).filter(c=>group.cycleIds.includes(c.id)),jobs=(state?.batches||[]).filter(b=>group.batchIds.includes(b.id)).flatMap(b=>b.jobs),cycle=cycles.at(-1);const pending=jobs.some(j=>j.approvals?.length);const summary=details.firstElementChild;summary.replaceChildren(node('span','review-process-title','Resposta inicial e revisão'),node('span','review-process-state',reviewProgress(cycle,jobs)));details.dataset.waiting=String(pending);details.dataset.failed=String(cycle?.status==='failed'||jobs.some(j=>['failed','uncertain'].includes(j.status)));}
 field(parent,label,tag='select'){const wrap=node('label','opinion-field',label),e=node(tag);e.id='opinion-control-'+(++this.sequence);wrap.htmlFor=e.id;e.setAttribute('aria-label',label);wrap.append(e);parent.append(wrap);return e;}
 options(select,values,value){select.replaceChildren(...values.map(v=>{const o=node('option','',v.label||v.value);o.value=v.value;o.disabled=Boolean(v.disabled);return o;}));select.value=values.some(v=>v.value===value&&!v.disabled)?value:values.find(v=>!v.disabled)?.value||'';}
 header(title){this.dialog.classList.remove('automatic-review-dialog');this.dialog.replaceChildren();const h=node('div','opinion-dialog-heading');h.append(node('h2','',title),this.button('Fechar',()=>this.dialog.close()));this.dialog.append(h);}
 error(text){if(!this.errorBox){this.errorBox=node('p','opinion-error');this.errorBox.setAttribute('role','alert');this.dialog.append(this.errorBox);}this.errorBox.textContent=text;}
 mount(article,owner,message){
  if(!['user','assistant'].includes(message.role)||message.internal||message.streaming||this.submission(message,owner)||!message.text?.trim())return;
  const sourceKey=opinionMessageKey(message,owner.messages.indexOf(message)),bar=node('div','message-opinions');
  const alternative=message.role==='user',ask=this.button('',()=>this.openQuick(owner,sourceKey,message.role,ask),'opinion-trigger');ask.append(glyph(alternative?'alternative':'opinion'),node('span','',alternative?'Outra resposta':'Segunda opinião'));ask.setAttribute('aria-haspopup','dialog');ask.setAttribute('aria-controls',this.quick.id);ask.setAttribute('aria-expanded','false');ask.addEventListener('pointerenter',event=>{if(event.pointerType!=='mouse')return;clearTimeout(this.hoverClose);this.hoverOpen=setTimeout(()=>{if(!this.dialog.open)this.openQuick(owner,sourceKey,message.role,ask,true);},450);});ask.addEventListener('pointerleave',()=>{clearTimeout(this.hoverOpen);this.scheduleClose();});bar.append(ask);article.append(bar);
 }
 mountResults(parent,owner,message,sourceIndex){
  if(!['user','assistant'].includes(message.role)||message.internal||!message.text?.trim())return;
  const slot=node('section','opinion-thread');slot.dataset.conversationId=owner.id;slot.dataset.messageKey=opinionMessageKey(message,owner.messages.indexOf(message));slot.dataset.requestId=message.requestId||'';slot.dataset.role=message.role;slot.dataset.sourceIndex=sourceIndex;slot.opinionList=node('div','opinion-batches');slot.append(slot.opinionList);this.slots.add(slot);parent.append(slot);this.renderSlot(slot);
 }
 preferences(){try{const value=JSON.parse(localStorage.getItem('hydraq.opinions.preferences')||'[]');return Array.isArray(value)?value.slice(0,4):[];}catch{return [];}}
 participant(parent,owner,pref){
  const p=this.field(parent,'Cliente'),m=this.field(parent,'Modelo'),e=this.field(parent,'Raciocínio'),state=this.getState(),caps=state.opinions?.capabilities||{},available=Object.entries(names).filter(([id])=>state.providers[id]?.models?.length);
  this.options(p,available.map(([id,name])=>({value:id,label:name+(caps[id]?.available?'':' · indisponível'),disabled:!caps[id]?.available})),pref?.provider||available.find(([id])=>id!==owner.provider&&caps[id]?.available)?.[0]);
  const efforts=()=>{const model=this.getState().providers[p.value]?.models.find(x=>x.id===m.value);this.options(e,(model?.efforts||[]).map(value=>({value,label:effortLabels[value]||value})),pref?.model===m.value?pref.effort:model?.defaultEffort);};
  const models=()=>{this.options(m,(this.getState().providers[p.value]?.models||[]).filter(x=>p.value!=='opencode'||x.free).map(x=>({value:x.id,label:x.name||x.id})),pref?.provider===p.value?pref.model:undefined);efforts();};p.addEventListener('change',models);m.addEventListener('change',efforts);models();return {p,m,e,read:()=>({provider:p.value,model:m.value,effort:e.value})};
 }
 positionQuick(){
  if(this.quick.hidden)return;if(!this.quickAnchor?.isConnected){this.closeQuick();return;}
  const box=this.quickAnchor.getBoundingClientRect(),panel=this.quick.getBoundingClientRect(),margin=10,gap=10,height=window.innerHeight;
  const below=box.bottom+gap,above=box.top-panel.height-gap,preferred=below+panel.height<=height-margin?below:above>=margin?above:height-panel.height-margin;
  const top=Math.max(margin,Math.min(preferred,height-panel.height-margin));
  const edge=this.quickAnchor.closest('#messages')?.getBoundingClientRect().right||window.innerWidth,wanted=box.left+panel.width>edge?box.right-panel.width:box.left-6;
  const left=Math.round(Math.max(margin,Math.min(wanted,window.innerWidth-panel.width-margin)));
  // The notch points at the trigger's icon; it is hidden when the panel cannot sit next to it.
  this.quick.dataset.side=top===below?'below':top===above?'above':'free';
  this.quick.style.setProperty('--notch-x',Math.round(Math.min(Math.max(box.left+15-left,18),panel.width-18))+'px');
  this.quick.style.left=left+'px';this.quick.style.top=Math.round(top)+'px';
 }
 providerChips(select){
  const group=node('div','opinion-providers');group.setAttribute('role','radiogroup');group.setAttribute('aria-label','Cliente');
  const usable=chip=>chip.getAttribute('aria-disabled')!=='true';
  const sync=()=>{for(const chip of chips){const on=chip.dataset.provider===select.value;chip.setAttribute('aria-checked',String(on));chip.tabIndex=on?0:-1;}};
  const chips=[...select.options].map(option=>{const chip=node('button','opinion-provider');chip.type='button';chip.setAttribute('role','radio');chip.dataset.provider=option.value;
   chip.append(node('i','opinion-provider-dot'),node('span','',shortNames[option.value]||option.textContent));if(option.value==='opencode')chip.append(node('small','','grátis'));
   if(option.disabled){chip.setAttribute('aria-disabled','true');chip.dataset.tip=option.textContent;}
   chip.addEventListener('click',()=>{if(!usable(chip)||select.value===option.value)return;select.value=option.value;select.dispatchEvent(new Event('change'));sync();});return chip;});
  group.addEventListener('keydown',event=>{const steps={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1};if(!(event.key in steps)&&!['Home','End'].includes(event.key))return;event.preventDefault();
   const enabled=chips.filter(usable),index=enabled.indexOf(document.activeElement),next=event.key==='Home'?enabled[0]:event.key==='End'?enabled.at(-1):enabled[(index+steps[event.key]+enabled.length)%enabled.length];next?.click();next?.focus();});
  group.append(...chips);sync();return group;
 }
 scheduleClose(){clearTimeout(this.hoverClose);this.hoverClose=setTimeout(()=>{if(!this.quick.matches(':hover')&&!this.quick.contains(document.activeElement))this.closeQuick();},350);}
 closeQuick(focus=false){clearTimeout(this.hoverOpen);clearTimeout(this.hoverClose);this.quick.hidden=true;this.quickAnchor?.setAttribute('aria-expanded','false');if(focus&&this.quickAnchor?.isConnected)this.quickAnchor.focus();this.quickAnchor=null;}
 openQuick(owner,messageKey,role,anchor,hover=false){
  if(this.quickAnchor===anchor&&!this.quick.hidden){if(!hover)(this.quick.querySelector('textarea')||this.quick).focus({preventScroll:true});return;}this.closeQuick();
  const problem=this.getState()?.opinions?.error;if(problem){this.toast(problem);return;}
  const alternative=role==='user';this.quickAnchor=anchor;this.quick.replaceChildren();this.quick.dataset.kind=alternative?'alternative':'opinion';
  const heading=node('header','opinion-quick-heading'),title=node('div','opinion-quick-title'),close=this.button('',()=>this.closeQuick(true),'opinion-quick-close');
  title.append(node('strong','',alternative?'Outra resposta':'Segunda opinião'),node('small','',alternative?'Responde à mesma pergunta noutra sessão.':'Avalia esta resposta noutra sessão.'));
  close.append(glyph('close'));close.setAttribute('aria-label','Fechar escolha rápida');heading.append(glyph(alternative?'alternative':'opinion','opinion-quick-glyph'),title,close);this.quick.append(heading);
  const draftKey=owner.id+':'+messageKey,draft=this.quickDrafts.get(draftKey)||{},fields=node('div','opinion-quick-fields'),preferences=this.preferences(),record=this.participant(fields,owner,draft.participant||preferences[0]);
  // The client select stays the source of truth; the chips are its visible control.
  const [clientField,modelField,effortField]=[record.p,record.m,record.e].map(control=>control.closest('label')),chips=this.providerChips(record.p),row=node('div','opinion-quick-row');
  clientField.hidden=true;row.append(modelField,effortField);fields.append(chips,row);this.quick.append(fields);
  const mode=alternative?null:this.field(this.quick,'O que verificar');if(mode){this.options(mode,Object.entries(reviewModes).map(([value,label])=>({value,label})),draft.mode||'comment');}
  const focus=this.field(this.quick,'Instruções adicionais / foco','textarea');focus.rows=1;focus.maxLength=3000;focus.value=draft.focus||'';focus.placeholder=alternative?'Ex.: propõe uma alternativa mais simples.':'Ex.: procura regressões e casos limite.';
  const remember=()=>this.quickDrafts.set(draftKey,{participant:record.read(),mode:mode?.value||'comment',focus:focus.value});this.quick.oninput=remember;this.quick.onchange=remember;
  const error=node('p','opinion-error');error.setAttribute('role','alert');error.hidden=true;this.quick.append(error);const actions=node('div','opinion-quick-actions'),submit=this.button('Consultar',async()=>{
   submit.disabled=true;error.hidden=true;try{const result=await this.submitOpinion(owner,messageKey,[record.read()],focus.value,mode?.value||'comment');this.quickDrafts.delete(draftKey);this.closeQuick();await this.refreshState();this.revealResult(result.id);}catch(e){error.hidden=false;error.textContent=e.message;this.positionQuick();}finally{submit.disabled=false;}
  },'primary-button');const more=this.button('Mais opções…',()=>{const pref=record.read();this.closeQuick();this.choose(owner,messageKey,role,[pref,...preferences.slice(1)],{focus:focus.value,mode:mode?.value||'comment'});},'opinion-quick-more');more.dataset.tip='Comparar vários modelos, indicar um foco e consultar os detalhes do contexto.';submit.dataset.tip='Consultar agora (Ctrl+Enter). As escolhas desta conversa mantêm-se.';
  this.quick.onkeydown=event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!submit.disabled){event.preventDefault();submit.click();}};
  actions.append(more,submit);this.quick.append(actions);this.quick.hidden=false;anchor.setAttribute('aria-expanded','true');this.positionQuick();if(!hover)(chips.querySelector('[aria-checked="true"]')||record.p).focus({preventScroll:true});
 }
 revealResult(id){const panel=[...document.querySelectorAll('.opinion-batch')].find(e=>e.dataset.batchId===id);if(panel){this.openAncestors(panel);panel.scrollIntoView({block:'nearest',behavior:'instant'});}}
 async submitOpinion(owner,messageKey,participants,comment,reviewMode='comment'){
  const signature=JSON.stringify([owner.id,messageKey,participants,comment,reviewMode]);let requestId=this.submissions.get(signature);if(!requestId){requestId=crypto.randomUUID();this.submissions.set(signature,requestId);}
  const result=await this.api('/api/conversations/'+owner.id+'/opinions',{requestId,messageKey,participants,comment,reviewMode});this.submissions.delete(signature);try{localStorage.setItem('hydraq.opinions.preferences',JSON.stringify(participants));}catch{}return result;
 }
 renderSubmission(content,message){
  const state=this.viewState(),merge=state?.merges.find(m=>m.requestId===message.requestId),marker='\n\n<hydraq_selected_opinions>';
  if(!merge&&!state?.automatic?.cycles.some(c=>c.returnRequestId===message.requestId))return false;
  const jobs=(merge?.jobIds||[]).map(id=>state.batches.flatMap(b=>b.jobs).find(j=>j.id===id)).filter(Boolean);
  const details=this.fold('delivery:'+message.requestId,'review-delivery','Contexto interno · '+(merge?.jobIds?.length||jobs.length)+' parecer(es) enviado(s) ao principal');
  details.append(node('p','opinion-caption','Pedido interno de síntese. Os pareceres são contexto citado; só o principal decide o que aceitar.'));
  const instruction=this.fold('instruction:'+message.requestId,'review-instruction','Instruções da avaliação');instruction.append(node('pre','',message.text.split(marker)[0]));details.append(instruction);
  for(const job of jobs){const opinion=this.fold('submitted:'+message.requestId+':'+job.id,'opinion-submitted',names[job.provider]+' · '+job.model);opinion.append(this.markdown(job.text));details.append(opinion);}
  if(jobs.length<(merge?.jobIds?.length||0)){const raw=this.fold('raw:'+message.requestId,'review-instruction','Conteúdo enviado · histórico arquivado');raw.append(node('pre','',message.text));details.append(raw);}
  content.append(details);return true;
 }

 refresh(){
  const view=document.querySelector('#messages'),top=view?.scrollTop||0,nearBottom=view?view.scrollHeight-top-view.clientHeight<120:false;let changed=false;
  for(const slot of this.slots){if(!slot.isConnected){this.slots.delete(slot);continue;}const previous=slot.signature;this.renderSlot(slot);changed ||= previous!==slot.signature;}
  for(const details of this.reviewGroups){if(!details.isConnected)this.reviewGroups.delete(details);else this.updateGroup(details);}
  if(changed&&view)view.scrollTop=nearBottom?view.scrollHeight:top;this.positionQuick();
 }
 renderSlot(slot){const state=this.viewState(),batches=state?.batches.filter(b=>b.conversationId===slot.dataset.conversationId&&b.sourceKey===slot.dataset.messageKey)||[],cycles=slot.dataset.role==='user'?(state?.automatic?.cycles||[]).filter(r=>r.conversationId===slot.dataset.conversationId&&r.requestId===slot.dataset.requestId):[];const signature=JSON.stringify([batches,cycles,state?.merges,state?.automatic?.cycles,state?.error,batches.map(batch=>this.deliveryFilters.get(batch.id))]);if(slot.signature===signature)return;slot.signature=signature;const focused=slot.contains(document.activeElement)?document.activeElement:null,approvalNodes=new Map([...slot.querySelectorAll('.opinion-approval')].map(e=>[e.dataset.approvalId,e]));slot.opinionList.replaceChildren();slot.hidden=!batches.length&&!cycles.length;
  for(const cycle of cycles){const note=node('div','automatic-review-note');note.setAttribute('role','status');note.append(node('strong','','Revisão automática · '+(cycleStates[cycle.status]||cycle.status)));if(cycle.reason||cycle.error)note.append(node('p',cycle.error?'opinion-error':'opinion-caption',cycle.error||cycle.reason));if(['waiting-main','preparing','reviewing','delivering','assessing'].includes(cycle.status))note.append(this.button('Parar revisão automática',async()=>{try{await this.api('/api/automatic-reviews/'+cycle.id+'/cancel',{});await this.refreshState();}catch(e){this.toast(e.message);}}));slot.opinionList.append(note);}
  if(state?.error&&batches.length)slot.opinionList.append(node('p','opinion-error',state.error));
  for(const batch of batches){const panel=this.fold('batch:'+batch.id,'opinion-batch',(batch.kind==='alternative'?'Outras respostas':'Pareceres')+' · '+batch.jobs.filter(j=>j.status==='completed').length+'/'+batch.jobs.length+' prontos'+(batch.jobs.some(j=>j.approvals?.length)?' · Decisão pendente':batch.jobs.some(active)?' · Em curso':batch.jobs.some(j=>j.status!=='completed')?' · Com falhas':''),Boolean(batch.automaticCycleId));panel.dataset.batchId=batch.id;
   panel.append(node('p','opinion-caption',batch.automaticCycleId?'Revisão automática · '+(reviewModes[batch.reviewMode]||'Comentar resposta'):(batch.kind==='alternative'?'Resposta independente':reviewModes[batch.reviewMode]||'Comentar resposta')+' · não entra automaticamente no contexto da conversa.'));
   const filter=node('div','opinion-delivery-filter');filter.setAttribute('role','group');filter.setAttribute('aria-label','Filtrar pareceres por entrega');
   const pendingOnly=this.deliveryFilters.get(batch.id)===true;
   for(const [value,label] of [[false,'Todos'],[true,'Por enviar']]){const button=this.button(label,()=>{this.deliveryFilters.set(batch.id,value);slot.signature='';this.renderSlot(slot);});button.setAttribute('aria-pressed',String(value===pendingOnly));filter.append(button);}panel.append(filter);
   const cycle=state?.automatic?.cycles.find(r=>r.id===batch.automaticCycleId),automaticPending=cycle&&['waiting-main','preparing','reviewing','delivering','assessing'].includes(cycle.status);
   if(batch.comment)panel.append(node('p','opinion-focus','Foco: '+batch.comment));for(const warning of batch.warnings||[])panel.append(node('p','opinion-caption',warning));
   for(const job of batch.jobs){const delivery=opinionDelivery(job.id,state?.merges);if(pendingOnly&&delivery.state==='submitted')continue;const card=this.fold('job:'+job.id,'message assistant opinion-card','');const jobSummary=card.firstElementChild;card.dataset.provider=job.provider;card.dataset.jobId=job.id;card.dataset.delivery=delivery.state;
    const contextNote=node('p','opinion-context-status',opinionContextLabel(job,delivery)+(automaticPending&&delivery.state==='separate'&&automaticReturnMode(cycle.config)!=='manual'?' · ciclo automático em curso':''));contextNote.dataset.delivery=delivery.state;jobSummary.append(node('strong','',names[job.provider]),node('span','opinion-summary-model',this.getState().providers[job.provider]?.models.find(m=>m.id===job.model)?.name||job.model),node('span','opinion-summary-state',job.approvals?.length?'Decisão pendente':statuses[job.status]||job.status));const contextBadge=node('span','opinion-summary-context',delivery.state==='submitted'?'Enviado':delivery.state==='uncertain'?'Entrega incerta':delivery.state==='sending'?'A enviar':job.recommendation?.status==='decided'&&!job.recommendation.sendToPrincipal?'Não recomenda enviar':'Separado');contextBadge.dataset.delivery=delivery.state;contextBadge.title=contextNote.textContent;jobSummary.append(contextBadge);card.append(contextNote);
    if(job.error)jobSummary.append(node('span','opinion-summary-error',job.error));
    card.append(node('p','opinion-access',job.allowWrite?'Escrita explicitamente ativada · autorizações nativas':'Planear / só leitura · não edita ficheiros'));
    if(job.recommendation)card.append(node('p','opinion-recommendation',(job.recommendation.status==='pending'?'Decisão pendente: ':job.recommendation.sendToPrincipal?'Recomenda enviar: ':'Não recomenda enviar: ')+job.recommendation.reason));

    const header=node('header','message-header'),avatar=node('span','avatar',({codex:'C',claude:'C',antigravity:'A',cursor:'G',opencode:'O'})[job.provider]),model=this.getState().providers[job.provider]?.models.find(m=>m.id===job.model),time=node('time','',new Date(job.startedAt||job.createdAt).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'}));avatar.setAttribute('aria-hidden','true');time.dateTime=job.startedAt||job.createdAt;
    header.append(avatar,node('strong','',names[job.provider]),node('span','message-model',(model?.name||job.model)+' · '+(effortLabels[job.effort]||job.effort)),node('span','opinion-role',batch.kind==='alternative'?'Outra resposta':'Parecer'),time);card.append(header);
    const status=node('p','opinion-state',job.approvals?.length?'Aguarda a tua decisão':statuses[job.status]||job.status);if(active(job))status.setAttribute('role','status');card.append(status);
    if(job.activity?.length){const activity=this.fold('activity:'+job.id,'review-activity','Raciocínio e atividade comunicados pelo cliente',true);for(const item of job.activity)activity.append(node('p','opinion-caption',`${item.label} · ${item.status}`));card.append(activity);}
    if(job.text)card.append(this.markdown(job.text));else if(active(job))card.append(node('p','opinion-caption','A aguardar texto do revisor…'));if(job.error)card.append(node('p','opinion-error',job.error));
    for(const request of job.approvals||[]){const previous=approvalNodes.get(String(request.id)),approval=previous?.approvalSignature===JSON.stringify(request)?previous:this.approval(job,request);card.append(approval);if(!this.seenApprovals.has(request.id)){this.seenApprovals.add(request.id);this.openAncestors(card);slot.pendingReveal=approval;}}
    if(job.usage){const u=job.usage;card.append(node('p','opinion-caption',`Entrada: ${u.inputTokens??u.input_tokens??'não medida'} · Saída: ${u.outputTokens??u.output_tokens??'não medida'}${job.provider==='opencode'?' · Custo: '+(Number.isFinite(job.costUSD)?job.costUSD+' USD':'não medido'):''}`));}
    const controls=node('div','opinion-card-actions');
    if(active(job)&&!job.approvals?.length)controls.append(this.button('Parar este parecer',async()=>{try{await this.api('/api/opinions/'+job.id+'/stop',{});await this.refreshState();}catch(e){this.toast(e.message);}}));
    if(job.status==='completed'&&job.text&&delivery.state==='separate'&&!automaticPending){const label=node('label','opinion-selection'),check=node('input');check.type='checkbox';check.checked=this.selected.has(job.id);check.setAttribute('aria-label','Selecionar parecer de '+names[job.provider]+' '+job.model);check.addEventListener('change',()=>{check.checked?this.selected.add(job.id):this.selected.delete(job.id);this.updateUseButton(panel,batch);});label.append(check,document.createTextNode('Selecionar'));controls.append(label,this.button('Enviar este à conversa',()=>this.incorporate(batch,[job.id])));}
    card.append(controls);panel.append(card);
   }
   panel.useButton=this.button('Enviar selecionados à conversa',()=>this.incorporate(batch,batch.jobs.filter(j=>this.selected.has(j.id)&&j.status==='completed'&&opinionDelivery(j.id,this.viewState()?.merges).state==='separate').map(j=>j.id)));panel.append(panel.useButton);this.updateUseButton(panel,batch);slot.opinionList.append(panel);if(slot.pendingReveal){this.openAncestors(slot.pendingReveal);slot.pendingReveal=null;}
  }
  if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});
 }
 approval(job,request){const card=node('section','opinion-approval'),p=request.params||{},send=async result=>{try{await this.api('/api/opinions/'+job.id+'/respond',{id:request.id,...result});await this.refreshState();}catch(error){this.toast(error.message);}};
  card.dataset.approvalId=String(request.id);card.approvalSignature=JSON.stringify(request);
  card.append(node('h4','',names[job.provider]+' · decisão pendente'));
  const preview=p.description||p.reason||p.toolCall?.title||p.displayName||p.toolName||p.message||request.method;
  card.append(node('p','',preview));const input=p.input||p.toolCall?.rawInput;if(input)card.append(node('pre','',typeof input==='string'?input:JSON.stringify(input,null,2)));
  if(request.method==='session/request_permission'){
   for(const option of p.options||[])card.append(this.button(option.name||option.optionId,()=>send({optionId:option.optionId})));
  }else if(['elicitation/create','mcpServer/elicitation/request'].includes(request.method)){
   try{const form=elicitationForm(p.requestedSchema);card.append(form.container,this.button('Responder',()=>{try{send({action:'accept',content:form.read()});}catch(e){this.toast(e.message);}}),this.button('Recusar',()=>send({action:'decline'})));}catch(e){card.append(node('p','opinion-error',e.message),this.button('Recusar',()=>send({action:'decline'})));}
  }else if(request.method==='tool/requestUserInput'){
   const fields=(p.questions||[]).map(q=>({q,input:this.field(card,q.question||q.header||q.id,'textarea')}));card.append(this.button('Responder',()=>send({answers:Object.fromEntries(fields.map(({q,input})=>[q.id,input.value]))})));
  }else if(request.method==='cursor/ask_question'){
   const fields=(p.questions||[]).map(q=>{const group=node('fieldset');group.append(node('legend','',q.prompt));const inputs=(q.options||[]).map(option=>{const label=node('label'),i=node('input');i.type=q.allowMultiple?'checkbox':'radio';i.name=request.id+q.id;i.value=option.id;label.append(i,document.createTextNode(option.label));group.append(label);return i;});card.append(group);return {q,inputs};});card.append(this.button('Responder',()=>send({answers:fields.map(({q,inputs})=>({questionId:q.id,selectedOptionIds:inputs.filter(i=>i.checked).map(i=>i.value)}))})));
  }else if(request.method==='cursor/create_plan'){
   card.append(node('pre','',p.plan||''),this.button('Aceitar plano',()=>send({decision:'accept'})),this.button('Recusar',()=>send({decision:'decline'})));
  }else if(request.method==='claude/canUseTool'||request.method.endsWith('/requestApproval'))card.append(this.button('Permitir desta vez',()=>send({decision:'accept'})),this.button('Recusar',()=>send({decision:'decline'})));
  card.append(this.button('Parar este parecer',async()=>{try{await this.api('/api/opinions/'+job.id+'/stop',{});await this.refreshState();}catch(e){this.toast(e.message);}}));return card;
 }
 updateUseButton(panel,batch){const state=this.viewState(),cycle=state?.automatic?.cycles.find(r=>r.id===batch.automaticCycleId),pending=cycle&&['waiting-main','preparing','reviewing','delivering','assessing'].includes(cycle.status);panel.useButton.hidden=!batch.jobs.some(j=>j.status==='completed'&&opinionDelivery(j.id,state?.merges).state==='separate');panel.useButton.disabled=Boolean(pending)||batch.jobs.some(active)||!batch.jobs.some(j=>this.selected.has(j.id)&&j.status==='completed'&&opinionDelivery(j.id,state?.merges).state==='separate');panel.useButton.dataset.tip=pending?'O ciclo automático ainda está em curso.':batch.jobs.some(active)?'Aguarda os restantes pareceres ou interrompe-os antes de enviar à conversa.':'Enviar apenas os resultados selecionados que ainda estão separados, com um comentário opcional.';}
 choose(owner,messageKey,role,preferences=this.preferences(),initial={}){this.header(role==='user'?'Pedir outra resposta':'Pedir opinião');this.errorBox=null;this.dialog.append(node('p','opinion-caption',role==='user'?'Os participantes recebem a pergunta e o contexto anterior relevante, sem as respostas posteriores.':'Os participantes recebem a pergunta, esta resposta e o contexto relevante, incluindo referências aos ficheiros observados.'));
  const mode=role==='user'?null:this.field(this.dialog,'O que verificar');if(mode)this.options(mode,Object.entries(reviewModes).map(([value,label])=>({value,label})),initial.mode||'comment');
  const rows=node('div','opinion-participants');this.dialog.append(rows);const controls=[];
  const add=pref=>{if(controls.length>=4)return;const row=node('div','opinion-participant'),record={row,...this.participant(row,owner,pref)};controls.push(record);row.append(this.button('Remover',()=>{controls.splice(controls.indexOf(record),1);row.remove();}));rows.append(row);};
  if(preferences.length)for(const pref of preferences)add(pref);else add();
  this.dialog.append(this.button('＋ Outro participante',()=>add()));const comment=this.field(this.dialog,'Foco opcional','textarea');comment.rows=2;comment.maxLength=3000;comment.value=initial.focus||'';comment.placeholder='Ex.: procura falhas no plano, sugere alternativas ou avalia o design.';
  const limits=node('details','opinion-context-info');limits.append(node('summary','','Contexto e limites'),node('p','opinion-caption','Sem troca de cliente na conversa principal. Cada participante usa uma sessão própria, com as ferramentas habituais em Planear (só leitura no Codex), e consome a sua conta/quota. As autorizações aparecem no respetivo cartão. Históricos extensos seguem como excertos identificados.'));
  this.dialog.append(limits);const submit=this.button('Consultar modelos',async()=>{
   const participants=controls.map(({p,m,e})=>({provider:p.value,model:m.value,effort:e.value}));if(!participants.length){this.error('Escolhe pelo menos um participante.');return;}submit.disabled=true;
   try{const result=await this.submitOpinion(owner,messageKey,participants,comment.value,mode?.value||'comment');this.dialog.close();await this.refreshState();this.revealResult(result.id);}
   catch(error){this.error(error.message);await this.refreshState().catch(()=>{});}finally{submit.disabled=false;}
  },'primary-button');this.dialog.append(submit);this.dialog.showModal();}
 automaticSetting(){const key=this.getKey(),target=this.getTarget();if(this.automaticDrafts.has(key))return this.automaticDrafts.get(key);return this.getState()?.opinions?.automatic?.policies?.[target?.group||target?.id]||null;}
 consumeAutomatic(key){this.automaticDrafts.delete(key);}
 moveAutomatic(from,to){if(from!==to&&this.automaticDrafts.has(from)){this.automaticDrafts.set(to,this.automaticDrafts.get(from));this.automaticDrafts.delete(from);}}
 automaticSummary() {
  const config = this.automaticSetting();
  return config ? 'Revisores: ' + automaticParticipants(config).map(p=>shortNames[p.provider]).join(' + ') : '';
 }
 renderAutomatic() {
  const button = document.getElementById('review-toggle');
  if (!button) return;
  const config = this.automaticSetting();
  button.textContent = config ? 'Revisor · ' + ({all:'Todas',plan:'Plano',implementation:'Código'}[config.trigger]) : 'Revisor';
  button.setAttribute('aria-pressed', String(Boolean(config)));
  button.dataset.tip = config ? `${automaticParticipants(config).map(p=>`${names[p.provider]} · ${p.model} · ${effortLabels[p.effort]||p.effort} · ${p.allowWrite?'escrita ativada':'Planear / só leitura'}`).join(' + ')} · ${config.scope==='conversation'?'nesta conversa':'só no próximo pedido'} · ${{always:'pareceres reunidos numa avaliação pelo principal',necessary:'envia apenas os pareceres que os revisores recomendarem',manual:'pareceres separados, envio manual'}[automaticReturnMode(config)]}` : 'Revisor desligado. Escolher até quatro revisores para o próximo pedido ou esta conversa.';
  const warning = document.getElementById('review-unavailable');
  if (warning && warning.dataset.key !== this.getKey()) warning.hidden = true;
 }
 offerWithoutReview(error) {
  const warning = document.getElementById('review-unavailable'), key = this.getKey();
  warning.dataset.key = key;
  warning.replaceChildren(node('strong','','O pedido ainda não foi enviado.'),node('p','',error.message));
  warning.append(this.button('Enviar sem revisão', () => {
   if (this.getKey() !== key) return this.toast('A conversa mudou. Revê o pedido antes de enviar.');
   this.automaticDrafts.set(key, null);
   warning.hidden = true;
   this.renderAutomatic();
   document.getElementById('composer').requestSubmit();
  }, 'primary-button'), this.button('Configurar revisor', () => this.configureAutomatic()), this.button('Fechar', () => { warning.hidden = true; }));
  warning.hidden = false;
 }
 viewState() {
  const state = this.getState()?.opinions;
  if (!state) return state;
  const target = this.getTarget(), cache = this.archived.get(target?.group||target?.id);
  const combine = (older, recent) => [...new Map([...(older||[]),...recent].map(r => [r.id||r.requestId,r])).values()];
  return {...state, batches:combine(cache?.batches,state.batches), merges:combine(cache?.merges,state.merges),automatic:{...state.automatic,cycles:combine(cache?.cycles,state.automatic?.cycles||[])}};
 }
 mountArchive(parent, conversation) {
  const group = conversation?.group || conversation?.id;
  if (!group || !this.getState()?.opinions?.archivedGroups?.includes(group)) return;
  let cache = this.archived.get(group);
  if (!cache) { cache = {batches:[],cycles:[],merges:[],cursor:'',loaded:false}; this.archived.set(group, cache); }
  const box = node('div','opinion-history');
  const load = async () => {
   if (cache.loading) return;
   cache.loading = true; cache.error = false; button.disabled = true;
   try {
    const page = await this.api('/api/conversations/'+conversation.id+'/opinion-history?cursor='+encodeURIComponent(cache.cursor||''));
    for (const kind of ['batches','cycles','merges']) cache[kind].push(...page[kind]);
    cache.cursor = page.nextCursor; cache.loaded = true; this.archiveRevision++;
   } catch (error) { cache.error = true; button.disabled = false; button.textContent = 'Tentar carregar pareceres'; this.toast('Não foi possível ler os pareceres anteriores: '+error.message); }
   finally { cache.loading = false; await this.refreshState(); }
  };
  const button = this.button(cache.loading?'A carregar pareceres…':'Carregar pareceres anteriores', load);
  button.disabled = Boolean(cache.loading);
  box.append(button,node('small','','Histórico preservado · carregado por páginas'));
  if (!cache.loaded || cache.cursor) parent.append(box);
  if (!cache.loaded && !cache.loading && !cache.error) void load();
 }
 configureAutomatic(){
  const target=this.getTarget(),key=this.getKey(),current=this.automaticSetting();this.header('Revisores automáticos');this.dialog.classList.add('automatic-review-dialog');this.errorBox=null;
  this.dialog.append(node('p','opinion-caption','Cada modelo revê a resposta ou o código. Por omissão, só o principal pode implementar: os revisores apontam problemas e melhorias em Planear/Só leitura. Podes enviar sempre, deixar cada revisor decidir se vale a pena enviar, ou escolher manualmente. Os pareceres enviados seguem juntos numa única avaliação pelo principal, mantendo as permissões do pedido original. Uma ronda, sem repetição.'));
  const timing=node('div','review-timing');this.dialog.append(timing);
  const trigger=this.field(timing,'Quando rever');this.options(trigger,[{value:'off',label:'Desligado'},{value:'all',label:'Todas as respostas finais'},{value:'plan',label:'Só ao planear / só leitura'},{value:'implementation',label:'Só após alterações observadas'}],current?.trigger||'off');
  const scope=this.field(timing,'Duração');this.options(scope,[{value:'request',label:'Só no próximo pedido'},{value:'conversation',label:'Manter nesta conversa'}],current?.scope||'request');
  const rows=node('div','automatic-review-participants'),controls=[];this.dialog.append(rows);
  const add=pref=>{
   if(controls.length>=4)return;
   const fieldset=node('fieldset','automatic-review-member'),legend=node('legend','','Revisor '+(controls.length+1)),row=node('div','opinion-participant'),record=this.participant(row,target||{provider:'codex'},pref);
   fieldset.append(legend,row);
   const permission=node('label','review-write'),write=node('input');write.type='checkbox';write.checked=pref?.allowWrite===true;write.setAttribute('aria-label','Permitir editar ficheiros · '+legend.textContent);permission.append(write,document.createTextNode('Permitir editar ficheiros'));permission.dataset.tip='Desligado por omissão. Ativar dá ao revisor modo de execução com autorizações nativas; nunca ativa aceitação automática. Se algum revisor puder escrever, a equipa trabalha em sequência.';
   const entry={fieldset,record,write};controls.push(entry);fieldset.append(permission,this.button('Remover revisor',()=>{controls.splice(controls.indexOf(entry),1);fieldset.remove();renumber();}));rows.append(fieldset);renumber();
  };
  const renumber=()=>{controls.forEach((entry,index)=>{entry.fieldset.querySelector('legend').textContent='Revisor '+(index+1);entry.write.setAttribute('aria-label','Permitir editar ficheiros · Revisor '+(index+1));});addButton.disabled=controls.length>=4;};
  const addButton=this.button('＋ Outro revisor',()=>{const used=new Set(controls.map(entry=>entry.record.p.value));const state=this.getState();const provider=Object.keys(names).find(id=>!used.has(id)&&state.opinions?.capabilities[id]?.available&&state.providers[id]?.models?.length);add(provider?{provider}:undefined);});this.dialog.append(addButton);
  const previous=automaticParticipants(current);for(const pref of previous.length?previous:[this.preferences()[0]])add(pref&&{...pref,allowWrite:current?pref.allowWrite===true:false});
  const focus=this.field(this.dialog,'Instruções adicionais / foco','textarea');focus.rows=2;focus.maxLength=3000;focus.value=current?.focus||'';
  const delivery=this.field(this.dialog,'Enviar pareceres ao principal');delivery.parentElement.classList.add('review-delivery');this.options(delivery,[{value:'always',label:'Enviar sempre'},{value:'necessary',label:'Enviar apenas se necessário'},{value:'manual',label:'Envio manual'}],automaticReturnMode(current));delivery.dataset.tip='Se necessário: cada revisor decide com justificação. Só os recomendados seguem automaticamente. Os restantes ficam separados e podem ser enviados manualmente.';
  this.dialog.append(node('p','opinion-caption','Em «Enviar apenas se necessário», cada revisor indica se encontrou um erro, risco ou melhoria relevante que justifique nova avaliação. Só os pareceres recomendados seguem automaticamente. Os restantes continuam visíveis e enviáveis à mão. Decisões inválidas ou em falta ficam pendentes, sem aprovação implícita. Cada revisor usa a sua conta/quota. A revisão de código exige alterações de ficheiros observadas.'));
  const submit=this.button('Aplicar',async()=>{submit.disabled=true;try{if(this.getKey()!==key)throw Error('A conversa mudou. Abre novamente as opções.');const participants=controls.map(({record,write})=>({...record.read(),allowWrite:write.checked}));if(trigger.value!=='off'&&!participants.length)throw Error('Escolhe pelo menos um revisor.');const config=trigger.value==='off'?null:{trigger:trigger.value,scope:scope.value,participants,returnMode:delivery.value,focus:focus.value};if(target&&(config===null||config.scope==='conversation'))await this.api('/api/conversations/'+target.id+'/review-policy',{config});this.automaticDrafts.set(key,config);this.dialog.close();await this.refreshState();this.renderAutomatic();}catch(e){this.error(e.message);}finally{submit.disabled=false;}},'primary-button');this.dialog.append(submit);this.dialog.showModal();
 }
 incorporate(batch,jobIds){const target=this.getTarget();if(!target||target.group!==batch.groupId&&target.id!==batch.groupId){this.toast('Abre a conversa de origem para incorporar estes pareceres.');return;}if(batch.jobs.some(active)){this.toast('Aguarda os outros pareceres ou interrompe-os antes de enviar.');return;}
  this.header('Enviar à conversa');this.errorBox=null;this.dialog.append(node('p','opinion-caption',`Os ${jobIds.length} resultados selecionados serão enviados ao ${names[target.provider]}, mantendo as escolhas da conversa. O modelo avaliará as sugestões; não há implementação automática.`));const comment=this.field(this.dialog,'Comentário opcional','textarea');comment.rows=3;comment.maxLength=4000;comment.placeholder='Ex.: avalia estes pareceres e melhora o plano.';const requestId=crypto.randomUUID();const submit=this.button('Enviar ao '+names[target.provider],async()=>{
   submit.disabled=true;try{const current=this.getTarget();if(current?.id!==target.id)throw Error('A conversa mudou. Fecha e escolhe novamente.');const settings=this.getSettings();const result=await this.api('/api/conversations/'+target.id+'/opinion-incorporate',{jobIds,comment:comment.value,requestId,settings});if(!result.accepted)throw Error('O envio anterior está '+result.status+'; não foi reenviado.');this.dialog.close();await this.refreshState();}
   catch(error){this.error(error.message);await this.refreshState().catch(()=>{});}finally{submit.disabled=false;}
  },'primary-button');this.dialog.append(submit);this.dialog.showModal();}
}
