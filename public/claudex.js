const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const providers=['codex','claude','antigravity'],legacyRoles=['codex','claude'],names={codex:'Codex',claude:'Claude',antigravity:'Antigravity',user:'Tu',coordinator:'Hydra'};
export const pairName=roles=>roles.includes('antigravity')?(roles.includes('claude')?'Claudini':'Geminex'):'ClaudeX';
const active=new Set(['preparing','discussing','reviewing','pausing','stopping']);
const resumable=new Set(['paused','uncertain','interrupted','limited']);
const labels={preparing:'A preparar os dois',discussing:'Em diálogo',reviewing:'A rever a resposta comum',pausing:'A pausar os dois',paused:'Em pausa',stopping:'A pausar os dois',completed:'Concluído',uncertain:'Progresso por confirmar',interrupted:'Parado',limited:'Proteção atingida', 'no-agreement':'Sem acordo'};
const outcomes={agreement:'Resposta comum · aprovada pelos dois',divergences:'Acordo sobre as divergências','no-agreement':'Posições atribuídas · sem acordo',synthesis:'Síntese do autor · sem acordo obrigatório'};
const candidateKinds={agreement:'Proposta de acordo',divergences:'Descrição das divergências'};
const kinds={position:'Posição inicial',question:'Pergunta',answer:'Resposta',discovery:'Descoberta',objection:'Objeção',proposal:'Proposta',resolution:'Resolução',impasse:'Impasse declarado',disagreement:'Descrição recusada',update:'Novo requisito',request:'Pedido',checkpoint:'Contexto recuperado'};
const states={idle:'Pronto',starting:'A iniciar',running:'A trabalhar',waiting:'Aguarda decisão',completed:'Turno terminado',failed:'Falhou',uncertain:'Por confirmar',interrupted:'Parado'};
export class ClaudeXUI{
 // The same task view serves the Hydra tab and, inline, the Conversations panel; there the
 // conversation's composer sends the requests and the Modo panel holds the settings.
 constructor({api,getState,area,toast,markdown,openConversation,openTask,changed=()=>{}}){
  Object.assign(this,{api,getState,area,toast,markdown,openConversation,openTask,changed});this.selected=localStorage.getItem('hydraq.claudex');this.root=document.getElementById('claudex-view');this.controls={};this.inlineHost=null;this.view={};this.cards=new Map();this.cache=new Map();this.fetching=new Set();
  document.getElementById('tab-claudex').addEventListener('click',()=>this.area.show('claudex'));
  this.build();this.timer=setInterval(()=>{if((this.area.view==='claudex'||this.inlineHost)&&this.selected)this.refresh();},1200);
 }
 button(text,fn,cls=''){const b=node('button',cls,text);b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(e){this.toast(e.message);}finally{b.disabled=false;}});return b;}
 field(key,label,tag='select'){const wrap=node('label','cx-field',label),input=node(tag);input.id='cx-'+key;wrap.htmlFor=input.id;wrap.append(input);this.controls[key]=input;this.fields.append(wrap);return input;}
 options(input,values,value){const signature=JSON.stringify(values);if(input.dataset.options!==signature){input.replaceChildren(...values.map(v=>{const o=node('option','',v.label);o.value=v.value;return o;}));input.dataset.options=signature;}if(value!==undefined&&values.some(v=>v.value===value))input.value=value;}
 build(){
  const history=node('aside','cx-history');history.append(this.button('＋ Nova tarefa Hydra',()=>this.choose(null)));this.list=node('nav');this.list.setAttribute('aria-label','Tarefas Hydra');history.append(this.list);
  const main=this.main=node('section','cx-main'),heading=node('div','cx-heading');this.heading=node('h1','','ClaudeX');heading.append(this.heading);this.badge=node('span','cx-badge');this.badge.setAttribute('role','status');heading.append(this.badge);
  this.error=node('p','notice');this.error.setAttribute('role','alert');
  this.intro=node('p','cx-intro','Os dois participantes trabalham em paralelo, só em análise, pesquisa e planeamento. Trocam descobertas e objeções enquanto investigam e preparam uma resposta comum. Escolhe a dupla, os modelos e as proteções no painel Modo e escreve o pedido na caixa abaixo.');this.intro.hidden=true;
  this.settings=node('details','cx-settings');this.settings.open=!this.selected;this.settings.append(node('summary','','Escolhe uma dupla · contexto e proteções'));this.fields=node('div','cx-fields');this.settings.append(this.fields);
  this.field('project','Projeto');this.field('cwd','Pasta para pesquisa','input');
  for(const [index,role] of legacyRoles.entries()){const input=this.field('participant'+index,'Participante '+(index?'B':'A'));this.options(input,providers.map(value=>({value,label:names[value]})),role);input.addEventListener('change',()=>this.changePair(index));}
  for(const role of providers){this.field(role+'Model',names[role]+' · modelo');this.field(role+'Effort','Raciocínio · '+names[role]);this.controls[role+'Model'].addEventListener('change',()=>this.models(role));}
  this.field('author','Autor do documento');this.options(this.controls.author,legacyRoles.map(value=>({value,label:names[value]})),'codex');
  this.field('consensus','Resposta final');this.options(this.controls.consensus,[{value:'true',label:'Exigir aprovação dos dois'},{value:'false',label:'Síntese do autor · sem acordo obrigatório'}],'true');
  for(const [key,label,value] of [['guardTurns','Proteção · turnos por participante',30],['guardMinutes','Proteção · minutos ativos',60]]){const input=this.field(key,label,'input');input.type='number';input.min='0';input.step='1';input.required=true;input.value=value;input.setAttribute('aria-describedby','cx-guards-hint');}
  this.controls.project.addEventListener('change',()=>{const p=this.getState().projectCatalog?.projects.find(p=>p.id===this.controls.project.value);if(p)this.controls.cwd.value=p.root;this.render();});
  this.settings.append(node('p','cx-hint','Os dois participantes trabalham em paralelo, em análise e planeamento. Investigam, confrontam argumentos e corrigem o documento em conjunto. Os contributos chegam quando cada cliente os consegue receber.'));
  this.guardHint=node('p','cx-hint','As proteções pausam a tarefa e preservam o progresso. 0 desativa a proteção respetiva. Cada retoma abre uma nova contagem de turnos e minutos. Podes ajustá-las antes de iniciar ou durante uma pausa.');this.guardHint.id='cx-guards-hint';this.settings.append(this.guardHint);
  this.pauseNotice=node('p','notice');this.pauseNotice.setAttribute('role','status');this.pauseNotice.hidden=true;
  this.participants=node('div','cx-participants');this.participants.setAttribute('aria-label','Estado dos participantes');
  this.approvals=node('div');this.goal=node('div','cx-goal');
  this.exchanges=node('details','cx-exchanges');this.exchanges.open=true;this.exchangeSummary=node('summary','','Diálogo');this.messages=node('div','cx-messages');this.exchanges.append(this.exchangeSummary,this.messages);
  this.result=node('section','cx-result');this.result.setAttribute('aria-label','Documento final ClaudeX');
  this.draft=node('details','cx-draft');this.draft.append(node('summary','','Versões e aprovações'));this.versions=node('div');this.draft.append(this.versions);
  this.form=node('form','cx-composer');const label=this.promptLabel=node('label','sr-only','Pedido para o Hydra');this.prompt=node('textarea');this.prompt.id='cx-prompt';label.htmlFor=this.prompt.id;this.prompt.rows=3;this.prompt.maxLength=16000;this.prompt.placeholder='O que queres que os dois participantes investiguem juntos?';this.prompt.addEventListener('input',()=>this.saveDraft());
  const actions=node('div','cx-actions');this.hint=node('span','cx-hint');this.send=node('button','primary','Iniciar ClaudeX');this.send.type='submit';this.stop=this.button('Pausar os dois',async()=>{this.detail=await this.api('/api/claudex/'+this.selected+'/pause',{});this.renderDetail();this.render();});this.finish=this.button('Terminar tarefa',async()=>{this.detail=await this.api('/api/claudex/'+this.selected+'/stop',{});this.renderDetail();this.render();});this.finish.title='Liberta as conversas; o progresso fica guardado.';this.finish.hidden=true;this.clone=this.button('Nova tarefa com este progresso',()=>this.sendRequest(true));this.clone.title='Abre novas sessões com o progresso identificado; conserva a tarefa anterior.';this.clone.hidden=true;actions.append(this.hint,this.stop,this.finish,this.clone,this.send);this.form.append(label,this.prompt,actions);
  this.form.addEventListener('submit',e=>{e.preventDefault();this.sendRequest();});
  main.append(heading,this.intro,this.error,this.pauseNotice,this.settings,this.participants,this.approvals,this.goal,this.exchanges,this.result,this.draft,this.form);this.root.append(history,main);this.restoreDraft();
 }
 saveDraft(){localStorage.setItem('hydraq.claudex.draft.'+(this.selected||'new'),this.prompt.value);}
 restoreDraft(){this.prompt.value=localStorage.getItem('hydraq.claudex.draft.'+(this.selected||'new'))||'';}
 choose(id,{show=true}={}){this.saveDraft();this.selected=id;this.detail=null;this.signature='';this.guardSignature='';this.detailStatus=null;this.pending=null;this.resultTask=null;this.exchanges.open=true;if(id)localStorage.setItem('hydraq.claudex',id);else{localStorage.removeItem('hydraq.claudex');this.controls.guardTurns.value=30;this.controls.guardMinutes.value=60;for(const [index,role] of legacyRoles.entries())this.controls['participant'+index].value=role;for(const role of providers)this.controls[role+'Model'].value='';}this.restoreDraft();this.settings.open=!id;if(show)this.area.show('claudex');if(id)this.refresh();}
 /** Shows the task inside another panel (Conversations) while the Hydra tab is not open; null releases it. */
 inline(host){if(this.inlineHost===host)return;this.inlineHost=host;if(host&&this.area.view!=='claudex'){this.render();if(this.selected&&!this.detail)this.refresh();}}
 /** The pair of a new task; an existing task keeps its own. */
 setPair(pair){if(this.selected||pair?.length!==2||!pair.every(role=>providers.includes(role)))return;if(this.controls.participant0.value===pair[0]&&this.controls.participant1.value===pair[1])return;this.controls.participant0.value=pair[0];this.controls.participant1.value=pair[1];this.render();}
 /** Request from the conversation composer: a new task runs in that conversation, or takes the project and folder of a new one. Returns the task, or null. */
 async requestInline(text,{projectId,cwd,conversationId}={}){if(this.sending)return false;if(!this.selected){this.controls.project.value=projectId||'';if(!this.controls.project.value&&cwd)this.controls.cwd.value=cwd;}this.prompt.value=text;this.sending=true;this.inlineConversation=conversationId||null;this.render();try{await this.submit();return this.detail||{};}catch(e){this.toast(e.message);return null;}finally{this.sending=false;this.inlineConversation=null;this.render();}}
 roles(){return this.detail?.roles|| (this.detail?legacyRoles:[this.controls.participant0.value,this.controls.participant1.value]);}
 changePair(index){const other=this.controls['participant'+(index?0:1)],chosen=this.controls['participant'+index].value;if(other.value===chosen)other.value=providers.find(role=>role!==chosen);this.render();}
 /** Models and reasoning for the next task, from the Dual it comes from; a choice made in the panel afterwards wins. */
 // A task still selected from before is replaced by the new one when Hydra opens: its model and reasoning do not stay.
 preset(members){this.wanted=members||null;if(!members)return;for(const role of Object.keys(members))if(this.controls[role+'Model']){this.controls[role+'Model'].value='';this.controls[role+'Effort'].value='';}this.render();}
 models(role){const models=this.getState()?.providers?.[role]?.models||[],wanted=this.wanted?.[role];const preferred=this.detail?.members?.[role]?.model||this.controls[role+'Model'].value||wanted?.model||(role==='antigravity'?models.find(m=>/argon/i.test(m.name||m.id))?.id:role==='codex'?models.find(m=>m.id==='gpt-6.1-sol')?.id:models.find(m=>/opus.*5[.\-]5/i.test(m.name||m.id))?.id),selected=models.some(m=>m.id===preferred)?preferred:models[0]?.id;this.options(this.controls[role+'Model'],models.map(m=>({value:m.id,label:m.name||m.id})),selected);const model=models.find(m=>m.id===this.controls[role+'Model'].value);this.options(this.controls[role+'Effort'],(model?.efforts||[]).map(value=>({value,label:value})),this.detail?.members?.[role]?.effort||this.controls[role+'Effort'].value||(wanted?.model===model?.id?wanted.effort:undefined)||model?.defaultEffort);}
 render(){
  const state=this.getState();if(!state)return;const visible=this.area.view==='claudex',inline=!visible&&Boolean(this.inlineHost);this.root.classList.toggle('hidden',!visible);document.getElementById('tab-claudex').setAttribute('aria-selected',String(visible));
  const available=Boolean(state.claudex);document.getElementById('tab-claudex').hidden=!available;if(!visible&&!inline)return;
  const host=visible?this.root:this.inlineHost;if(this.main.parentElement!==host)host.append(this.main);this.main.classList.toggle('cx-inline',inline);
  if(visible){document.getElementById('chat-workspace').classList.add('hidden');document.getElementById('project-overview').classList.add('hidden');document.getElementById('project-name').textContent='Hydra';}
  const summary=state.claudex?.records.find(r=>r.id===this.selected);
  // The conversation shows a result as soon as the state has it; the task's own buttons follow at once.
  if(summary&&this.detail?.id===summary.id&&this.detail.updatedAt!==summary.updatedAt)this.refresh();
  const status=this.detail?.status||summary?.status,pausing=['pausing','stopping'].includes(status)||Boolean(this.detail?.pause?.draining),interruptionPending=Boolean(this.detail?.pause?.interruptionPending),running=active.has(status)||pausing||interruptionPending,released=Boolean(this.detail?.released||summary?.released),retired=Boolean(this.detail?.retired||summary?.retired),canResume=resumable.has(status)&&!pausing&&!released&&!retired;
  const listSig=JSON.stringify([state.claudex?.records,this.selected]);if(this.listSig!==listSig){this.listSig=listSig;this.list.replaceChildren();for(const r of [...(state.claudex?.records||[])].reverse()){const b=this.button(pairName(r.roles||legacyRoles)+' · '+r.title,()=>this.choose(r.id));b.setAttribute('aria-current',String(r.id===this.selected));b.append(node('small','',r.retired?'Arquivada':labels[r.status]||r.status));this.list.append(b);}}
  const projects=(state.projectCatalog?.projects||[]).filter(p=>!p.archived);this.options(this.controls.project,[{value:'',label:'Sem projeto'},...projects.map(p=>({value:p.id,label:p.name}))],this.detail?.projectId??this.controls.project.value);
  if(!this.controls.cwd.value)this.controls.cwd.value=state.defaultCwd||'';
  const roles=this.roles();this.heading.textContent=pairName(roles);if(visible)document.getElementById('project-name').textContent=pairName(roles);for(const role of providers){this.models(role);this.controls[role+'Model'].parentElement.classList.toggle('hidden',!roles.includes(role));this.controls[role+'Effort'].parentElement.classList.toggle('hidden',!roles.includes(role));}this.options(this.controls.author,roles.map(value=>({value,label:names[value]})),this.detail?.author||this.controls.author.value);for(const [index,role] of roles.entries())this.controls['participant'+index].value=role;
  for(const [key,input] of Object.entries(this.controls))input.disabled=this.sending||Boolean(this.selected&&!(status==='paused'&&!pausing&&key.startsWith('guard')));if(this.controls.project.value)this.controls.cwd.disabled=true;
  const connected=roles.every(role=>state.providers?.[role]?.connection==='connected');
  this.badge.textContent=interruptionPending?'Interrupção por confirmar':pausing?'A pausar os dois':retired?'Arquivada':labels[status]||'Análise e planeamento';this.error.textContent=state.claudex?.error||(retired?'':this.detail?.error)||'';this.error.hidden=!this.error.textContent;
  this.stop.hidden=!running;this.stop.disabled=pausing||this.sending;this.stop.textContent=pausing?'A pausar…':interruptionPending?'Voltar a tentar parar':'Pausar os dois';this.finish.hidden=status!=='paused'||pausing||retired;this.finish.disabled=this.sending||Boolean(state.claudex?.error);this.clone.hidden=!canResume||status==='paused';this.clone.disabled=this.sending||!this.detail||!connected||Boolean(state.claudex?.error);this.send.textContent=this.sending?'A enviar…':canResume?'Retomar a mesma tarefa':running?'Atualizar o pedido dos dois':this.selected?'Nova tarefa a partir deste progresso':'Iniciar '+pairName(roles);this.send.disabled=this.sending||Boolean(this.selected&&!this.detail)||!connected||Boolean(state.claudex?.error)||status==='preparing'||pausing||interruptionPending;
  this.prompt.maxLength=running||canResume?8000:16000;this.prompt.placeholder=canResume?'Novo requisito opcional para os dois; retoma também com a caixa vazia.':this.selected&&!running?'Pedido para uma nova tarefa com este progresso.':'O que queres que os dois participantes investiguem juntos?';
  this.hint.textContent=!connected?'Liga '+roles.map(role=>names[role]).join(' e ')+' nas Conversas.':pausing?'A preservar o progresso e a interromper os dois clientes.':running?'Novos requisitos chegam aos dois e anulam aprovações anteriores.':canResume?'Retoma o mesmo histórico e as mesmas sessões nativas. Um requisito novo é opcional.':this.selected?(this.detail?.inPlace?'Nova tarefa na mesma conversa e com as mesmas sessões, com o progresso anterior identificado.':'Abre uma nova tarefa e novas sessões, com o progresso anterior identificado.'):'Uma tarefa · dois participantes · uma resposta comum';
  this.finish.title=this.detail?.inPlace?'Para a tarefa e devolve a conversa ao modo anterior; o progresso fica guardado.':'Liberta as conversas; o progresso fica guardado.';
  const pauseReason=this.detail?.pauseReason||this.detail?.pause?.reason;this.pauseNotice.hidden=!canResume&&!retired;this.pauseNotice.textContent=retired?'Arquivada: o agy desta tarefa trabalhava no ambiente privado antigo do Hydra, que foi retirado, e a sua sessão não pode ser retomada. Podes continuar o conteúdo numa tarefa nova, com sessões novas e o progresso identificado.':canResume?(pauseReason||this.detail?.error||'Progresso preservado. A retoma é explícita.')+(status==='paused'?` Ajusta as proteções ${inline?'no painel Modo':'acima'}, se necessário, e retoma quando quiseres.`:' A retoma pode ser recusada se a entrega nativa for incerta. Podes abrir uma nova tarefa com este progresso e novas sessões.'):'';
  // A pause reason already opens the pause notice; the alert above would repeat it.
  if(canResume&&this.error.textContent&&this.pauseNotice.textContent.startsWith(this.error.textContent))this.error.hidden=true;
  if((state.claudex?.protocolVersion||0)<(roles.includes('antigravity')?3:2)){this.error.textContent='Reinicia o servidor HYDRAQ para ativar esta versão do ClaudeX. O histórico continua disponível.';this.error.hidden=false;this.send.disabled=true;this.stop.disabled=true;this.finish.disabled=true;this.clone.disabled=true;}
  if(!this.selected){this.participants.replaceChildren();this.goal.replaceChildren();this.messages.replaceChildren();this.result.replaceChildren();this.versions.replaceChildren();this.approvals.replaceChildren();this.exchanges.hidden=this.draft.hidden=true;}
  this.view={roles,status,running,canResume,pausing,interruptionPending,connected,stopLabel:this.stop.textContent,stopDisabled:this.stop.disabled};
  // In a conversation the request and the common answer are its own messages, around this card.
  this.settings.hidden=this.promptLabel.hidden=this.prompt.hidden=this.send.hidden=this.hint.hidden=this.goal.hidden=this.result.hidden=inline;if(inline)this.stop.hidden=true;this.form.hidden=inline&&this.finish.hidden&&this.clone.hidden;this.intro.hidden=!inline||Boolean(this.selected);
  this.changed();
 }
 async refresh(){if(this.loading||!this.selected)return;this.loading=true;const id=this.selected;try{const d=await this.api('/api/claudex/'+id);if(id!==this.selected)return;this.detail=d;this.renderDetail();this.render();}catch(e){this.error.textContent=e.message;this.error.hidden=false;}finally{this.loading=false;}}
 renderDetail(){
  const d=this.detail;if(!d)return;const roles=this.roles();
  this.controls.cwd.value=d.cwd;this.controls.author.value=d.author;this.controls.consensus.value=String(d.consensus);
  const guardSignature=JSON.stringify([d.id,d.guards]);if(this.guardSignature!==guardSignature){this.guardSignature=guardSignature;this.controls.guardTurns.value=d.guards?.turns??30;this.controls.guardMinutes.value=d.guards?.minutes??60;}if(d.status==='paused'&&this.detailStatus!=='paused')this.settings.open=true;this.detailStatus=d.status;
  const sig=JSON.stringify(d);if(sig===this.signature)return;this.signature=sig;
  // Updates rebuild the view; what the person opened stays open.
  const opened=new Set([...this.main.querySelectorAll('details[data-key][open]')].map(e=>e.dataset.key));
  const request=d.messages.find(m=>m.type==='request')?.text||'';this.goal.replaceChildren(node('h2','','Pedido comum'),node('p','',request));if(request)this.goal.append(this.button('Copiar pedido',()=>navigator.clipboard.writeText(request)));
  this.participants.replaceChildren();for(const role of roles){const p=d.participants[role],m=d.members[role],card=node('section','cx-participant');card.dataset.client=role;card.append(node('strong','',names[role]),node('span','',states[p?.status]||p?.status||'A preparar'),node('small','',m?.model||''),node('small','',`${m?.turns||0} turnos no total · proteção ${d.guards?.turns?d.guards.turns+' por retoma':'desativada'}`));const read=d.read?.[role];card.append(node('small','cx-last-read',read?`Última leitura: mensagem ${read.seq} · ${read.at?new Date(read.at).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'hora não registada'}`:'Ainda não leu o diálogo'));if(read?.at)card.lastChild.title=new Date(read.at).toLocaleString('pt-PT');if(p?.activity?.length)card.append(node('small','cx-tool-activity','Em execução: '+p.activity.map(a=>a.name).join(' · ')));if(d.approvals[role])card.append(node('span','cx-approved','Aprovou a versão atual'));if(p?.answer){const detail=node('details');detail.dataset.key='answer:'+role;detail.open=opened.has(detail.dataset.key);detail.append(node('summary','','Última contribuição'),this.markdown(p.answer));card.append(detail);}this.participants.append(card);}
  const pending=(this.getState()?.approvals||[]).filter(a=>roles.some(role=>d.members[role]?.conversationId===a.conversationId));this.approvals.replaceChildren();for(const a of pending)this.approvals.append(this.button('Responder à decisão de '+names[a.provider||a.id.split(':')[0]],()=>this.openConversation(a.conversationId),'cx-decision'));
  // The newest contributions stay in view unless the person scrolled back to read.
  const pinned=this.messages.scrollHeight-this.messages.scrollTop-this.messages.clientHeight<40;
  this.exchanges.hidden=false;this.exchangeSummary.textContent=`Diálogo · ${d.messages.length-1} contributos e atualizações`;this.messages.replaceChildren();for(const m of d.messages.filter(m=>m.type!=='request'))this.messages.append(this.messageCard(m,this.main.classList.contains('cx-inline')));if(pinned)this.messages.scrollTop=this.messages.scrollHeight;
  this.result.replaceChildren();if(d.result){if(this.resultTask!==d.id){this.resultTask=d.id;this.exchanges.open=false;}this.result.append(node('h2','',d.result.label||outcomes[d.result.outcome]||(d.result.agreed?outcomes.agreement:outcomes.synthesis)),this.markdown(d.result.text),this.button('Copiar resposta',()=>navigator.clipboard.writeText(d.result.text)));}
  else if(d.candidateId)this.result.append(node('p','cx-hint','A versão candidata está em revisão. O documento final aparece aqui quando o processo terminar.'));
  this.draft.hidden=!d.candidates.length;this.versions.replaceChildren(...this.versionList(d,opened));
 }
 messageCard(m,inline){const card=node('article','cx-message');card.dataset.client=m.from;card.append(node('strong','',`${names[m.from]||m.from} · ${kinds[m.type]||m.type} · #${m.seq}`));if(m.replyTo)card.append(node('small','',`Em resposta a #${m.replyTo}`));if(m.type==='checkpoint'){let previous;try{previous=JSON.parse(m.text).previousTask;}catch{}card.append(node('p','','Progresso anterior incluído nesta tarefa. As aprovações anteriores não transitam.'));if(previous)card.append(this.button('Abrir tarefa anterior',()=>inline&&this.openTask?this.openTask(previous):this.choose(previous)));}else card.append(this.markdown(m.text));return card;}
 versionList(d,opened=new Set()){return d.candidates.map(c=>{const detail=node('details');detail.dataset.key='version:'+c.id;detail.open=opened.has(detail.dataset.key);detail.append(node('summary','',`Versão ${c.version} · ${c.id===d.candidateId?'atual':'substituída'}${d.result?.id===c.id?' · publicada':''}${c.outcome?' · '+(candidateKinds[c.outcome]||c.outcome):''}`),this.markdown(c.text));return detail;});}
 /** The detail of a task: the open task's own, else the copy kept for the conversation's history. */
 detailOf(id,live=false){return live&&this.detail?.id===id?this.detail:this.cache.get(id)?.detail||null;}
 load(record){const kept=this.cache.get(record.id);if(kept?.updatedAt===record.updatedAt||this.fetching.has(record.id))return;this.fetching.add(record.id);
  this.api('/api/claudex/'+record.id).then(detail=>this.cache.set(record.id,{updatedAt:record.updatedAt,detail}),()=>this.cache.set(record.id,{updatedAt:record.updatedAt,detail:kept?.detail||null,failed:true})).finally(()=>{this.fetching.delete(record.id);this.changed();});}
 /** Hydra tasks of a conversation's group, for its transcript: the person's requests at their time, then the task's card.
  * The live task's card is the inline view itself. */
 transcript(members,liveId){
  const ids=new Set(members.map(c=>c.id)),group=members[0]?.group,entries=[],shown=new Set();
  const tasks=(this.getState()?.claudex?.records||[]).filter(r=>r.groupId?r.groupId===group:Object.values(r.members||{}).some(m=>ids.has(m.conversationId)));
  for(const record of tasks){
   const live=record.id===liveId;if(!live)this.load(record);
   const d=this.detailOf(record.id,live),requests=(d?.messages||[]).filter(m=>m.from==='user');
   // A past task waits for its detail, so that its card does not jump from the end to its place.
   if(!d&&!live&&!this.cache.get(record.id)?.failed)continue;
   for(const message of requests)entries.push({at:message.at,record,message});
   if(requests.length)shown.add(record.id);
   entries.push({at:requests.at(-1)?.at||'￿',record,card:true});
  }
  return {tasks,entries,shown,signature:JSON.stringify([liveId,tasks.map(r=>[r.id,r.id===liveId?null:[r.status,r.updatedAt],entries.filter(e=>e.record===r).map(e=>e.message?.seq??'card')])])};
 }
 /** A finished task in the conversation: one line that opens to its dialogue and versions. Kept between renders, so what was opened stays open. */
 card(record){
  const d=this.detailOf(record.id),signature=JSON.stringify([record.status,record.retired,record.released,record.result,d?.messages.length,d?.candidates.length]);
  let entry=this.cards.get(record.id);
  if(!entry){const element=node('details','cx-card');element.dataset.task=record.id;element.addEventListener('toggle',()=>{if(element.open)this.fillCard(record.id);});entry={element};this.cards.set(record.id,entry);}
  if(entry.signature!==signature){
   entry.signature=signature;entry.filled=false;const summary=node('summary'),count=d?.messages.filter(m=>m.from!=='user').length;
   summary.append(node('strong','','Hydra · '+pairName(record.roles||legacyRoles)),node('span','cx-card-state',record.retired?'Arquivada':record.result?.label||labels[record.status]||record.status));
   if(count!==undefined)summary.append(node('small','',`${count} ${count===1?'contributo':'contributos'}`));
   entry.element.dataset.status=record.status;entry.element.replaceChildren(summary);if(entry.element.open)this.fillCard(record.id);
  }
  return entry.element;
 }
 fillCard(id){
  const entry=this.cards.get(id),d=this.detailOf(id);if(!entry||entry.filled||!d)return;entry.filled=true;
  const body=node('div','cx-card-body'),list=node('div','cx-messages');for(const m of d.messages.filter(m=>m.from!=='user'))list.append(this.messageCard(m,true));body.append(list);
  if(d.candidates.length){const versions=node('details','cx-draft');versions.append(node('summary','','Versões e aprovações'),...this.versionList(d));body.append(versions);}
  body.append(this.button('Abrir no separador Hydra',()=>this.choose(id)));entry.element.append(body);
 }
 guards(){const values=[this.controls.guardTurns.value,this.controls.guardMinutes.value],guards={turns:Number(values[0]),minutes:Number(values[1])};if(values.some(value=>!value.trim())||Object.values(guards).some(value=>!Number.isSafeInteger(value)||value<0))throw Error('As proteções devem ser números inteiros iguais ou superiores a 0.');return guards;}
 async sendRequest(newTask=false){if(this.sending)return;this.sending=true;this.render();try{await this.submit(newTask);}catch(e){this.toast(e.message);}finally{this.sending=false;this.render();}}
 async submit(newTask=false){const text=this.prompt.value.trim()||(newTask?this.detail?.messages.find(m=>m.type==='request')?.text||'Continuar a partir do progresso anterior.':''),running=!newTask&&active.has(this.detail?.status),canResume=!newTask&&resumable.has(this.detail?.status)&&!this.detail?.released&&!this.detail?.retired;if(!text&&!canResume)return;const guards=this.guards(),key=JSON.stringify([this.selected,newTask,text,this.controls.project.value,...Object.values(this.controls).map(c=>c.value)]);if(this.pending?.key!==key)this.pending={key,requestId:crypto.randomUUID()};
  if(this.selected&&canResume){this.detail=await this.api('/api/claudex/'+this.selected+'/resume',{guards,...(text?{text}:{}),requestId:this.pending.requestId});this.settings.open=false;}
  else if(this.selected&&running){this.detail=await this.api('/api/claudex/'+this.selected+'/update',{text,requestId:this.pending.requestId});}
  else{const roles=this.roles();if(roles.length!==2||new Set(roles).size!==2)throw Error('Escolhe dois clientes distintos.');const members=Object.fromEntries(roles.map(role=>[role,{model:this.controls[role+'Model'].value,effort:this.controls[role+'Effort'].value}]));
   // A task from a conversation, or the next one from its progress, runs in that same conversation.
   const conversationId=this.selected?(this.detail?.inPlace?this.detail.origin?.conversationId:null):this.inlineConversation;
   const result=await this.api('/api/claudex',{text,requestId:this.pending.requestId,cwd:this.controls.cwd.value,projectId:this.controls.project.value||null,projectRevision:this.getState().projectCatalog?.revision,roles,members,author:this.controls.author.value,consensus:this.controls.consensus.value==='true',guards,...(this.selected?{resumeFrom:this.selected}:{}),...(conversationId?{conversationId}:{})});this.prompt.value='';this.saveDraft();this.wanted=null;this.selected=result.task.id;this.detail=result.task;localStorage.setItem('hydraq.claudex',this.selected);this.settings.open=false;}
  this.prompt.value='';this.saveDraft();this.pending=null;this.renderDetail();this.render();await this.refresh();
 }
}
