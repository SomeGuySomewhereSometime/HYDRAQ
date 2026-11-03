import {glyph,PanelKit} from './opinions.js';

const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity',cursor:'Cursor',opencode:'OpenCode'};
const shortNames={codex:'Codex',claude:'Claude',antigravity:'Antigravity',cursor:'Cursor',opencode:'OpenCode'};
const effortLabels={default:'Automático',none:'Sem raciocínio',minimal:'Mínimo',low:'Leve',medium:'Médio',high:'Alto',xhigh:'Muito alto',max:'Máximo',ultra:'Ultra'};
const busy=new Set(['starting','running','waiting','inProgress']);
const synthesizing=job=>['queued','starting','running','stopping'].includes(job?.status);
const synthesisStates={queued:['Na fila','active'],starting:['A iniciar','active'],running:['A sintetizar','active'],stopping:['A parar','active'],completed:['Pronta','done'],failed:['Falhou','failed'],interrupted:['Parada','failed'],uncertain:['Por confirmar','failed']};
const coverageDetail=delivery=>delivery.peerCoverage?Object.entries(delivery.peerCoverage).map(([provider,coverage])=>`${shortName(provider)}: ${coverageLabels[coverage]||coverage}`).join(' · '):coverageLabels[delivery.coverage]||'sem registo';
const coverageLabels={complete:'completo',excerpt:'em excerto',summary:'resumido',partial:'parcial: respostas do terminal não importadas',none:'sem nada novo'};
import {DUAL_KEYS,memberKeys,targetKeys,allLabel} from './multi-state.js';
export {memberKeys,targetKeys};
export const isReadMode=sandbox=>['read-only','plan','ask'].includes(sandbox);
export const dualRecord=(state,group)=>state?.dual?.records?.find(record=>record.groupId===group)||null;
export const activeDual=(state,group)=>{const record=dualRecord(state,group);return record?.active?record:null;};
const others=(members,key)=>Object.keys(members).filter(k=>k!==key).map(k=>members[k]);
const otherNames=(members,key)=>others(members,key).map(m=>shortName(m.provider)).join(', ');
const shortName=provider=>shortNames[provider]||provider;
/** Who took part in a round: saved with it, so a later change of client never relabels it. */
export const roundMembers=(record,round)=>round.members||record.members;
const lockIcon=()=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','agent-pill-lock');svg.setAttribute('aria-hidden','true');svg.innerHTML='<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';return svg;};

/** Who receives the next request, named on the send button before anything is sent. */
export function dualSendLabel(record,{target=record.target,writing=false}={}){
 const selected=targetKeys(record,target);
 if(selected.length>1)return selected.length===memberKeys(record).length?`Enviar a${allLabel(selected.length)} ↗`:`Enviar a ${selected.length} de ${memberKeys(record).length} · ${selected.map(k=>shortName(record.members[k].provider)).join(' + ')} ↗`;
 target=selected[0];
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
 return {label:{failed:'Falhou',interrupted:'Parado',uncertain:'Resultado incerto'}[turn?.status]||(turn?.planDocuments?.length?'Plano recebido':'Pronta'),tone:failed?'failed':'done',live:false};
}

export class DualUI{
 constructor({api,getState,getCurrent,getKey,getProvider,getModels,memberSettings,toast,refresh,beforeChange,changed,open,applySettings,loadModels,getSyntheses=()=>[],markdown,describeWork=null,elapsed=null}){
  Object.assign(this,{api,getState,getCurrent,getKey,getProvider,getModels,memberSettings,toast,refresh,beforeChange,changed,open,applySettings,loadModels,getSyntheses,markdown,describeWork,elapsed});
  this.panels=new PanelKit({toast});this.pending=new Map();this.sequence=0;this.synthesisViews=new Map();this.thoughtsOpen=new Set();this.thoughtChoices=new Map();
  this.dialog=node('dialog','opinion-dialog dual-dialog');this.dialog.setAttribute('aria-labelledby','dual-dialog-title');document.body.append(this.dialog);
  document.getElementById('dual-toggle')?.addEventListener('click',()=>this.configure());
 }
 record(conversation=this.getCurrent()){return conversation?activeDual(this.getState(),conversation.group):null;}
 anyRecord(conversation){return conversation?dualRecord(this.getState(),conversation.group):null;}
 /** A new conversation can start dual: the choice waits for the first request. */
 pendingFor(){return this.record()?null:this.pending.get(this.getKey())||null;}
 consumePending(key){this.pending.delete(key);}
 conversation(id){return this.getState()?.conversations?.find(c=>c.id===id)||null;}
 focusProvider(conversation){const record=this.record(conversation);return record?record.members[targetKeys(record).length>1?record.principal:targetKeys(record)[0]].provider:null;}
 both(conversation){const record=this.record(conversation);return record?targetKeys(record).length>1:Boolean(this.pendingFor());}
 running(conversation){const record=this.record(conversation);return Boolean(record&&memberKeys(record).some(key=>busy.has(this.conversation(record.members[key].conversationId)?.status)));}
 /** Every recipient of the next request must be connected. */
 unavailable(conversation){
  const record=this.record(conversation);if(!record)return false;
  const keys=targetKeys(record);
  return keys.some(key=>this.getState()?.providers?.[record.members[key].provider]?.connection!=='connected');
 }
 /** Only the principal writes: a request to both, or only to the other model, goes in Planear/Só leitura. */
 readOnly(conversation){const record=this.record(conversation);return record?record.target!==record.principal:Boolean(this.pendingFor());}
 /** Images must suit every recipient, not only the model on show. */
 imagesBlocked(conversation){
  const record=this.record(conversation),pending=this.pendingFor();
  const recipients=record?(targetKeys(record)).map(key=>[record.members[key].provider,this.memberSettings(record,key)?.model]):pending?(pending.participants||[pending]).map(p=>[p.provider,p.model]):[];
  return recipients.some(([provider,model])=>this.getState()?.providers?.[provider]?.capabilities?.images===false||this.getModels(provider).find(m=>m.id===model)?.images===false);
 }
 // A synthesis's text is refreshed in place (refreshSyntheses); only its state rebuilds the transcript.
 signature(conversation){const record=this.anyRecord(conversation);return record?[record.id,record.active,record.target,record.principal,memberKeys(record).map(key=>record.members[key].conversationId),record.changes?.length||0,this.running(conversation),record.rounds.map(r=>[r.id,r.targets,r.write,r.synthesis,Object.values(r.deliveries).map(d=>[d.requestId,d.status,d.coverage,d.error,d.synthesis])]),this.syntheses(record).map(b=>[b.id,b.context,b.jobs[0]?.status,b.jobs[0]?.error,Boolean(b.jobs[0]?.text)])]:null;}
 syntheses(record){return this.getSyntheses().filter(b=>b.dualId===record?.id).sort((x,y)=>String(x.createdAt).localeCompare(String(y.createdAt)));}
 /** A synthesis meant for the next round is still being written: a round sent now goes without it. */
 pendingSynthesis(conversation){const record=this.record(conversation);return this.syntheses(record).some(b=>b.context&&synthesizing(b.jobs[0]));}
 async setTarget(target){
  const record=this.record();if(!record||this.targetBusy||JSON.stringify(record.target)===JSON.stringify(target))return;
  this.targetBusy=true;
  this.beforeChange();const previous=record.target;record.target=target;this.changed();
  try{await this.api('/api/dual/'+record.id,{target,multiVersion:2});await this.refresh();}
  catch(error){record.target=previous;this.toast(error.message);}
  finally{this.targetBusy=false;this.changed();}
 }
 /** Writing goes only to the principal: choosing it for both, or for the other model, moves the request there. */
 enforceWrite(writing){
  const record=this.record();if(!record||record.target===record.principal||!writing)return;
  this.setTarget(record.principal);
  this.toast(`A implementação vai só para o principal: ${shortName(record.members[record.principal].provider)}. O outro recebe o resultado quando voltares a falar com ele.`);
 }
 modelLabel(provider,settings){const model=this.getModels(provider).find(m=>m.id===settings?.model);return [model?.name||settings?.model,effortLabels[settings?.effort]||settings?.effort].filter(Boolean).join(' · ');}

 pendingMembers(){
  const pending=this.pendingFor();if(!pending)return null;
  return {a:{provider:this.getCurrent()?.provider||this.getProvider(),...this.memberSettings(null,'a')},...Object.fromEntries((pending.participants||[pending]).map((p,i)=>[DUAL_KEYS[i+1],p]))};
 }
 renderComposer(conversation,{locked}){
  const toggle=document.getElementById('dual-toggle'),bar=document.getElementById('dual-targets'),composer=document.getElementById('composer'),review=document.getElementById('review-toggle');
  if(!toggle||!bar)return;
  const record=this.record(conversation),pending=this.pendingFor(),members=record?.members||this.pendingMembers(),keys=members?Object.keys(members):[],pair=keys.map(k=>members[k].provider);
  toggle.textContent=members?`Multi · ${keys.length} participantes`:'Multi';toggle.setAttribute('aria-pressed',String(Boolean(members)));toggle.disabled=Boolean(locked&&!record);
  toggle.dataset.tip='Multi: dois a quatro clientes respondem de forma independente na mesma ronda. O histórico passa entre rondas; só o principal implementa.';
  if(this.selectingRecordId!==record?.id){this.selectingRecordId=record?.id;this.selectingGroup=false;}
  locked=locked||this.targetBusy;
  const selected=record?targetKeys(record):keys,principal=record?.principal||pending?.principal||'a';
  if(members)composer.dataset.dual=selected.length>1?'both':'one';else delete composer.dataset.dual;
  composer.style.setProperty('--multi-edge',pair.map((provider,i)=>`var(--c-${provider}) ${i*100/Math.max(1,pair.length-1)}%`).join(', '));
  for(const [i,key] of DUAL_KEYS.entries()){if(pair[i])composer.style.setProperty('--pair-'+key,`var(--c-${pair[i]})`);else composer.style.removeProperty('--pair-'+key);}
  if(review){review.disabled=selected.length>1;if(review.disabled)review.dataset.tip='A revisão automática segue os pedidos individuais ao principal.';}
  bar.hidden=!members;
  const signature=JSON.stringify([record?.id,selected,principal,members,locked,this.selectingGroup]);if(bar.dataset.signature===signature)return;
  bar.dataset.signature=signature;bar.replaceChildren();if(!members)return;
  const option=(value,label,provider)=>{
    const button=node('button','dual-target');button.type='button';button.dataset.target=value;if(provider)button.dataset.client=provider;
    button.setAttribute('aria-pressed',String(value==='all'?selected.length===keys.length:selected.includes(value)));
    button.textContent=label;button.disabled=locked||Boolean(pending&&value!=='all');
    button.addEventListener('click',()=>{
      if(value==='all'){this.selectingGroup=false;this.setTarget('all');return;}
      if(!this.selectingGroup){this.setTarget(value);return;}
      const next=selected.includes(value)?selected.filter(k=>k!==value):keys.filter(k=>k===value||selected.includes(k));
      if(!next.length){this.toast('Seleciona pelo menos um destinatário.');return;}
      this.setTarget(next.length===keys.length?'all':next.length===1?next[0]:next);
    });return button;
  };
  bar.append(option('all',`Todos (${keys.length})`));
  for(const key of keys){const button=option(key,`${key===principal?'★ ':''}${shortName(members[key].provider)}`,members[key].provider);button.dataset.tip=this.modelLabel(members[key].provider,record?this.memberSettings(record,key):members[key]);bar.append(button);}
  if(keys.length>2){const multi=node('button','dual-target multi-select-toggle','Selecionar vários');multi.type='button';multi.setAttribute('aria-pressed',String(Boolean(this.selectingGroup)));multi.disabled=locked||Boolean(pending);multi.addEventListener('click',()=>{this.selectingGroup=!this.selectingGroup;this.changed();});bar.append(multi);}
  bar.setAttribute('aria-label',this.selectingGroup?'Selecionar vários destinatários: cada botão junta ou retira um participante':'Destinatário: todos ou um participante');
 }

 /** A connected client with models; OpenCode's list depends on the folder and may still have to be loaded. */
 offered(id){return this.getState()?.providers?.[id]?.connection==='connected'&&(this.getModels(id).length>0||id==='opencode');}
 whenLoaded(select,list,again){
  if(list.length||!this.loadModels)return;
  const provider=select.value;
  Promise.resolve(this.loadModels(provider)).then(()=>{if(select.isConnected&&select.value===provider&&this.getModels(provider).length)again();}).catch(error=>this.toast(error.message));
 }
 /** Principal choice shared by the dialogs; the label of a member follows its client field. */
 principalChoice(members,value){
  const group=node('fieldset','dual-principal-choice'),legend=node('legend','','Principal · implementa e decide');group.append(legend);
  const radios=Object.keys(members).map(key=>{const label=node('label','dual-principal-option'),input=node('input');input.type='radio';input.name='dual-principal-'+(++this.sequence);input.value=key;input.checked=value===key;label.append(input,document.createTextNode(shortName(members[key].provider)));group.append(label);return input;});
  const name='multi-principal-'+this.sequence;for(const radio of radios)radio.name=name;
  this.dialog.append(group);
  return {value:()=>radios.find(r=>r.checked)?.value||Object.keys(members)[0],rename:(key,provider)=>{radios.find(r=>r.value===key).parentElement.lastChild.textContent=shortName(provider);},radios};
 }

 /** Atelier: in a dual the client bar shows the two participants, fixed; clicking one opens its settings. */
 renderDock(conversation){
  const dock=document.getElementById('agent-dock');if(!dock)return false;
  const record=this.record(conversation),pending=this.pendingFor();
  const pair=record?Object.fromEntries(memberKeys(record).map(k=>[k,record.members[k].provider])):pending?Object.fromEntries(Object.entries(this.pendingMembers()).map(([k,m])=>[k,m.provider])):null;
  const principal=record?.principal||pending?.principal||'a';
  dock.toggleAttribute('data-dual',Boolean(pair));
  dock.setAttribute('aria-label',pair?'Participantes do Multi':'Escolher agente ativo');
  for(const pill of dock.querySelectorAll('[data-agent]')){
   const provider=pill.dataset.agent,key=pair?DUAL_KEYS.find(k=>pair[k]===provider):null,tag=pill.querySelector('.agent-pill-tag');
   pill.dataset.tagText??=tag?.textContent||'';pill.dataset.tipText??=pill.dataset.tip||'';
   pill.hidden=Boolean(pair&&!key);
   pill.querySelector('.agent-pill-principal')?.remove();pill.querySelector('.agent-pill-lock')?.remove();
   if(!key){delete pill.dataset.dualKey;if(tag)tag.textContent=pill.dataset.tagText;pill.dataset.tip=pill.dataset.tipText;pill.removeAttribute('aria-haspopup');continue;}
   pill.dataset.dualKey=key;
   const label=this.modelLabel(provider,record?this.memberSettings(record,key):this.pendingMembers()?.[key]);
   if(tag)tag.textContent=label||pill.dataset.tagText;
   if(key===principal){const star=node('span','agent-pill-principal','★');star.setAttribute('aria-label','principal');pill.querySelector('.agent-pill-name')?.before(star);}
   pill.append(lockIcon());pill.setAttribute('aria-haspopup','dialog');
   pill.dataset.tip=`${names[provider]||provider}${key===principal?' · principal':''}${label?' · '+label:''}. Fixo no Multi: carrega para mudar modelo, raciocínio ou cliente. Quem recebe a mensagem escolhe-se no seletor da caixa.`;
  }
  return Boolean(pair);
 }
 dockClick(provider){
  const conversation=this.getCurrent(),record=this.record(conversation);
  if(record){const key=memberKeys(record).find(k=>record.members[k].provider===provider);if(key)this.editMember(key);return true;}
  if(this.pendingFor()){this.configure();return true;}
  return false;
 }
 /** The composer's client field, while talking to one model: replaces that participant, asked first. */
 chooseClient(provider){
  const record=this.record();if(!record)return;
  const key=targetKeys(record).length>1?record.principal:targetKeys(record)[0];
  if(record.members[key].provider===provider)return;
  if(others(record.members,key).some(m=>m.provider===provider)){this.toast(`O ${shortName(provider)} já participa neste Multi. Para falar só com ele, escolhe-o no seletor.`);return;}
  if(!this.offered(provider)){this.toast(`Liga primeiro o ${shortName(provider)} para o pôr no Multi.`);return;}
  this.editMember(key,provider);
 }
 /** One participant: model and reasoning, or another client in its place. The dual stays on and nothing is sent. */
 editMember(key,wanted){
  const conversation=this.getCurrent(),record=this.record(conversation);if(!record)return;
  const member=record.members[key],kept=others(record.members,key),settings=this.memberSettings(record,key),state=this.getState();
  this.header(`Multi · ${names[member.provider]||member.provider}`);
  this.dialog.append(node('p','opinion-caption','Muda o modelo e o raciocínio deste participante, ou põe outro cliente no seu lugar. O Multi continua ligado e nada é enviado. As respostas anteriores mantêm quem as deu; um cliente novo recebe o histórico da conversa no primeiro pedido.'));
  const error=node('p','opinion-error');error.hidden=true;error.setAttribute('role','alert');
  const fail=message=>{error.textContent=message;error.hidden=false;};
  // The server repeats these checks; here they explain why the client cannot change right now.
  const terminal=state?.nativeSessions?.sessions?.some(s=>s.group===record.groupId)||state?.conversations?.some(c=>c.group===record.groupId&&c.terminal);
  const blocked=this.running(conversation)||record.rounds.some(r=>r.targets.some(k=>['preparing','sending'].includes(r.deliveries[k].status)))?'Aguarda que as respostas terminem para mudar de cliente.':terminal?'A conversa está no terminal. Usa «Continuar na HYDRAQ» antes de mudar de cliente ou de principal.':'';
  const grid=node('div','dual-choice');this.dialog.append(grid);
  const providerSelect=this.field(grid,'Cliente'),modelSelect=this.field(grid,'Modelo'),effortSelect=this.field(grid,'Raciocínio');
  const available=Object.keys(names).filter(id=>!kept.some(m=>m.provider===id)&&(id===member.provider||this.offered(id)));
  this.fill(providerSelect,available.map(id=>({value:id,label:names[id]})),!blocked&&available.includes(wanted)?wanted:member.provider);
  providerSelect.disabled=Boolean(blocked);
  const same=()=>providerSelect.value===member.provider,models=()=>this.getModels(providerSelect.value);
  const efforts=()=>{const model=models().find(m=>m.id===modelSelect.value);this.fill(effortSelect,(model?.efforts||[]).map(e=>({value:e,label:effortLabels[e]||e})),same()&&settings?.model===modelSelect.value?settings.effort:model?.defaultEffort);};
  const modelsChanged=()=>{const list=models();this.fill(modelSelect,list.map(m=>({value:m.id,label:m.name||m.id})),same()?settings?.model:(list.find(m=>m.isDefault)||list[0])?.id);efforts();this.whenLoaded(providerSelect,list,modelsChanged);};
  modelSelect.addEventListener('change',efforts);modelsChanged();
  const note=node('p','dual-summary dual-replace-note');note.setAttribute('role','status');
  const principal=this.principalChoice(record.members,record.principal);
  if(terminal)for(const radio of principal.radios)radio.disabled=true;
  const describe=()=>{
   principal.rename(key,providerSelect.value);
   const incoming=shortName(providerSelect.value),leaving=shortName(member.provider);
   note.hidden=same()&&!blocked;
   note.textContent=blocked||(same()?'':`O ${incoming} entra no lugar do ${leaving}${principal.value()===key?' e fica como principal: implementa quando escolheres escrita':''}. O ${leaving} fica guardado como conversa do grupo.`);
  };
  providerSelect.addEventListener('change',()=>{modelsChanged();describe();});
  for(const radio of principal.radios)radio.addEventListener('change',describe);
  describe();grid.after(note);
  const actions=node('div','opinion-actions'),save=node('button','primary-button','Guardar'),cancel=node('button','secondary-button','Cancelar');
  save.type=cancel.type='button';cancel.addEventListener('click',()=>this.dialog.close());
  save.addEventListener('click',async()=>{
   save.disabled=true;
   const choice={model:modelSelect.value,effort:effortSelect.value},chosen=principal.value();
   try{
    if(same()){
     this.applySettings?.(member.provider,choice);
     await this.api('/api/dual/'+record.id,{multiVersion:2,members:{[key]:{...settings,...choice}},...(chosen!==record.principal?{principal:chosen}:{})});
     await this.refresh();
    }else{
     const result=await this.api('/api/dual/'+record.id+'/replace',{multiVersion:2,key,provider:providerSelect.value,...choice,principal:chosen});
     this.applySettings?.(providerSelect.value,choice);
     await this.refresh();
     // The conversation on show follows the participant: the same group and history, now with the new client.
     if(this.getCurrent()?.id===member.conversationId&&this.conversation(result.conversationId))this.open?.(result.conversationId);
     this.toast(`${shortName(providerSelect.value)} entrou no lugar do ${shortName(member.provider)}. Recebe o histórico da conversa no primeiro pedido.`);
    }
    this.changed();this.dialog.close();
   }catch(e){fail(e.message);save.disabled=false;}
  });
  actions.append(save,cancel);this.dialog.append(error,actions);this.dialog.showModal();
 }

 field(parent,label,tag='select'){const wrap=node('label','opinion-field',label),control=node(tag);control.id='dual-control-'+(++this.sequence);wrap.htmlFor=control.id;wrap.append(control);parent.append(wrap);return control;}
 fill(select,values,value){select.replaceChildren(...values.map(v=>{const option=node('option','',v.label);option.value=v.value;return option;}));select.value=values.some(v=>v.value===value)?value:values[0]?.value||'';}
 header(title){
  this.dialog.replaceChildren();const heading=node('div','opinion-dialog-heading'),close=node('button','secondary-button','Fechar');close.type='button';close.addEventListener('click',()=>this.dialog.close());
  const h=node('h2','',title);h.id='dual-dialog-title';heading.append(h,close);this.dialog.append(heading);
 }
 participantFields(parent,choice={},excluded=[]){
  const grid=node('div','dual-choice multi-member-fields');parent.append(grid);
  const provider=this.field(grid,'Cliente'),model=this.field(grid,'Modelo'),effort=this.field(grid,'Raciocínio');
  const available=Object.keys(names).filter(id=>!excluded.includes(id)&&(id===choice.provider||this.offered(id)));
  this.fill(provider,available.map(id=>({value:id,label:names[id]})),choice.provider);
  const efforts=()=>{const entry=this.getModels(provider.value).find(m=>m.id===model.value);this.fill(effort,(entry?.efforts||[]).map(e=>({value:e,label:effortLabels[e]||e})),choice.provider===provider.value&&choice.model===model.value?choice.effort:entry?.defaultEffort);};
  const models=()=>{const list=this.getModels(provider.value);this.fill(model,list.map(m=>({value:m.id,label:m.name||m.id})),choice.provider===provider.value?choice.model:(list.find(m=>m.isDefault)||list[0])?.id);efforts();this.whenLoaded(provider,list,models);};
  provider.addEventListener('change',models);model.addEventListener('change',efforts);models();
  return {provider,model,effort,value:()=>({provider:provider.value,model:model.value,effort:effort.value})};
 }
 addMember(){
  const record=this.record();if(!record)return;
  this.header('Multi · adicionar participante');
  const fields=this.participantFields(this.dialog,{},memberKeys(record).map(k=>record.members[k].provider));
  const error=node('p','opinion-error'),save=node('button','primary-button','Adicionar participante'),requestId=crypto.randomUUID();save.type='button';
  save.addEventListener('click',async()=>{save.disabled=true;try{await this.api('/api/dual/'+record.id+'/add',{...fields.value(),revision:record.revision||0,requestId,multiVersion:2});await this.refresh();this.configure();}catch(e){error.textContent=e.message;save.disabled=false;}});
  this.dialog.append(error,save);this.dialog.showModal();
 }
 configure(){
  const conversation=this.getCurrent(),record=this.record(conversation),pending=this.pendingFor(),source=conversation?.provider||this.getProvider();
  this.header('Multi · dois a quatro participantes');
  this.dialog.append(node('p','opinion-caption','Cada cliente responde de forma independente na mesma ronda. Entre rondas, recebe o histórico dos restantes, com excertos assinalados quando necessário. Só o principal implementa.'));
  const error=node('p','opinion-error');error.setAttribute('role','alert');
  const fail=e=>{error.textContent=e.message;};
  if(record){
    const principal=this.principalChoice(record.members,record.principal),list=node('div','multi-member-list');this.dialog.append(list);
    const blocked=this.running(conversation)||Boolean(conversation?.claudexTask)||this.getState()?.conversations?.some(c=>c.group===record.groupId&&c.terminal);
    for(const key of memberKeys(record)){
      const member=record.members[key],row=node('div','multi-member-row');row.dataset.client=member.provider;
      row.append(node('strong','',shortName(member.provider)),node('small','',this.modelLabel(member.provider,this.memberSettings(record,key))));
      const edit=node('button','secondary-button','Mudar…');edit.type='button';edit.disabled=blocked;edit.addEventListener('click',()=>this.editMember(key));row.append(edit);
      if(memberKeys(record).length>2){const remove=node('button','secondary-button','Remover');remove.type='button';remove.disabled=blocked;const requestId=crypto.randomUUID();remove.addEventListener('click',async()=>{remove.disabled=true;try{await this.api('/api/dual/'+record.id+'/remove',{key,principal:principal.value(),revision:record.revision||0,requestId,multiVersion:2});await this.refresh();this.configure();}catch(e){fail(e);remove.disabled=false;}});row.append(remove);}
      list.append(row);
    }
    this.dialog.append(node('p','opinion-caption','Para remover o principal, seleciona primeiro a estrela de outro participante.'));
    const actions=node('div','opinion-actions');
    if(memberKeys(record).length<4){const add=node('button','secondary-button','＋ Adicionar participante');add.type='button';add.disabled=blocked;add.addEventListener('click',()=>this.addMember());actions.append(add);}
    const save=node('button','primary-button','Guardar'),end=node('button','secondary-button','Desligar Multi');save.type=end.type='button';save.disabled=end.disabled=blocked;
    save.addEventListener('click',async()=>{save.disabled=true;try{await this.api('/api/dual/'+record.id,{principal:principal.value(),multiVersion:2});await this.refresh();this.dialog.close();}catch(e){fail(e);save.disabled=false;}});
    end.addEventListener('click',async()=>{end.disabled=true;try{await this.api('/api/dual/'+record.id+'/end',{});await this.refresh();this.dialog.close();this.open?.(record.members[record.principal].conversationId);}catch(e){fail(e);end.disabled=false;}});
    actions.append(save,end);this.dialog.append(error,actions);this.dialog.showModal();return;
  }
  const available=Object.keys(names).filter(id=>id!==source&&this.offered(id));
  if(!available.length){this.dialog.append(node('p','opinion-caption','Liga primeiro outro cliente para ativar o Multi.'));this.dialog.showModal();return;}
  let choices=structuredClone(pending?.participants||[pending||{provider:available[0]}]),chosen=pending?.principal||'a';
  const content=node('div','multi-start');this.dialog.append(content);
  const draw=()=>{
    content.replaceChildren();content.append(node('p','dual-summary',`${shortName(source)} · mantém a sessão desta conversa`));
    const fields=choices.map((choice,i)=>{const row=node('div','multi-member-row');content.append(row);const fields=this.participantFields(row,choice,[source,...choices.filter((_,j)=>j!==i).map(p=>p.provider)]);if(choices.length>1){const remove=node('button','secondary-button','Remover');remove.type='button';remove.addEventListener('click',()=>{choices=read().filter((_,j)=>j!==i);chosen='a';draw();});row.append(remove);}return fields;});
    const read=()=>fields.map(f=>f.value());
    const roster={a:{provider:source},...Object.fromEntries(fields.map((f,i)=>[DUAL_KEYS[i+1],f.value()]))};
    const principal=this.principalChoice(roster,chosen);content.append(principal.radios[0].closest('fieldset'));
    for(const [i,field] of fields.entries())field.provider.addEventListener('change',()=>{choices=read();chosen=principal.value();draw();});
    const actions=node('div','opinion-actions');
    if(fields.length<3&&available.length>fields.length){const add=node('button','secondary-button','＋ Adicionar participante');add.type='button';add.addEventListener('click',()=>{choices=read();chosen=principal.value();choices.push({provider:available.find(id=>!choices.some(c=>c.provider===id))});draw();});actions.append(add);}
    const start=node('button','primary-button',conversation?'Ativar Multi':'Usar no primeiro pedido');start.type='button';
    start.addEventListener('click',async()=>{const choice={participants:read(),principal:principal.value(),multiVersion:2};if(!conversation){this.pending.set(this.getKey(),choice);this.dialog.close();this.changed();return;}start.disabled=true;try{await this.api(`/api/conversations/${conversation.id}/dual`,choice);await this.refresh();this.dialog.close();}catch(e){fail(e);start.disabled=false;}});
    actions.append(start);
    if(pending){const remove=node('button','secondary-button','Remover Multi');remove.type='button';remove.addEventListener('click',()=>{this.pending.delete(this.getKey());this.dialog.close();this.changed();});actions.append(remove);}
    content.append(actions);
  };draw();this.dialog.append(error);this.dialog.showModal();
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
    if(context)context.querySelector('summary').textContent=`Contexto do ${otherNames(roundMembers(record,round),round.targets[0])} enviado com este pedido · ${coverageDetail(round.deliveries[round.targets[0]])}`;
    continue;
   }
   const shared=articles.get(present[0].user);if(!shared)continue;
   shared.dataset.progressRequests=JSON.stringify(present.map(part=>articles.get(part.user)).filter(Boolean).map(article=>[article.dataset.ownerId,article.dataset.turnId]));
   const contexts=new Map();
   for(const part of present){
    const article=articles.get(part.user);if(!article)continue;
    contexts.set(part.key,[...article.querySelectorAll('details.handoff-context')].find(d=>d.querySelector('summary')?.textContent.startsWith('Contexto da passagem')));
    for(const index of part.users){const extra=articles.get(index);if(extra&&extra!==shared)extra.remove();}
   }
   const sharedHeader=shared.querySelector('.message-header');sharedHeader?.querySelector('.message-model')?.remove();
   if(sharedHeader?.children[1])sharedHeader.children[1].textContent=`Tu · para ${allLabel(round.targets.length)}`;
   const stage=node('section','review-stage dual-stage');stage.dataset.panelStage='dual';stage.panelStageId=round.id;stage.defaultFocus=null;stage.setAttribute('aria-label',`${round.targets.length} respostas independentes`);
   const head=node('header','review-stage-head'),heading=node('div','review-stage-heading'),tools=node('div','review-stage-tools'),state=node('span','review-stage-state');state.setAttribute('role','status');
   heading.append(node('strong','review-stage-title',`${round.targets.length} respostas independentes`),state);head.append(heading,tools);
   stage.grid=node('div','review-grid');stage.grid.dataset.participants=String(round.targets.length);stage.append(head,stage.grid);
   const labels=[],outcomes=[];let running=false;
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
    if(context){const summary=context.querySelector('summary');summary.textContent=`Contexto do ${otherNames(roundMembers(record,round),part.key)} enviado com este pedido · ${coverageDetail(delivery)}`;panel.body.append(context);}
    const last=[...(owner?.messages||[])].reverse().find(m=>m.role==='assistant'&&m.requestId===delivery.requestId);panel.text=last?.text||'';panel.copy.hidden=!panel.text;
    panel.body.setAttribute('aria-label','Resposta de '+(names[delivery.provider]||delivery.provider));
    const items=owner?.items?.filter(i=>turn?.id&&i.turnId===turn.id)||[],latest=items.at(-1),work=owner&&turn?this.describeWork?.(owner,turn):null;
    // What each one is doing now, every action at once with its time; at the end, what the answer took.
    if(work){if(status.live)for(const line of work.now){const entry=this.panels.activity(line.text,'inProgress');if(line.since&&this.elapsed)entry.append(document.createTextNode(' · '),this.elapsed(line.since));panel.foot.append(entry);}else if(work.summary)panel.foot.append(node('span','dual-work-summary',work.summary));}
    else if(status.live&&latest)panel.foot.append(this.panels.activity(latest.type==='reasoning'?'A analisar o pedido':latest.command||latest.title||latest.tool||latest.type,latest.status));
    if(work?.thought){
     // agy and Cursor: open while it works, closed at the answer; a click counts for this request and phase.
     const detail=node('details','claude-thought'),heading=node('summary','',work.thoughtLabel||'Resumo do raciocínio · Claude'),choice=this.thoughtChoices.get(panel.key);
     detail.open=work.thoughtOpen?work.thoughtOpen(status.live,choice?.turn===turn?.id?choice:null,this.thoughtsOpen.has(panel.key)):this.thoughtsOpen.has(panel.key);
     heading.addEventListener('click',()=>this.thoughtChoices.set(panel.key,{turn:turn?.id,live:status.live,open:!detail.open}));
     detail.addEventListener('toggle',()=>{if(detail.isConnected){if(detail.open)this.thoughtsOpen.add(panel.key);else this.thoughtsOpen.delete(panel.key);}});detail.append(heading,node('div','claude-thought-text',work.thought));panel.foot.append(detail);
    }
    if(!status.live&&delivery.status==='failed'&&record.active&&round===record.rounds.at(-1)&&round.targets.length>1&&round.targets.every(k=>round.deliveries[k].conversationId===record.members[k]?.conversationId)&&!this.running(conversation)){
     const retry=node('button','review-panel-stop dual-retry',`Reenviar ao ${shortName(delivery.provider)}`);retry.type='button';
     retry.dataset.tip=`Envia a mesma pergunta só ao ${shortName(delivery.provider)}, sem a resposta do outro a esta ronda. O que já foi entregue não se repete.`;
     retry.addEventListener('click',async()=>{retry.disabled=true;try{await this.api('/api/dual/'+record.id+'/retry',{roundId:round.id,key:part.key});await this.refresh();}catch(e){this.toast(e.message);retry.disabled=false;}});
     panel.foot.append(retry);
    }
    if(status.live&&owner){const stop=node('button','review-panel-stop','Parar');stop.type='button';stop.dataset.tip=`Parar só o ${shortName(delivery.provider)}. Os restantes continuam.`;stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api(`/api/conversations/${owner.id}/interrupt`,{});}catch(e){this.toast(e.message);stop.disabled=false;}});panel.foot.append(stop);}
    panel.foot.hidden=!panel.foot.childElementCount;
    stage.grid.append(panel.panel);live.push(panel.body);
    outcomes.push({key:part.key,provider:delivery.provider,done:turn?.status==='completed'&&!status.live,live:status.live});
   }
   state.textContent=labels.join(' · ');
   const synthesis=this.synthesisSection(record,round,outcomes);if(synthesis)stage.append(synthesis);
   if(running&&record.active){const stop=node('button','review-stage-stop');stop.type='button';stop.append(glyph('stop','review-icon'),node('span','','Parar todos'));stop.dataset.tip='Parar todos os modelos. O que já responderam fica guardado.';stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api('/api/dual/'+record.id+'/interrupt',{});}catch(e){this.toast(e.message);stop.disabled=false;}});tools.append(stop);}
   shared.after(stage);this.panels.applyFocus(stage);
  }
  // A change of client is marked where it happened; the answers before it keep their own names.
  for(const change of record.changes||[]){
   const marker=node('div','provider-divider dual-change',change.to&&change.from?`${shortName(change.to.provider)} entrou no lugar do ${shortName(change.from.provider)}`:change.to?`${shortName(change.to.provider)} entrou na conversa`:`${shortName(change.from.provider)} saiu da conversa`);
   marker.dataset.client=(change.to||change.from).provider;
   const next=[...view.querySelectorAll(':scope > [data-timeline-index]')].find(article=>timeline[Number(article.dataset.timelineIndex)]?.message.at>change.at);
   if(next)next.before(marker);else view.append(marker);
  }
  for(const body of live)this.panels.restore(body);
 }

 /**
  * Under the two answers of a round: its newest synthesis, the earlier ones folded, and the button to ask for one.
  * With one answer missing, the button asks for a partial synthesis, named as such; the retry stays in the failed panel.
  */
 synthesisSection(record,round,outcomes){
  const batches=this.syntheses(record).filter(b=>b.roundId===round.id),done=outcomes.filter(o=>o.done),missing=outcomes.find(o=>!o.done);
  const section=node('section','dual-synthesis');section.dataset.round=round.id;
  const head=node('div','dual-synthesis-head');section.append(head);
  if(!outcomes.some(o=>o.live)&&done.length){
   const partial=done.length<outcomes.length,running=batches.some(b=>synthesizing(b.jobs[0]));
   const ask=node('button','secondary-button dual-synthesis-ask',partial?`Síntese parcial · com ${done.length} de ${outcomes.length} respostas…`:batches.length?'Outra síntese…':'Sintetizar…');ask.type='button';
   ask.disabled=running;
   ask.dataset.tip=running?'Aguarda a síntese em curso ou para-a.':partial?`Faltam respostas de ${outcomes.filter(o=>!o.done).map(o=>shortName(o.provider)).join(', ')}. A síntese parcial identifica as ausências.`:'Um modelo à tua escolha escreve uma resposta final a partir das respostas, numa sessão à parte.';
   ask.addEventListener('click',()=>this.synthesisDialog(record,round,partial));
   head.append(ask);
  }
  // An automatic synthesis marked on its round but with no record: a restart came in between; nothing is started again.
  if(round.synthesis&&!batches.some(b=>b.requestId===round.synthesis.requestId))head.append(node('p','dual-synthesis-note',round.synthesis.error?`A síntese automática não arrancou: ${round.synthesis.error}`:'A síntese automática desta ronda não ficou confirmada e não foi repetida. Podes pedi-la aqui.'));
  const latest=batches.at(-1);
  if(latest)section.append(this.synthesisPanel(record,latest));
  if(batches.length>1){const older=node('details','dual-synthesis-older');older.append(node('summary','',`Sínteses anteriores desta ronda · ${batches.length-1}`));for(const batch of batches.slice(0,-1).reverse())older.append(this.synthesisPanel(record,batch));section.append(older);}
  return head.childElementCount||batches.length?section:null;
 }
 synthesisPanel(record,batch){
  const job=batch.jobs[0],[label,tone]=synthesisStates[job.status]||[job.status,'failed'];
  const view=this.panels.panel({key:'synthesis:'+batch.id,client:job.provider,title:'Síntese · '+(shortNames[job.provider]||job.provider),role:'synthesis'});
  view.panel.dataset.synthesis=batch.id;view.panel.dataset.live=String(synthesizing(job));view.expand.hidden=true;
  view.meta.textContent=[this.modelLabel(job.provider,job),batch.automatic?'automática':null].filter(Boolean).join(' · ');
  this.panels.status(view,label,tone);
  this.fillSynthesis(view,batch);
  const notes=[...(batch.missing?.length?[`Parcial: faltam respostas de ${batch.missing.map(k=>shortName(batch.sources?.find(s=>s.key===k)?.provider)).join(', ')}.`]:[]),
   batch.context?`Contexto entregue a ${new Set(record.rounds.flatMap(r=>Object.values(r.deliveries)).filter(d=>d.synthesis===batch.id&&['sent','uncertain'].includes(d.status)).map(d=>d.conversationId)).size} sessões; segue uma vez para cada participante que ainda não recebeu.`:'Não entra no contexto dos participantes.',...(batch.warnings||[])];
  for(const text of notes)view.foot.append(node('span','dual-synthesis-detail',text));
  if(job.error&&!synthesizing(job))view.foot.append(node('p','dual-error',job.error));
  if(synthesizing(job)){const stop=node('button','review-panel-stop','Parar');stop.type='button';stop.dataset.tip='Parar a síntese. As respostas dos participantes não mudam.';stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api('/api/opinions/'+job.id+'/stop',{});}catch(e){this.toast(e.message);stop.disabled=false;}});view.foot.append(stop);}
  view.foot.hidden=false;
  this.synthesisViews.set(batch.id,view);
  return view.panel;
 }
 fillSynthesis(view,batch){
  const job=batch.jobs[0];view.text=job.text||'';view.copy.hidden=!view.text;view.shown=view.text;
  view.body.replaceChildren(view.text?this.markdown(view.text):this.panels.placeholder(job.error||(synthesizing(job)?'A preparar a síntese…':'Sem texto.')));
  view.body.setAttribute('aria-label','Síntese');this.panels.restore(view.body);
 }
 /** New text of a synthesis being written, without rebuilding the conversation. */
 refreshSyntheses(){
  for(const [id,view] of this.synthesisViews){
   if(!view.panel.isConnected){this.synthesisViews.delete(id);continue;}
   const batch=this.getSyntheses().find(b=>b.id===id);if(batch&&(batch.jobs[0].text||'')!==view.shown)this.fillSynthesis(view,batch);
  }
 }
 /**
  * Who writes the synthesis, instructions, whether it goes to the next round, and automatic for the rounds to come.
  * Without a round it only saves the choices.
  */
 synthesisDialog(record,round=null,partial=false){
  const saved=record.synthesis||{},member=key=>({provider:record.members[key].provider,...this.memberSettings(record,key)});
  this.header(round?(partial?'Síntese parcial':'Sintetizar as respostas'):'Síntese do Multi');
  this.dialog.append(node('p','opinion-caption',(round?'Um modelo escreve uma resposta final a partir das respostas, numa sessão à parte. As sessões do Multi não a veem, a não ser que a mandes para a próxima ronda.':'Quem sintetiza, e se a síntese corre sozinha no fim de cada ronda enviada a vários.')+(partial?' Faltam respostas nesta ronda: a síntese identifica todas as ausências.':'')));
  const error=node('p','opinion-error');error.hidden=true;error.setAttribute('role','alert');
  const grid=node('div','dual-choice');this.dialog.append(grid);
  const who=this.field(grid,'Quem sintetiza'),providerSelect=this.field(grid,'Cliente'),modelSelect=this.field(grid,'Modelo'),effortSelect=this.field(grid,'Raciocínio');
  const same=key=>saved.provider===record.members[key].provider&&saved.model===member(key).model;
  this.fill(who,[...memberKeys(record).map(key=>({value:key,label:`${shortName(record.members[key].provider)} · ${this.modelLabel(record.members[key].provider,member(key))}`})),{value:'other',label:'Outro modelo…'}],memberKeys(record).find(same)||(saved.provider?'other':record.principal));
  const available=Object.keys(names).filter(id=>this.offered(id));
  this.fill(providerSelect,available.map(id=>({value:id,label:names[id]})),available.includes(saved.provider)?saved.provider:available[0]);
  const models=()=>this.getModels(providerSelect.value);
  const efforts=()=>{const model=models().find(m=>m.id===modelSelect.value);this.fill(effortSelect,(model?.efforts||[]).map(e=>({value:e,label:effortLabels[e]||e})),saved.provider===providerSelect.value&&saved.model===modelSelect.value?saved.effort:model?.defaultEffort);};
  const modelsChanged=()=>{const list=models();this.fill(modelSelect,list.map(m=>({value:m.id,label:m.name||m.id})),saved.provider===providerSelect.value?saved.model:(list.find(m=>m.isDefault)||list[0])?.id);efforts();this.whenLoaded(providerSelect,list,modelsChanged);};
  providerSelect.addEventListener('change',modelsChanged);modelSelect.addEventListener('change',efforts);modelsChanged();
  const other=()=>{for(const select of [providerSelect,modelSelect,effortSelect])select.parentElement.hidden=who.value!=='other';};who.addEventListener('change',other);other();
  const instructions=this.field(this.dialog,'Instruções opcionais','textarea');instructions.rows=2;instructions.placeholder='Ex.: junta tudo sem descartar nada; foca a segurança.';instructions.value=saved.instructions||'';
  const check=(text,value,tip)=>{const label=node('label','dual-synthesis-option'),input=node('input');input.type='checkbox';input.checked=Boolean(value);label.append(input,document.createTextNode(text));label.dataset.tip=tip;this.dialog.append(label);return input;};
  const context=check('Entra no contexto da ronda seguinte',saved.context,'Desligado: só tu vês a síntese. Ligado: na próxima ronda, cada participante recebe-a uma vez, como contexto citado.');
  const auto=check('Fazer automaticamente no fim de cada ronda a vários',saved.auto,'Corre sozinha quando todas as respostas terminam, com estas escolhas. Não corre se faltar uma resposta.');
  const actions=node('div','opinion-actions'),submit=node('button','primary-button',round?(partial?'Pedir síntese parcial':'Sintetizar'):'Guardar'),cancel=node('button','secondary-button','Cancelar');
  submit.type=cancel.type='button';cancel.addEventListener('click',()=>this.dialog.close());
  const requestId=crypto.randomUUID();
  submit.addEventListener('click',async()=>{
   submit.disabled=true;
   const choice=who.value==='other'?{provider:providerSelect.value,model:modelSelect.value,effort:effortSelect.value}:(({provider,model,effort})=>({provider,model,effort}))(member(who.value));
   try{
    await this.api('/api/dual/'+record.id+'/synthesis-settings',{auto:auto.checked,context:context.checked,...choice,instructions:instructions.value});
    if(round)await this.api('/api/dual/'+record.id+'/synthesis',{roundId:round.id,requestId,...choice,instructions:instructions.value,context:context.checked,partial});
    await this.refresh();this.dialog.close();
   }catch(e){error.textContent=e.message;error.hidden=false;submit.disabled=false;}
  });
  actions.append(submit,cancel);this.dialog.append(error,actions);this.dialog.showModal();
 }
}
