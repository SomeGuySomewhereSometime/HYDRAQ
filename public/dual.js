import {glyph,PanelKit} from './opinions.js';

const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity',cursor:'Cursor',opencode:'OpenCode'};
const shortNames={codex:'Codex',claude:'Claude',antigravity:'Antigravity',cursor:'Cursor',opencode:'OpenCode'};
const effortLabels={default:'Automático',none:'Sem raciocínio',minimal:'Mínimo',low:'Leve',medium:'Médio',high:'Alto',xhigh:'Muito alto',max:'Máximo',ultra:'Ultra'};
const busy=new Set(['starting','running','waiting','inProgress']);
const synthesizing=job=>['queued','starting','running','stopping'].includes(job?.status);
const synthesisStates={queued:['Na fila','active'],starting:['A iniciar','active'],running:['A sintetizar','active'],stopping:['A parar','active'],completed:['Pronta','done'],failed:['Falhou','failed'],interrupted:['Parada','failed'],uncertain:['Por confirmar','failed']};
const coverageLabels={complete:'completo',excerpt:'em excerto',summary:'resumido',partial:'parcial: respostas do terminal não importadas',none:'sem nada novo'};
export const DUAL_KEYS=['a','b'];
export const isReadMode=sandbox=>['read-only','plan','ask'].includes(sandbox);
export const dualRecord=(state,group)=>state?.dual?.records?.find(record=>record.groupId===group)||null;
export const activeDual=(state,group)=>{const record=dualRecord(state,group);return record?.active?record:null;};
const other=key=>key==='a'?'b':'a';
const shortName=provider=>shortNames[provider]||provider;
/** Who took part in a round: saved with it, so a later change of client never relabels it. */
export const roundMembers=(record,round)=>round.members||record.members;
const lockIcon=()=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','agent-pill-lock');svg.setAttribute('aria-hidden','true');svg.innerHTML='<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';return svg;};

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
 constructor({api,getState,getCurrent,getKey,getProvider,getModels,memberSettings,toast,refresh,beforeChange,changed,open,applySettings,loadModels,getSyntheses=()=>[],markdown,describeWork=null,elapsed=null}){
  Object.assign(this,{api,getState,getCurrent,getKey,getProvider,getModels,memberSettings,toast,refresh,beforeChange,changed,open,applySettings,loadModels,getSyntheses,markdown,describeWork,elapsed});
  this.panels=new PanelKit({toast});this.pending=new Map();this.sequence=0;this.synthesisViews=new Map();this.thoughtsOpen=new Set();
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
 // A synthesis's text is refreshed in place (refreshSyntheses); only its state rebuilds the transcript.
 signature(conversation){const record=this.anyRecord(conversation);return record?[record.id,record.active,record.target,record.principal,DUAL_KEYS.map(key=>record.members[key].conversationId),record.changes?.length||0,this.running(conversation),record.rounds.map(r=>[r.id,r.targets,r.write,r.synthesis,Object.values(r.deliveries).map(d=>[d.requestId,d.status,d.coverage,d.error,d.synthesis])]),this.syntheses(record).map(b=>[b.id,b.context,b.jobs[0]?.status,b.jobs[0]?.error,Boolean(b.jobs[0]?.text)])]:null;}
 syntheses(record){return this.getSyntheses().filter(b=>b.dualId===record?.id).sort((x,y)=>String(x.createdAt).localeCompare(String(y.createdAt)));}
 /** A synthesis meant for the next round is still being written: a round sent now goes without it. */
 pendingSynthesis(conversation){const record=this.record(conversation);return this.syntheses(record).some(b=>b.context&&synthesizing(b.jobs[0]));}
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
  // The two participants' colours, quietly, on the composer's edge.
  for(const [index,name] of ['--pair-a','--pair-b'].entries()){if(pair)composer.style.setProperty(name,`var(--c-${pair[index]})`);else composer.style.removeProperty(name);}
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

 /** A connected client with models; OpenCode's list depends on the folder and may still have to be loaded. */
 offered(id){return this.getState()?.providers?.[id]?.connection==='connected'&&(this.getModels(id).length>0||id==='opencode');}
 whenLoaded(select,list,again){
  if(list.length||!this.loadModels)return;
  const provider=select.value;
  Promise.resolve(this.loadModels(provider)).then(()=>{if(select.isConnected&&select.value===provider&&this.getModels(provider).length)again();}).catch(error=>this.toast(error.message));
 }
 /** Principal choice shared by the dialogs; the label of a member follows its client field. */
 principalChoice(a,b,value){
  const group=node('fieldset','dual-principal-choice'),legend=node('legend','','Principal · implementa e decide');group.append(legend);
  const radios=['a','b'].map(key=>{const label=node('label','dual-principal-option'),input=node('input');input.type='radio';input.name='dual-principal-'+this.sequence;input.value=key;input.checked=value===key;label.append(input,document.createTextNode(shortName(key==='a'?a:b)));group.append(label);return input;});
  this.dialog.append(group);
  return {value:()=>radios.find(r=>r.checked)?.value||'a',rename:(key,provider)=>{radios[key==='a'?0:1].parentElement.lastChild.textContent=shortName(provider);},radios};
 }

 /** Atelier: in a dual the client bar shows the two participants, fixed; clicking one opens its settings. */
 renderDock(conversation){
  const dock=document.getElementById('agent-dock');if(!dock)return false;
  const record=this.record(conversation),pending=this.pendingFor();
  const pair=record?{a:record.members.a.provider,b:record.members.b.provider}:pending?{a:conversation?.provider||this.getProvider(),b:pending.provider}:null;
  const principal=record?.principal||pending?.principal||'a';
  dock.toggleAttribute('data-dual',Boolean(pair));
  dock.setAttribute('aria-label',pair?'Participantes do Dual':'Escolher agente ativo');
  for(const pill of dock.querySelectorAll('[data-agent]')){
   const provider=pill.dataset.agent,key=pair?DUAL_KEYS.find(k=>pair[k]===provider):null,tag=pill.querySelector('.agent-pill-tag');
   pill.dataset.tagText??=tag?.textContent||'';pill.dataset.tipText??=pill.dataset.tip||'';
   pill.hidden=Boolean(pair&&!key);
   pill.querySelector('.agent-pill-principal')?.remove();pill.querySelector('.agent-pill-lock')?.remove();
   if(!key){delete pill.dataset.dualKey;if(tag)tag.textContent=pill.dataset.tagText;pill.dataset.tip=pill.dataset.tipText;pill.removeAttribute('aria-haspopup');continue;}
   pill.dataset.dualKey=key;
   const label=this.modelLabel(provider,record?this.memberSettings(record,key):key==='a'?this.memberSettings(null,'a'):pending);
   if(tag)tag.textContent=label||pill.dataset.tagText;
   if(key===principal){const star=node('span','agent-pill-principal','★');star.setAttribute('aria-label','principal');pill.querySelector('.agent-pill-name')?.before(star);}
   pill.append(lockIcon());pill.setAttribute('aria-haspopup','dialog');
   pill.dataset.tip=`${names[provider]||provider}${key===principal?' · principal':''}${label?' · '+label:''}. Fixo no Dual: carrega para mudar modelo, raciocínio ou cliente. Quem recebe a mensagem escolhe-se no seletor da caixa.`;
  }
  return Boolean(pair);
 }
 dockClick(provider){
  const conversation=this.getCurrent(),record=this.record(conversation);
  if(record){const key=DUAL_KEYS.find(k=>record.members[k].provider===provider);if(key)this.editMember(key);return true;}
  if(!conversation&&this.pendingFor()){this.configure();return true;}
  return false;
 }
 /** The composer's client field, while talking to one model: replaces that participant, asked first. */
 chooseClient(provider){
  const record=this.record();if(!record)return;
  const key=record.target==='both'?record.principal:record.target;
  if(record.members[key].provider===provider)return;
  if(record.members[other(key)].provider===provider){this.toast(`O ${shortName(provider)} já participa neste Dual. Para falar só com ele, escolhe-o no seletor.`);return;}
  if(!this.offered(provider)){this.toast(`Liga primeiro o ${shortName(provider)} para o pôr no Dual.`);return;}
  this.editMember(key,provider);
 }
 /** One participant: model and reasoning, or another client in its place. The dual stays on and nothing is sent. */
 editMember(key,wanted){
  const conversation=this.getCurrent(),record=this.record(conversation);if(!record)return;
  const member=record.members[key],kept=record.members[other(key)],settings=this.memberSettings(record,key),state=this.getState();
  this.header(`Dual · ${names[member.provider]||member.provider}`);
  this.dialog.append(node('p','opinion-caption','Muda o modelo e o raciocínio deste participante, ou põe outro cliente no seu lugar. O Dual continua ligado e nada é enviado. As respostas anteriores mantêm quem as deu; um cliente novo recebe o histórico da conversa no primeiro pedido.'));
  const error=node('p','opinion-error');error.hidden=true;error.setAttribute('role','alert');
  const fail=message=>{error.textContent=message;error.hidden=false;};
  // The server repeats these checks; here they explain why the client cannot change right now.
  const terminal=state?.nativeSessions?.sessions?.some(s=>s.group===record.groupId)||state?.conversations?.some(c=>c.group===record.groupId&&c.terminal);
  const blocked=this.running(conversation)||record.rounds.some(r=>r.targets.some(k=>['preparing','sending'].includes(r.deliveries[k].status)))?'Aguarda que as respostas terminem para mudar de cliente.':terminal?'A conversa está no terminal. Usa «Continuar na HYDRAQ» antes de mudar de cliente ou de principal.':'';
  const grid=node('div','dual-choice');this.dialog.append(grid);
  const providerSelect=this.field(grid,'Cliente'),modelSelect=this.field(grid,'Modelo'),effortSelect=this.field(grid,'Raciocínio');
  const available=Object.keys(names).filter(id=>id!==kept.provider&&(id===member.provider||this.offered(id)));
  this.fill(providerSelect,available.map(id=>({value:id,label:names[id]})),!blocked&&available.includes(wanted)?wanted:member.provider);
  providerSelect.disabled=Boolean(blocked);
  const same=()=>providerSelect.value===member.provider,models=()=>this.getModels(providerSelect.value);
  const efforts=()=>{const model=models().find(m=>m.id===modelSelect.value);this.fill(effortSelect,(model?.efforts||[]).map(e=>({value:e,label:effortLabels[e]||e})),same()&&settings?.model===modelSelect.value?settings.effort:model?.defaultEffort);};
  const modelsChanged=()=>{const list=models();this.fill(modelSelect,list.map(m=>({value:m.id,label:m.name||m.id})),same()?settings?.model:(list.find(m=>m.isDefault)||list[0])?.id);efforts();this.whenLoaded(providerSelect,list,modelsChanged);};
  modelSelect.addEventListener('change',efforts);modelsChanged();
  const note=node('p','dual-summary dual-replace-note');note.setAttribute('role','status');
  const principal=this.principalChoice(key==='a'?member.provider:kept.provider,key==='a'?kept.provider:member.provider,record.principal);
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
     await this.api('/api/dual/'+record.id,{members:{[key]:{...settings,...choice}},...(chosen!==record.principal?{principal:chosen}:{})});
     await this.refresh();
    }else{
     const result=await this.api('/api/dual/'+record.id+'/replace',{key,provider:providerSelect.value,...choice,principal:chosen});
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
 configure(){
  const conversation=this.getCurrent(),record=this.record(conversation),pending=this.pendingFor(),source=conversation?.provider||this.getProvider();
  this.header('Dual · duas respostas independentes');
  this.dialog.append(node('p','opinion-caption','Os dois modelos respondem à mesma pergunta sem ver a resposta um do outro. Na pergunta seguinte, cada um recebe o que o outro respondeu, dentro do limite de tamanho (respostas longas seguem em excerto assinalado). Perguntas aos dois correm em Planear ou Só leitura; escrever no projeto fica só para o principal.'));
  const error=node('p','opinion-error');error.hidden=true;error.setAttribute('role','alert');
  const fail=message=>{error.textContent=message;error.hidden=false;};
  const actions=node('div','opinion-actions');
  const principalField=(a,b,value)=>this.principalChoice(a,b,value).value;
  if(record){
   const summary=node('p','dual-summary');summary.append(node('strong','',`${names[record.members.a.provider]} + ${names[record.members.b.provider]}`),document.createTextNode(' · podes mudar o modelo, o raciocínio ou o cliente de cada um sem desligar o Dual.'));this.dialog.append(summary);
   const edit=node('div','dual-member-actions');
   for(const key of DUAL_KEYS){const button=node('button','secondary-button',`Mudar ${shortName(record.members[key].provider)}…`);button.type='button';button.dataset.client=record.members[key].provider;button.addEventListener('click',()=>this.editMember(key));edit.append(button);}
   this.dialog.append(edit);
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
  const available=Object.keys(names).filter(id=>id!==source&&this.offered(id));
  if(!available.length){this.dialog.append(node('p','opinion-caption','Liga primeiro outro cliente para escolher o segundo modelo.'));this.dialog.showModal();return;}
  const grid=node('div','dual-choice');this.dialog.append(grid);
  const fixed=node('p','dual-summary');fixed.append(node('strong','',names[source]),document.createTextNode(conversation?' · mantém a sessão desta conversa.':' · escolhido na caixa de mensagens.'));grid.append(fixed);
  const providerSelect=this.field(grid,'Segundo modelo · cliente'),modelSelect=this.field(grid,'Modelo'),effortSelect=this.field(grid,'Raciocínio');
  this.fill(providerSelect,available.map(id=>({value:id,label:names[id]})),pending?.provider||available[0]);
  const models=()=>this.getModels(providerSelect.value);
  const efforts=()=>{const model=models().find(m=>m.id===modelSelect.value);this.fill(effortSelect,(model?.efforts||[]).map(e=>({value:e,label:effortLabels[e]||e})),pending?.provider===providerSelect.value&&pending?.model===modelSelect.value?pending.effort:model?.defaultEffort);};
  const modelsChanged=()=>{const list=models();this.fill(modelSelect,list.map(m=>({value:m.id,label:m.name||m.id})),pending?.provider===providerSelect.value?pending.model:(list.find(m=>m.isDefault)||list[0])?.id);efforts();this.whenLoaded(providerSelect,list,modelsChanged);};
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
    if(context)context.querySelector('summary').textContent=`Contexto do ${shortName(roundMembers(record,round)[other(round.targets[0])].provider)} enviado com este pedido · ${coverageLabels[round.deliveries[round.targets[0]].coverage]||'sem registo'}`;
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
   if(sharedHeader?.children[1])sharedHeader.children[1].textContent='Tu · para os dois';
   const stage=node('section','review-stage dual-stage');stage.dataset.panelStage='dual';stage.panelStageId=round.id;stage.defaultFocus=null;stage.setAttribute('aria-label','Duas respostas independentes');
   const head=node('header','review-stage-head'),heading=node('div','review-stage-heading'),tools=node('div','review-stage-tools'),state=node('span','review-stage-state');state.setAttribute('role','status');
   heading.append(node('strong','review-stage-title','Duas respostas independentes'),state);head.append(heading,tools);
   stage.grid=node('div','review-grid');stage.append(head,stage.grid);
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
    if(context){const summary=context.querySelector('summary');summary.textContent=`Contexto do ${shortName(round.deliveries[other(part.key)]?.provider||roundMembers(record,round)[other(part.key)].provider)} enviado com este pedido · ${coverageLabels[delivery.coverage]||'sem registo'}`;panel.body.append(context);}
    const last=[...(owner?.messages||[])].reverse().find(m=>m.role==='assistant'&&m.requestId===delivery.requestId);panel.text=last?.text||'';panel.copy.hidden=!panel.text;
    panel.body.setAttribute('aria-label','Resposta de '+(names[delivery.provider]||delivery.provider));
    const items=owner?.items?.filter(i=>turn?.id&&i.turnId===turn.id)||[],latest=items.at(-1),work=owner&&turn?this.describeWork?.(owner,turn):null;
    // What each one is doing now, every action at once with its time; at the end, what the answer took.
    if(work){if(status.live)for(const line of work.now){const entry=this.panels.activity(line.text,'inProgress');if(line.since&&this.elapsed)entry.append(document.createTextNode(' · '),this.elapsed(line.since));panel.foot.append(entry);}else if(work.summary)panel.foot.append(node('span','dual-work-summary',work.summary));}
    else if(status.live&&latest)panel.foot.append(this.panels.activity(latest.type==='reasoning'?'A analisar o pedido':latest.command||latest.title||latest.tool||latest.type,latest.status));
    if(work?.thought){const detail=node('details','claude-thought');detail.open=this.thoughtsOpen.has(panel.key);detail.addEventListener('toggle',()=>{if(detail.isConnected){if(detail.open)this.thoughtsOpen.add(panel.key);else this.thoughtsOpen.delete(panel.key);}});detail.append(node('summary','',work.thoughtLabel||'Resumo do raciocínio · Claude'),node('div','claude-thought-text',work.thought));panel.foot.append(detail);}
    if(!status.live&&delivery.status==='failed'&&record.active&&round===record.rounds.at(-1)&&round.targets.length>1&&round.targets.every(k=>round.deliveries[k].conversationId===record.members[k].conversationId)&&!this.running(conversation)){
     const retry=node('button','review-panel-stop dual-retry',`Reenviar ao ${shortName(delivery.provider)}`);retry.type='button';
     retry.dataset.tip=`Envia a mesma pergunta só ao ${shortName(delivery.provider)}, sem a resposta do outro a esta ronda. O que já foi entregue não se repete.`;
     retry.addEventListener('click',async()=>{retry.disabled=true;try{await this.api('/api/dual/'+record.id+'/retry',{roundId:round.id,key:part.key});await this.refresh();}catch(e){this.toast(e.message);retry.disabled=false;}});
     panel.foot.append(retry);
    }
    if(status.live&&owner){const stop=node('button','review-panel-stop','Parar');stop.type='button';stop.dataset.tip=`Parar só o ${shortName(delivery.provider)}. O outro continua.`;stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api(`/api/conversations/${owner.id}/interrupt`,{});}catch(e){this.toast(e.message);stop.disabled=false;}});panel.foot.append(stop);}
    panel.foot.hidden=!panel.foot.childElementCount;
    stage.grid.append(panel.panel);live.push(panel.body);
    outcomes.push({key:part.key,provider:delivery.provider,done:turn?.status==='completed'&&!status.live,live:status.live});
   }
   state.textContent=labels.join(' · ');
   const synthesis=this.synthesisSection(record,round,outcomes);if(synthesis)stage.append(synthesis);
   if(running&&record.active){const stop=node('button','review-stage-stop');stop.type='button';stop.append(glyph('stop','review-icon'),node('span','','Parar os dois'));stop.dataset.tip='Parar os dois modelos. O que já responderam fica guardado.';stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api('/api/dual/'+record.id+'/interrupt',{});}catch(e){this.toast(e.message);stop.disabled=false;}});tools.append(stop);}
   shared.after(stage);this.panels.applyFocus(stage);
  }
  // A change of client is marked where it happened; the answers before it keep their own names.
  for(const change of record.changes||[]){
   const marker=node('div','provider-divider dual-change',`${names[change.to.provider]||change.to.provider} entrou no lugar do ${names[change.from.provider]||change.from.provider}`);
   marker.dataset.client=change.to.provider;
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
   const partial=done.length===1,running=batches.some(b=>synthesizing(b.jobs[0]));
   const ask=node('button','secondary-button dual-synthesis-ask',partial?`Síntese parcial · sem o ${shortName(missing.provider)}…`:batches.length?'Outra síntese…':'Sintetizar…');ask.type='button';
   ask.disabled=running;
   ask.dataset.tip=running?'Aguarda a síntese em curso ou para-a.':partial?`A resposta do ${shortName(missing.provider)} falta. A síntese parcial diz qual falta; também podes reenviar-lhe a pergunta.`:'Um modelo à tua escolha escreve uma resposta final a partir das duas, numa sessão à parte.';
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
  const delivered=record.rounds.flatMap(r=>Object.values(r.deliveries)).filter(d=>d.synthesis===batch.id&&['sent','uncertain'].includes(d.status)).length;
  const notes=[...(batch.missing?.length?[`Parcial: falta a resposta do ${shortName(batch.sources?.find(s=>s.key===batch.missing[0])?.provider)}.`]:[]),
   batch.context?(delivered>=2?'Entregue aos dois na ronda seguinte.':delivered?'Entregue a um dos dois; o outro recebe-a na próxima ronda.':'Segue para os dois na próxima ronda.'):'Não entra no contexto dos dois.',...(batch.warnings||[])];
  for(const text of notes)view.foot.append(node('span','dual-synthesis-detail',text));
  if(job.error&&!synthesizing(job))view.foot.append(node('p','dual-error',job.error));
  if(synthesizing(job)){const stop=node('button','review-panel-stop','Parar');stop.type='button';stop.dataset.tip='Parar a síntese. As respostas dos dois não mudam.';stop.addEventListener('click',async()=>{stop.disabled=true;try{await this.api('/api/opinions/'+job.id+'/stop',{});}catch(e){this.toast(e.message);stop.disabled=false;}});view.foot.append(stop);}
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
  this.header(round?(partial?'Síntese parcial':'Sintetizar as duas respostas'):'Síntese do Dual');
  this.dialog.append(node('p','opinion-caption',(round?'Um modelo escreve uma resposta final a partir das duas, numa sessão à parte. As sessões do Dual não a veem, a não ser que a mandes para a próxima ronda.':'Quem sintetiza, e se a síntese corre sozinha no fim de cada ronda enviada aos dois.')+(partial?' Só há uma resposta nesta ronda: a síntese começa por dizer qual falta.':'')));
  const error=node('p','opinion-error');error.hidden=true;error.setAttribute('role','alert');
  const grid=node('div','dual-choice');this.dialog.append(grid);
  const who=this.field(grid,'Quem sintetiza'),providerSelect=this.field(grid,'Cliente'),modelSelect=this.field(grid,'Modelo'),effortSelect=this.field(grid,'Raciocínio');
  const same=key=>saved.provider===record.members[key].provider&&saved.model===member(key).model;
  this.fill(who,[...DUAL_KEYS.map(key=>({value:key,label:`${shortName(record.members[key].provider)} · ${this.modelLabel(record.members[key].provider,member(key))}`})),{value:'other',label:'Outro modelo…'}],DUAL_KEYS.find(same)||(saved.provider?'other':record.principal));
  const available=Object.keys(names).filter(id=>this.offered(id));
  this.fill(providerSelect,available.map(id=>({value:id,label:names[id]})),available.includes(saved.provider)?saved.provider:available[0]);
  const models=()=>this.getModels(providerSelect.value);
  const efforts=()=>{const model=models().find(m=>m.id===modelSelect.value);this.fill(effortSelect,(model?.efforts||[]).map(e=>({value:e,label:effortLabels[e]||e})),saved.provider===providerSelect.value&&saved.model===modelSelect.value?saved.effort:model?.defaultEffort);};
  const modelsChanged=()=>{const list=models();this.fill(modelSelect,list.map(m=>({value:m.id,label:m.name||m.id})),saved.provider===providerSelect.value?saved.model:(list.find(m=>m.isDefault)||list[0])?.id);efforts();this.whenLoaded(providerSelect,list,modelsChanged);};
  providerSelect.addEventListener('change',modelsChanged);modelSelect.addEventListener('change',efforts);modelsChanged();
  const other=()=>{for(const select of [providerSelect,modelSelect,effortSelect])select.parentElement.hidden=who.value!=='other';};who.addEventListener('change',other);other();
  const instructions=this.field(this.dialog,'Instruções opcionais','textarea');instructions.rows=2;instructions.maxLength=3000;instructions.placeholder='Ex.: junta tudo sem descartar nada; foca a segurança.';instructions.value=saved.instructions||'';
  const check=(text,value,tip)=>{const label=node('label','dual-synthesis-option'),input=node('input');input.type='checkbox';input.checked=Boolean(value);label.append(input,document.createTextNode(text));label.dataset.tip=tip;this.dialog.append(label);return input;};
  const context=check('Entra no contexto da ronda seguinte',saved.context,'Desligado: só tu vês a síntese. Ligado: na próxima ronda, cada um dos dois recebe-a uma vez, como contexto citado.');
  const auto=check('Fazer automaticamente no fim de cada ronda aos dois',saved.auto,'Corre sozinha quando as duas respostas terminam, com estas escolhas. Não corre se faltar uma resposta.');
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
