import {glyph,PanelKit} from './opinions.js';

const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity',cursor:'Cursor',opencode:'OpenCode'};
const shortNames={codex:'Codex',claude:'Claude',antigravity:'Antigravity',cursor:'Cursor',opencode:'OpenCode'};
const effortLabels={default:'Automático',none:'Sem raciocínio',minimal:'Mínimo',low:'Leve',medium:'Médio',high:'Alto',xhigh:'Muito alto',max:'Máximo',ultra:'Ultra'};
const busy=new Set(['starting','running','waiting','inProgress']);
const coverageLabels={complete:'completo',excerpt:'em excerto',summary:'resumido',none:'sem nada novo'};
export const DUAL_KEYS=['a','b'];
export const isReadMode=sandbox=>['read-only','plan','ask'].includes(sandbox);
export const dualRecord=(state,group)=>state?.dual?.records?.find(record=>record.groupId===group)||null;
export const activeDual=(state,group)=>{const record=dualRecord(state,group);return record?.active?record:null;};
const other=key=>key==='a'?'b':'a';
const shortName=provider=>shortNames[provider]||provider;

/** Who receives the next request, named on the send button before anything is sent. */
export function dualSendLabel(record,{target=record.target,writing=false}={}){
 if(target==='both')return 'Enviar aos dois ↗';
 const name=shortName(record.members[target].provider);
 return target===record.principal&&writing?`Enviar ao principal · ${name} ↗`:`Enviar só ao ${name} ↗`;
}

/** Messages of each round by recipient. Identity comes from the round record, never from the text. */
export function dualRounds(timeline,record){
 const index=new Map();
 timeline.forEach(({owner,message},i)=>{if(!message.requestId||message.internal)return;const key=owner.id+'|'+message.requestId;if(!index.has(key))index.set(key,[]);index.get(key).push(i);});
 // A recipient sent again keeps its earlier attempts in the same round.
 const find=(delivery,ids)=>ids.flatMap(id=>index.get(delivery.conversationId+'|'+id)||[]);
 return (record?.rounds||[]).map(round=>({round,parts:round.targets.map(key=>{const delivery=round.deliveries[key],current=find(delivery,[delivery.requestId]),all=find(delivery,[...(delivery.attempts||[]),delivery.requestId]).sort((x,y)=>x-y),users=all.filter(i=>timeline[i].message.role==='user');return {key,delivery,user:current.find(i=>timeline[i].message.role==='user')??users[0],users,answers:all.filter(i=>timeline[i].message.role==='assistant')};})})).filter(entry=>entry.parts.some(part=>part.user!==undefined));
}

/** A recipient's state comes from its own conversation; the round only knows what was handed over. */
export function dualPanelState(delivery,turn){
 if(!turn&&['preparing','sending'].includes(delivery.status))return {label:'A enviar',tone:'active',live:true};
 if(!turn&&delivery.status==='failed')return {label:'Não enviado',tone:'failed',live:false};
 if(!turn&&delivery.status==='uncertain')return {label:'Entrega incerta',tone:'failed',live:false};
 if(turn?.status==='waiting')return {label:'Aguarda decisão',tone:'warn',live:true,attention:true};
 if(busy.has(turn?.status))return {label:'A responder',tone:'active',live:true};
 const failed=['failed','interrupted','uncertain'].includes(turn?.status);
 return {label:{failed:'Falhou',interrupted:'Parado',uncertain:'Resultado incerto'}[turn?.status]||'Pronta',tone:failed?'failed':'done',live:false};
}

export class DualUI{
 constructor({api,getState,getCurrent,getKey,getProvider,getModels,memberSettings,toast,refresh,beforeChange,changed,open}){
  Object.assign(this,{api,getState,getCurrent,getKey,getProvider,getModels,memberSettings,toast,refresh,beforeChange,changed,open});
  this.panels=new PanelKit({toast});this.pending=new Map();this.sequence=0;
  this.dialog=node('dialog','opinion-dialog dual-dialog');this.dialog.setAttribute('aria-labelledby','dual-dialog-title');document.body.append(this.dialog);
  document.getElementById('dual-toggle')?.addEventListener('click',()=>this.configure());
 }
 record(conversation=this.getCurrent()){return conversation?activeDual(this.getState(),conversation.group):null;}
 anyRecord(conversation){return conversation?dualRecord(this.getState(),conversation.group):null;}
 /** A new conversation can start dual: the choice waits for the first request. */
 pendingFor(){return this.getCurrent()?null:this.pending.get(this.getKey())||null;}
 consumePending(key){this.pending.delete(key);}
 conversation(id){return this.getState()?.conversations?.find(c=>c.id===id)||null;}
 focusProvider(conversation){const record=this.record(conversation);return record?record.members[record.target==='both'?record.principal:record.target].provider:null;}
 both(conversation){const record=this.record(conversation);return record?record.target==='both':Boolean(!conversation&&this.pendingFor());}
 running(conversation){const record=this.record(conversation);return Boolean(record&&DUAL_KEYS.some(key=>busy.has(this.conversation(record.members[key].conversationId)?.status)));}
 /** Every recipient of the next request must be connected. */
 unavailable(conversation){
  const record=this.record(conversation);if(!record)return false;
  const keys=record.target==='both'?DUAL_KEYS:[record.target];
  return keys.some(key=>this.getState()?.providers?.[record.members[key].provider]?.connection!=='connected');
 }
 /** Only the principal writes: a request to both, or only to the other model, goes in Planear/Só leitura. */
 readOnly(conversation){const record=this.record(conversation);return record?record.target!==record.principal:Boolean(!conversation&&this.pendingFor());}
 /** Images must suit every recipient, not only the model on show. */
 imagesBlocked(conversation){
  const record=this.record(conversation),pending=this.pendingFor();
  const recipients=record?(record.target==='both'?DUAL_KEYS:[record.target]).map(key=>[record.members[key].provider,this.memberSettings(record,key)?.model]):pending?[[pending.provider,pending.model]]:[];
  return recipients.some(([provider,model])=>this.getState()?.providers?.[provider]?.capabilities?.images===false||this.getModels(provider).find(m=>m.id===model)?.images===false);
 }
 signature(conversation){const record=this.anyRecord(conversation);return record?[record.id,record.active,record.target,record.principal,this.running(conversation),record.rounds.map(r=>[r.id,r.targets,r.write,Object.values(r.deliveries).map(d=>[d.requestId,d.status,d.coverage,d.error])])]:null;}
 async setTarget(target){
  const record=this.record();if(!record||record.target===target)return;
  this.beforeChange();const previous=record.target;record.target=target;this.changed();
  try{await this.api('/api/dual/'+record.id,{target});}
  catch(error){record.target=previous;this.changed();this.toast(error.message);}
 }
 /** Writing goes only to the principal: choosing it for both, or for the other model, moves the request there. */
 enforceWrite(writing){
  const record=this.record();if(!record||record.target===record.principal||!writing)return;
  this.setTarget(record.principal);
  this.toast(`A implementação vai só para o principal: ${shortName(record.members[record.principal].provider)}. O outro recebe o resultado quando voltares a falar com ele.`);
 }
 modelLabel(provider,settings){const model=this.getModels(provider).find(m=>m.id===settings?.model);return [model?.name||settings?.model,effortLabels[settings?.effort]||settings?.effort].filter(Boolean).join(' · ');}

 renderComposer(conversation,{locked}){
  const toggle=document.getElementById('dual-toggle'),bar=document.getElementById('dual-targets'),composer=document.getElementById('composer'),review=document.getElementById('review-toggle');
  if(!toggle||!bar)return;
  const record=this.record(conversation),pending=this.pendingFor(),provider=conversation?.provider||this.getProvider();
  const pair=record?[record.members.a.provider,record.members.b.provider]:pending?[provider,pending.provider]:null;
  toggle.textContent=pair?`Dual · ${shortName(pair[0])} + ${shortName(pair[1])}`:'Dual';
  toggle.setAttribute('aria-pressed',String(Boolean(pair)));
  toggle.disabled=Boolean(locked&&!record);
  toggle.dataset.tip=pair?'Dual ativo: os dois modelos respondem à mesma pergunta sem ver a resposta um do outro; na pergunta seguinte, cada um recebe o que o outro disse. Escolher principal ou desligar.':'Dual: fazer a mesma pergunta a dois modelos de clientes diferentes, com histórico partilhado entre perguntas. Só o principal implementa.';
  const mode=record?(record.target==='both'?'both':'one'):pending?'both':null;
  if(mode)composer.dataset.dual=mode;else delete composer.dataset.dual;
  if(review){review.disabled=this.both(conversation);if(review.disabled)review.dataset.tip='Nas perguntas aos dois não há revisão automática. Fala só com o principal para implementar com revisor.';}
  bar.hidden=!pair;
  const target=record?.target||'both',signature=JSON.stringify([record?.id,target,record?.principal,pair,locked,pending,record&&DUAL_KEYS.map(key=>this.memberSettings(record,key)),pending&&this.memberSettings(null,'a')]);
  if(bar.dataset.signature===signature)return;
  bar.dataset.signature=signature;bar.replaceChildren();
  if(!pair)return;
  const option=(value,label,detail,tip,principal)=>{
   const button=node('button','dual-target');button.type='button';button.dataset.target=value;button.setAttribute('aria-pressed',String(target===value));button.dataset.tip=tip;
   if(value!=='both')button.dataset.client=record?record.members[value].provider:value==='a'?pair[0]:pair[1];
   if(principal){const star=node('span','dual-principal','★');star.setAttribute('aria-label','principal');button.append(star);}
   button.append(node('strong','',label));if(detail)button.append(node('small','',detail));
   button.disabled=locked||Boolean(pending&&value!=='both');
   button.addEventListener('click',()=>this.setTarget(value));
   return button;
  };
  const settings=key=>record?this.memberSettings(record,key):key==='a'?this.memberSettings(null,'a'):pending;
  const principal=record?.principal||pending?.principal||'a';
  const tip=key=>`Falar só com o ${shortName(pair[key==='a'?0:1])}. O outro não é executado; quando voltares a falar com ele, recebe esta troca.${principal===key?' Principal: é quem implementa quando escolhes escrita.':''}`;
  bar.append(option('a',shortName(pair[0]),this.modelLabel(pair[0],settings('a')),tip('a'),principal==='a'),option('both','Os dois','',pending?'O primeiro pedido vai para os dois. Depois podes falar com um de cada vez.':'Perguntar aos dois. Respondem sem ver a resposta um do outro, em Planear ou Só leitura.'),option('b',shortName(pair[1]),this.modelLabel(pair[1],settings('b')),tip('b'),principal==='b'));
 }

 field(parent,label,tag='select'){const wrap=node('label','opinion-field',label),control=node(tag);control.id='dual-control-'+(++this.sequence);wrap.htmlFor=control.id;wrap.append(control);parent.append(wrap);return control;}
 fill(select,values,value){select.replaceChildren(...values.map(v=>{const option=node('option','',v.label);option.value=v.value;return option;}));select.value=values.some(v=>v.value===value)?value:values[0]?.value||'';}
 header(title){
  this.dialog.replaceChildren();const heading=node('div','opinion-dialog-heading'),close=node('button','secondary-button','Fechar');close.type='button';close.addEventListener('click',()=>this.dialog.close());
  const h=node('h2','',title);h.id='dual-dialog-title';heading.append(h,close);this.dialog.append(heading);
 }
 configure(){
  const conversation=this.getCurrent(),record=this.record(conversation),pending=this.pendingFor(),source=conversation?.provider||this.getProvider();
  this.header('Dual · duas respostas independentes');
  this.dialog.append(node('p','opinion-caption','Os dois modelos respondem à mesma pergunta sem ver a resposta um do outro. Na pergunta seguinte, cada um recebe o que o outro respondeu, dentro do limite de tamanho (respostas longas seguem em excerto assinalado). Perguntas aos dois correm em Planear ou Só leitura; escrever no projeto fica só para o principal.'));
  const error=node('p','opinion-error');error.hidden=true;error.setAttribute('role','alert');
  const fail=message=>{error.textContent=message;error.hidden=false;};
  const actions=node('div','opinion-actions');
  const principalField=(a,b,value)=>{
   const group=node('fieldset','dual-principal-choice'),legend=node('legend','','Principal · implementa e decide');group.append(legend);
   const radios=['a','b'].map(key=>{const label=node('label','dual-principal-option'),input=node('input');input.type='radio';input.name='dual-principal-'+this.sequence;input.value=key;input.checked=value===key;label.append(input,document.createTextNode(shortName(key==='a'?a:b)));group.append(label);return input;});
   this.dialog.append(group);return ()=>radios.find(r=>r.checked)?.value||'a';
  };
  if(record){
   const summary=node('p','dual-summary');summary.append(node('strong','',`${names[record.members.a.provider]} + ${names[record.members.b.provider]}`),document.createTextNode(' · modelo e raciocínio de cada um escolhem-se na caixa de mensagens, ao falar só com ele.'));this.dialog.append(summary);
   const principal=principalField(record.members.a.provider,record.members.b.provider,record.principal);
   const save=node('button','primary-button','Guardar');save.type='button';
   save.addEventListener('click',async()=>{save.disabled=true;try{await this.api('/api/dual/'+record.id,{principal:principal()});await this.refresh();this.dialog.close();}catch(e){fail(e.message);save.disabled=false;}});
   const end=node('button','secondary-button','Desligar Dual');end.type='button';end.dataset.tip='A conversa continua com o principal. O histórico das duas conversas fica guardado.';
   end.addEventListener('click',async()=>{end.disabled=true;try{
    const principal=record.members[record.principal];
    await this.api('/api/dual/'+record.id+'/end',{});await this.refresh();this.dialog.close();
    // The next request goes to the principal, as the button promised.
    if(this.getCurrent()?.id!==principal.conversationId&&this.conversation(principal.conversationId))this.open?.(principal.conversationId);
    this.toast(`Dual desligado. A conversa continua com o principal: ${shortName(principal.provider)}.`);
   }catch(e){fail(e.message);end.disabled=false;}});
   actions.append(save,end);this.dialog.append(error,actions);this.dialog.showModal();return;
  }
  const available=Object.keys(names).filter(id=>id!==source&&this.getState()?.providers?.[id]?.connection==='connected'&&this.getModels(id).length);
  if(!available.length){this.dialog.append(node('p','opinion-caption','Liga primeiro outro cliente para escolher o segundo modelo.'));this.dialog.showModal();return;}
  const grid=node('div','dual-choice');this.dialog.append(grid);
  const fixed=node('p','dual-summary');fixed.append(node('strong','',names[source]),document.createTextNode(conversation?' · mantém a sessão desta conversa.':' · escolhido na caixa de mensagens.'));grid.append(fixed);
  const providerSelect=this.field(grid,'Segundo modelo · cliente'),modelSelect=this.field(grid,'Modelo'),effortSelect=this.field(grid,'Raciocínio');
  this.fill(providerSelect,available.map(id=>({value:id,label:names[id]})),pending?.provider||available[0]);
  const models=()=>this.getModels(providerSelect.value);
  const efforts=()=>{const model=models().find(m=>m.id===modelSelect.value);this.fill(effortSelect,(model?.efforts||[]).map(e=>({value:e,label:effortLabels[e]||e})),pending?.provider===providerSelect.value&&pending?.model===modelSelect.value?pending.effort:model?.defaultEffort);};
  const modelsChanged=()=>{const list=models();this.fill(modelSelect,list.map(m=>({value:m.id,label:m.name||m.id})),pending?.provider===providerSelect.value?pending.model:(list.find(m=>m.isDefault)||list[0])?.id);efforts();};
  providerSelect.addEventListener('change',modelsChanged);modelSelect.addEventListener('change',efforts);modelsChanged();
  const principal=principalField(source,providerSelect.value,pending?.principal||'a');
  providerSelect.addEventListener('change',()=>{const labels=this.dialog.querySelectorAll('.dual-principal-option');labels[1].lastChild.textContent=shortName(providerSelect.value);});
  const choice=()=>({provider:providerSelect.value,model:modelSelect.value,effort:effortSelect.value,principal:principal()});
  const start=node('button','primary-button',conversation?'Ativar Dual':'Usar no primeiro pedido');start.type='button';
  start.addEventListener('click',async()=>{
   if(!conversation){this.pending.set(this.getKey(),choice());this.dialog.close();this.changed();return;}
   start.disabled=true;try{await this.api(`/api/conversations/${conversation.id}/dual`,choice());await this.refresh();this.dialog.close();}catch(e){fail(e.message);start.disabled=false;}
  });
  actions.append(start);
  if(pending){const remove=node('button','secondary-button','Remover Dual');remove.type='button';remove.addEventListener('click',()=>{this.pending.delete(this.getKey());this.dialog.close();this.changed();});actions.append(remove);}
  this.dialog.append(error,actions);this.dialog.showModal();
 }

 /** Rounds sent to both become one question and two panels; single-recipient rounds keep normal messages. */
 organize(view,timeline,conversation){
  const record=this.anyRecord(conversation);if(!record)return;
  const articles=new Map([...view.querySelectorAll(':scope > [data-timeline-index]')].map(e=>[Number(e.dataset.timelineIndex),e]));
  const live=[];
  for(const entry of dualRounds(timeline,record)){
   const {round,parts}=entry,present=parts.filter(part=>part.user!==undefined);
   if(round.targets.length===1){
    const article=articles.get(present[0].user),header=article?.querySelector('.message-header');if(!header)continue;
    const provider=round.deliveries[round.targets[0]].provider,route=node('span','dual-route',round.write?`${shortName(provider)} · principal · implementação`:`Só para o ${shortName(provider)}`);
    if(round.write)route.dataset.write='true';route.dataset.client=provider;header.children[1]?.after(route);
    const context=[...article.querySelectorAll('details.handoff-context')].find(d=>d.querySelector('summary')?.textContent.startsWith('Contexto da passagem'));
    if(context)context.querySelector('summary').textContent=`Contexto do ${shortName(record.members[other(round.targets[0])].provider)} enviado com este pedido · ${coverageLabels[round.deliveries[round.targets[0]].coverage]||'sem registo'}`;
    continue;
   }
   const shared=articles.get(present[0].user);if(!shared)continue;
   const contexts=new Map();
   for(const part of present){
    const article=articles.get(part.user);if(!article)continue;
    contexts.set(part.key,[...article.querySelectorAll('details.handoff-context')].find(d=>d.querySelector('summary')?.textContent.startsWith('Contexto da passagem')));
    for(const index of part.users){const extra=articles.get(index);if(extra&&extra!==shared)extra.remove();}
   }
   const sharedHeader=shared.querySelector('.message-header');sharedHeader?.querySelector('.message-model')?.remove();
   if(sharedHeader?.children[1])sharedHeader.children[1].textContent='Tu · para os dois';
   const stage=node('section','review-stage dual-stage');stage.dataset.panelStage='dual';stage.panelStageId=round.id;stage.defaultFocus=null;stage.setAttribute('aria-label','Duas respostas independentes');
   const head=node('header','review-stage-head'),heading=node('div','review-stage-heading'),tools=node('div','review-stage-tools'),state=node('span','review-stage-state');state.setAttribute('role','status');
   heading.append(node('strong','review-stage-title','Duas respostas independentes'),state);head.append(heading,tools);
   stage.grid=node('div','review-grid');stage.append(head,stage.grid);
   const labels=[];let running=false;
   for(const part of parts){
    const {delivery}=part,owner=this.conversation(delivery.conversationId),turn=owner?.turns?.find(t=>t.requestId===delivery.requestId),status=dualPanelState(delivery,turn);
    const panel=this.panels.panel({key:'dual:'+round.id+':'+part.key,client:delivery.provider,title:names[delivery.provider]||delivery.provider,role:'dual'});
    panel.meta.textContent=this.modelLabel(delivery.provider,delivery);
    this.panels.status(panel,status.label,status.tone);panel.panel.dataset.live=String(status.live);panel.panel.toggleAttribute('data-attention',Boolean(status.attention));
    labels.push(`${shortName(delivery.provider)}: ${status.label}`);running||=status.live;
    const answers=part.answers.map(i=>articles.get(i)).filter(Boolean);
    answers.forEach((article,index)=>{
     if(answers.length>1)article.prepend(node('p','review-message-phase',index===answers.length-1&&!status.live?'Resposta':'Progresso'));
     const folded=article.querySelector(':scope > .message-body');if(folded)folded.hidden=false;article.classList.remove('message-folded');
     panel.body.append(article);
    });
    if(!answers.length)panel.body.append(this.panels.placeholder(delivery.error||turn?.error||owner?.error||(status.live?'A preparar a resposta…':'Sem resposta visível.')));
    else if(turn?.error&&!status.live)panel.body.append(node('p','dual-error',turn.error));
    const context=contexts.get(part.key);
    if(context){const summary=context.querySelector('summary');summary.textContent=`Contexto do ${shortName(round.deliveries[other(part.key)]?.provider||record.members[other(part.key)].provider)} enviado com este pedido · ${coverageLabels[delivery.coverage]||'sem registo'}`;panel.body.append(context);}
    const last=[...(owner?.messages||[])].reverse().find(m=>m.role==='assistant'&&m.requestId===delivery.requestId);panel.text=last?.text||'';panel.copy.hidden=!panel.text;
    panel.body.setAttribute('aria-label','Resposta de '+(names[delivery.provider]||delivery.provider));
    const items=owner?.items?.filter(i=>turn?.id&&i.turnId===turn.id)||[],latest=items.at(-1);
    if(status.live&&latest)panel.foot.append(this.panels.activity(latest.type==='reasoning'?'A analisar o pedido':latest.command||latest.title||latest.tool||latest.type,latest.status));
    if(!status.live&&delivery.status==='failed'&&record.active&&round===record.rounds.at(-1)&&round.targets.length>1&&!this.running(conversation)){
     const retry=node('button','review-panel-stop dual-retry',`Reenviar ao ${shortName(delivery.provider)}`);retry.type='button';
     retry.dataset.tip=`Envia a mesma pergunta só ao ${shortName(delivery.provider)}, sem a resposta do outro a esta ronda. O que já foi entregue não se repete.`;
     retry.addEventListener('click',async()=>{retry.disabled=true;try{await this.api('/api/dual/'+record.id+'/retry',{roundId:round.id,key:part.key});await this.refresh();}catch(e){this.toast(e.message);retry.disabled=false;}});
     panel.foot.append(retry);
    }
    if(status.live&&owner){const stop=node('button','review-panel-stop','Parar');stop.type='button';stop.dataset.tip=`Parar só o ${shortName(delivery.provider)}. O outro continua.`;stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api(`/api/conversations/${owner.id}/interrupt`,{});}catch(e){this.toast(e.message);stop.disabled=false;}});panel.foot.append(stop);}
    panel.foot.hidden=!panel.foot.childElementCount;
    stage.grid.append(panel.panel);live.push(panel.body);
   }
   state.textContent=labels.join(' · ');
   if(running&&record.active){const stop=node('button','review-stage-stop');stop.type='button';stop.append(glyph('stop','review-icon'),node('span','','Parar os dois'));stop.dataset.tip='Parar os dois modelos. O que já responderam fica guardado.';stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api('/api/dual/'+record.id+'/interrupt',{});}catch(e){this.toast(e.message);stop.disabled=false;}});tools.append(stop);}
   shared.after(stage);this.panels.applyFocus(stage);
  }
  for(const body of live)this.panels.restore(body);
 }
}
