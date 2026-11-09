import { locale as uiLocale } from './i18n.js';
import { t as uiText } from './i18n.js';
import { hydraQuotaUsage, quotaUsageView } from './turn-quotas.js';
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const providers=['codex','claude','antigravity'],legacyRoles=['codex','claude'],names={codex:'Codex',claude:'Claude',antigravity:'Antigravity',user:uiText('Tu'),coordinator:'Hydra'};
export const pairName=roles=>roles.length===3?'Hydra Trio':roles.includes('antigravity')?(roles.includes('claude')?'Claudini':'Geminex'):'ClaudeX';
const active=new Set(['preparing','discussing','reviewing','pausing','stopping']);
const resumable=new Set(['paused','uncertain','interrupted','limited']);
const labels={preparing:uiText('A preparar todos'),discussing:uiText('Em diálogo'),reviewing:uiText('A rever a resposta comum'),pausing:uiText('A pausar todos'),paused:uiText('Em pausa'),stopping:uiText('A pausar todos'),completed:uiText('Concluído'),uncertain:uiText('Progresso por confirmar'),interrupted:uiText('Parado'),limited:uiText('Proteção atingida'), 'no-agreement':uiText('Sem acordo')};
const outcomes={agreement:uiText('Resposta comum · aprovada por todos'),divergences:uiText('Acordo sobre as divergências'),'no-agreement':uiText('Posições atribuídas · sem acordo'),synthesis:uiText('Síntese do autor · sem acordo obrigatório')};
const candidateKinds={agreement:uiText('Proposta de acordo'),divergences:uiText('Descrição das divergências')};
const kinds={phase:uiText('Fase'),position:uiText('Posição inicial'),question:uiText('Pergunta'),answer:uiText('Resposta'),discovery:uiText('Descoberta'),objection:uiText('Objeção'),'objection-response':uiText('Resposta à objeção'),proposal:uiText('Proposta'),resolution:uiText('Resolução'),impasse:uiText('Impasse declarado'),disagreement:uiText('Descrição recusada'),update:uiText('Novo requisito'),request:uiText('Pedido'),checkpoint:uiText('Contexto recuperado'),replan:uiText('Replaneamento')};
const phaseLabels={planning:uiText('Plano em discussão'),implementing:uiText('Implementação por etapas'),fixing:uiText('Correções em curso'),validating:uiText('Revisão e testes de todos'),finalizing:uiText('Conclusão em revisão')};
const testLabels={running:uiText('A testar'),passed:uiText('Passou'),failed:uiText('Falhou'),timedOut:uiText('Tempo esgotado'),environment:uiText('Problema do ambiente'),interrupted:uiText('Interrompido')},reviewLabels={approve:uiText('Aprovado'),changes:uiText('Pede correções'),blocked:uiText('Bloqueado'),disagree:uiText('Discorda')};
const externalStates={completed:uiText('Resposta recebida'),failed:uiText('Erro ao preparar ou executar'),uncertain:uiText('Efeitos por confirmar'),interrupted:uiText('Interrompida antes de enviar'),running:uiText('A executar')};
const states={idle:uiText('Pronto'),starting:uiText('A iniciar'),running:uiText('A trabalhar'),waiting:uiText('Aguarda decisão'),completed:uiText('Turno terminado'),failed:uiText('Falhou'),uncertain:uiText('Por confirmar'),interrupted:uiText('Parado')};
const isClarification=m=>m.from==='user'&&m.type==='answer';
const answerText=value=>Array.isArray(value)?value.join(', '):String(value);
/** A native question and the person's answer, in words. The question is the model's own text and is shown as such. */
function clarification(m){
 let response={};try{response=JSON.parse(m.text)||{};}catch{}
 const answers={...(response.answers||{})},asker=names[m.question?.provider]||m.question?.provider||uiText('modelo'),lines=[];
 for(const q of m.question?.questions||[]){
  const key=[q.id,q.question,q.header].find(k=>k!==undefined&&answers[k]!==undefined),value=answers[key];delete answers[key];
  lines.push(node('p','',uiText`Pergunta de ${asker}: ${q.question||q.header||uiText('sem texto')}`),node('p','',uiText`Resposta: ${value===undefined?uiText('sem resposta'):answerText(value)}`));
 }
 for(const [key,value] of Object.entries(answers))lines.push(node('p','',uiText`Resposta (${key}): ${answerText(value)}`));
 if(!lines.length)lines.push(node('p','',uiText('Sem resposta.')));
 return lines;
}
export class ClaudeXUI{
 // The same task view serves the Hydra tab and, inline, the Conversations panel; there the
 // conversation's composer sends the requests and the Modo panel holds the settings.
 constructor({api,getState,area,toast,markdown,openConversation,openTask,openCheckpoint,changed=()=>{},elapsed=null}){
  Object.assign(this,{api,getState,area,toast,markdown,openConversation,openTask,openCheckpoint,changed,elapsed});this.selected=localStorage.getItem('hydraq.claudex');this.root=document.getElementById('claudex-view');this.controls={};this.inlineHost=null;this.view={};this.cards=new Map();this.cache=new Map();this.fetching=new Set();
  document.getElementById('tab-claudex').addEventListener('click',()=>this.area.show('claudex'));
  this.build();this.timer=setInterval(()=>{if((this.area.view==='claudex'||this.inlineHost)&&this.selected)this.refresh();},1200);
 }
 button(text,fn,cls=''){const b=node('button',cls,text);b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(e){this.toast(e.message);}finally{b.disabled=false;}});return b;}
 field(key,label,tag='select'){const wrap=node('label','cx-field',label),input=node(tag);input.id='cx-'+key;wrap.htmlFor=input.id;wrap.append(input);this.controls[key]=input;this.fields.append(wrap);return input;}
 options(input,values,value){const signature=JSON.stringify(values);if(input.dataset.options!==signature){input.replaceChildren(...values.map(v=>{const o=node('option','',v.label);o.value=v.value;return o;}));input.dataset.options=signature;}if(value!==undefined&&values.some(v=>v.value===value))input.value=value;}
 build(){
  const history=node('aside','cx-history');history.append(this.button(uiText('＋ Nova tarefa Hydra'),()=>this.choose(null)));this.list=node('nav');this.list.setAttribute('aria-label',uiText('Tarefas Hydra'));history.append(this.list);
  const main=this.main=node('section','cx-main'),heading=node('div','cx-heading');this.heading=node('h1','','Hydra');heading.append(this.heading);this.badge=node('span','cx-badge');this.badge.setAttribute('role','status');heading.append(this.badge);
  this.error=node('p','notice');this.error.setAttribute('role','alert');
  this.intro=node('p','cx-intro',uiText('Dois ou três modelos discutem o plano. Quando pedes alterações, os implementadores autorizados executam por etapas; todos reveem e testam. Perguntas e pedidos de planeamento ficam em leitura. Escolhe os participantes no painel Modo e escreve um único pedido.'));this.intro.hidden=true;
  this.settings=node('details','cx-settings');this.settings.open=!this.selected;this.settings.append(node('summary','',uiText('Participantes · contexto e proteções')));this.fields=node('div','cx-fields');this.settings.append(this.fields);
  this.field('project',uiText('Projeto'));this.field('cwd',uiText('Pasta do projeto'),'input');
  for(const [index,role] of [...legacyRoles,''].entries()){const input=this.field('participant'+index,uiText('Participante ')+['A','B',uiText('C (opcional)')][index]);this.options(input,[...(index===2?[{value:'',label:uiText('Sem terceiro participante')}]:[]),...providers.map(value=>({value,label:names[value]}))],role);input.addEventListener('change',()=>this.changePair(index));}
  for(const role of providers){this.field(role+'Model',names[role]+uiText(' · modelo'));this.field(role+'Effort',uiText('Raciocínio · ')+names[role]);this.controls[role+'Model'].addEventListener('change',()=>this.models(role));}
  this.field('author',uiText('Principal · coordena o plano e a conclusão'));this.options(this.controls.author,legacyRoles.map(value=>({value,label:names[value]})),'codex');
  this.field('writers',uiText('Implementadores autorizados'));this.controls.writers.multiple=true;this.controls.writers.size=3;this.writerCustom=false;
  this.field('implementationPreferences',uiText('Preferências de distribuição'),'textarea').maxLength=4000;this.controls.implementationPreferences.placeholder=uiText('Ex.: Claude na interface, Codex na lógica; o restante fica ao acordo do grupo.');
  this.field('externalEnabled',uiText('Ferramentas externas (MCP)'));this.options(this.controls.externalEnabled,[{value:'false',label:uiText('Desligadas')},{value:'true',label:uiText('Escolher servidores para esta tarefa')}],'false');
  this.field('externalServers',uiText('Servidores MCP externos'));this.controls.externalServers.multiple=true;this.controls.externalServers.size=4;
  this.field('externalScope',uiText('Quem usa ferramentas externas'));this.options(this.controls.externalScope,[{value:'principal',label:uiText('Só o principal')},{value:'all',label:uiText('Todos os participantes')}],'principal');
  this.field('externalRisk',uiText('Autorização de ações externas'));this.options(this.controls.externalRisk,[{value:'false',label:uiText('Risco ainda não aceite')},{value:'true',label:uiText('Aceito ações autónomas fora do isolamento, sem aprovação por chamada')}],'false');
  this.externalHint=node('p','cx-hint',uiText('Os servidores escolhidos executam com as permissões do utilizador, fora do isolamento. Uma ação já iniciada pode continuar após uma pausa. Só os ficheiros exportados para a pasta de trabalho são revistos nos testes. Esta autorização não passa para tarefas novas.'));this.settings.append(this.externalHint);
  this.controls.writers.addEventListener('change',()=>{this.writerCustom=true;this.render();});this.controls.author.addEventListener('change',()=>{if(!this.writerCustom)this.setWriters([this.controls.author.value]);this.render();});
  this.controls.externalEnabled.addEventListener('change',()=>{this.controls.externalRisk.value='false';this.render();if(this.controls.externalEnabled.value==='true')this.loadExternalServers();});
  for(const key of ['externalServers','externalScope'])this.controls[key].addEventListener('change',()=>{this.controls.externalRisk.value='false';this.changed();});
  this.field('consensus',uiText('Decisão'));this.options(this.controls.consensus,[{value:'true',label:uiText('Maioria · 2/2 ou 2/3')}],'true');
  this.field('requestMode',uiText('Tipo de pedido'));this.options(this.controls.requestMode,[{value:'auto',label:uiText('Seguir o pedido · implementar só se pedido')},{value:'read-only',label:uiText('Só análise e planeamento')}],'auto');
  this.field('workspace',uiText('Local de trabalho'));this.options(this.controls.workspace,[{value:'direct',label:uiText('Projeto')},{value:'copy',label:uiText('Cópia privada')}],'direct');
  this.workspaceHint=node('p','cx-hint');this.workspaceHint.id='cx-workspace-hint';this.controls.workspace.setAttribute('aria-describedby',this.workspaceHint.id);
  for(const key of ['workspace','requestMode'])this.controls[key].addEventListener('change',()=>this.render());
  for(const [key,label,value] of [['guardTurns',uiText('Proteção · turnos por participante'),30],['guardMinutes',uiText('Proteção · minutos ativos'),60]]){const input=this.field(key,label,'input');input.type='number';input.min='0';input.step='1';input.required=true;input.value=value;input.setAttribute('aria-describedby','cx-guards-hint');}
  this.controls.cwd.addEventListener('change',()=>{this.controls.externalRisk.value='false';if(this.controls.externalEnabled.value==='true')this.loadExternalServers();});
  this.controls.project.addEventListener('change',()=>{const p=this.getState().projectCatalog?.projects.find(p=>p.id===this.controls.project.value);this.controls.cwd.value=p?.root||'';this.controls.externalRisk.value='false';if(this.controls.externalEnabled.value==='true')this.loadExternalServers();this.render();});
  this.settings.append(node('p','cx-hint',uiText('Plano e distribuição → implementação por etapas → revisão e testes por todos → conclusão. Com três modelos, dois votos bastam; testes falhados impedem concluir. Testes dos revisores correm em cópias isoladas, sem rede.')));
  this.settings.append(this.workspaceHint);
  this.guardHint=node('p','cx-hint',uiText('As proteções pausam a tarefa e preservam o progresso. 0 desativa a proteção respetiva. Cada retoma abre uma nova contagem de turnos e minutos. Podes ajustá-las antes de iniciar ou durante uma pausa.'));this.guardHint.id='cx-guards-hint';this.settings.append(this.guardHint);
  this.pauseNotice=node('p','notice');this.pauseNotice.setAttribute('role','status');this.pauseNotice.hidden=true;
  this.participants=node('div','cx-participants');this.participants.setAttribute('aria-label',uiText('Estado dos participantes'));
  this.workspaceInfo=node('div');this.workspaceInfo.hidden=true;
  this.approvals=node('div');this.goal=node('div','cx-goal');
  this.exchanges=node('details','cx-exchanges');this.exchanges.open=true;this.exchangeSummary=node('summary','',uiText('Diálogo'));this.messages=node('div','cx-messages');this.exchanges.append(this.exchangeSummary,this.messages);
  this.quotaHost=node('div');this.quotaHost.hidden=true;
  this.result=node('section','cx-result');this.result.setAttribute('aria-label',uiText('Resposta comum do Hydra'));
  this.draft=node('details','cx-draft');this.draft.append(node('summary','',uiText('Versões e aprovações')));this.versions=node('div');this.draft.append(this.versions);
  this.form=node('form','cx-composer');const label=this.promptLabel=node('label','sr-only',uiText('Pedido para o Hydra'));this.prompt=node('textarea');this.prompt.id='cx-prompt';label.htmlFor=this.prompt.id;this.prompt.rows=3;this.prompt.maxLength=16000;this.prompt.placeholder=uiText('O que queres que os participantes investiguem juntos?');this.prompt.addEventListener('input',()=>this.saveDraft());
  const actions=node('div','cx-actions');this.hint=node('span','cx-hint');this.send=node('button','primary',uiText('Iniciar ClaudeX'));this.send.type='submit';this.stop=this.button(uiText('Pausar todos'),async()=>{this.detail=await this.api('/api/claudex/'+this.selected+'/pause',{});this.renderDetail();this.render();});this.finish=this.button(uiText('Terminar tarefa'),async()=>{this.detail=await this.api('/api/claudex/'+this.selected+'/stop',{});this.renderDetail();this.render();});this.finish.title=uiText('Liberta as conversas; o progresso fica guardado.');this.finish.hidden=true;this.clone=this.button(uiText('Nova tarefa com este progresso'),()=>this.sendRequest(true));this.clone.title=uiText('Abre novas sessões com o progresso identificado; conserva a tarefa anterior.');this.clone.hidden=true;actions.append(this.hint,this.stop,this.finish,this.clone,this.send);this.form.append(label,this.prompt,actions);
  this.form.addEventListener('submit',e=>{e.preventDefault();this.sendRequest();});
  main.append(heading,this.intro,this.error,this.pauseNotice,this.settings,this.workspaceInfo,this.participants,this.approvals,this.goal,this.exchanges,this.result,this.quotaHost,this.draft,this.form);this.root.append(history,main);this.restoreDraft();
 }
 saveDraft(){localStorage.setItem('hydraq.claudex.draft.'+(this.selected||'new'),this.prompt.value);}
 restoreDraft(){this.prompt.value=localStorage.getItem('hydraq.claudex.draft.'+(this.selected||'new'))||'';}
 choose(id,{show=true}={}){this.saveDraft();this.selected=id;this.detail=null;this.workspaceInfo.hidden=true;this.workspaceInfo.replaceChildren();this.signature='';this.guardSignature='';this.detailStatus=null;this.pending=null;this.resultTask=null;this.exchanges.open=true;if(id)localStorage.setItem('hydraq.claudex',id);else{localStorage.removeItem('hydraq.claudex');this.controls.project.value='';this.controls.cwd.value='';this.controls.guardTurns.value=30;this.controls.guardMinutes.value=60;this.controls.participant2.value='';this.controls.requestMode.value='auto';this.controls.workspace.value='direct';this.writerCustom=false;this.setWriters([this.controls.author.value]);this.controls.implementationPreferences.value='';this.controls.externalEnabled.value='false';this.controls.externalRisk.value='false';for(const o of this.controls.externalServers.options)o.selected=false;for(const [index,role] of legacyRoles.entries())this.controls['participant'+index].value=role;for(const role of providers)this.controls[role+'Model'].value='';}this.restoreDraft();this.settings.open=!id;if(show)this.area.show('claudex');if(id)this.refresh();}
 /** Shows the task inside another panel (Conversations) while the Hydra tab is not open; null releases it. */
 inline(host){if(this.inlineHost===host)return;this.inlineHost=host;if(host&&this.area.view!=='claudex'){this.render();if(this.selected&&!this.detail)this.refresh();}}
 /** The pair of a new task; an existing task keeps its own. */
 setPair(pair){if(this.selected||![2,3].includes(pair?.length)||!pair.every(role=>providers.includes(role)))return;if([0,1,2].every(i=>this.controls['participant'+i].value===(pair[i]||'')))return;for(const i of [0,1,2])this.controls['participant'+i].value=pair[i]||'';this.render();}
 /** Request from the conversation composer: a new task runs in that conversation, or takes the project and folder of a new one. Returns the task, or null. */
 async requestInline(text,{projectId,cwd,conversationId,gitCheckpoint,permissionPolicy}={}){if(this.sending)return false;if(!this.selected){this.controls.project.value=projectId||'';this.controls.cwd.value=this.controls.project.value?this.getState().projectCatalog?.projects.find(p=>p.id===projectId)?.root||'':cwd||'';}this.prompt.value=text;this.sending=true;this.inlineConversation=conversationId||null;this.render();try{await this.submit(false,gitCheckpoint,permissionPolicy);return this.detail||{};}catch(e){this.toast(e.message);return null;}finally{this.sending=false;this.inlineConversation=null;this.render();}}
 setWriters(roles){for(const option of this.controls.writers.options)option.selected=roles.includes(option.value);}
 writers(){return [...this.controls.writers.selectedOptions].map(o=>o.value);}
 async loadExternalServers(){if(this.loadingExternal||this.selected)return;this.loadingExternal=true;this.externalError='';this.changed();try{const cwd=this.controls.cwd.value||this.getState().defaultCwd||'',data=await this.api('/api/claudex-external-servers?cwd='+encodeURIComponent(cwd));const selected=new Set([...this.controls.externalServers.selectedOptions].map(o=>o.value));this.controls.externalServers.replaceChildren(...data.servers.map(server=>{const option=node('option','',uiText`${server.name} · configuração ${names[server.source]||server.source}`);option.value=server.id;option.dataset.signature=server.signature;option.selected=selected.has(server.id);return option;}));this.externalLoadedCwd=cwd;}catch(e){this.externalError=e.message;this.controls.externalServers.replaceChildren();}finally{this.loadingExternal=false;this.render();}}
 roles(){return this.detail?.roles|| (this.detail?legacyRoles:[this.controls.participant0.value,this.controls.participant1.value,this.controls.participant2.value].filter(Boolean));}
 changePair(index){const chosen=this.controls['participant'+index].value;for(const i of [0,1,2])if(i!==index&&chosen&&this.controls['participant'+i].value===chosen){const used=[0,1,2].filter(k=>k!==i).map(k=>this.controls['participant'+k].value);this.controls['participant'+i].value=i===2?'':providers.find(role=>!used.includes(role));}this.render();}
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
  const listSig=JSON.stringify([state.claudex?.records,this.selected]);if(this.listSig!==listSig){this.listSig=listSig;this.list.replaceChildren();for(const r of [...(state.claudex?.records||[])].reverse()){const b=this.button(pairName(r.roles||legacyRoles)+' · '+r.title,()=>this.choose(r.id));b.setAttribute('aria-current',String(r.id===this.selected));b.append(node('small','',r.retired?uiText('Arquivada'):labels[r.status]||r.status));this.list.append(b);}}
  const projects=(state.projectCatalog?.projects||[]).filter(p=>!p.archived);this.options(this.controls.project,[{value:'',label:uiText('Sem projeto')},...projects.map(p=>({value:p.id,label:p.name}))],this.detail?.projectId??this.controls.project.value);
  const roles=this.roles();this.heading.textContent=pairName(roles);if(visible)document.getElementById('project-name').textContent=pairName(roles);for(const role of providers){this.models(role);this.controls[role+'Model'].parentElement.classList.toggle('hidden',!roles.includes(role));this.controls[role+'Effort'].parentElement.classList.toggle('hidden',!roles.includes(role));}this.options(this.controls.author,roles.map(value=>({value,label:names[value]})),this.detail?.author||this.controls.author.value);for(const [index,role] of roles.entries())this.controls['participant'+index].value=role;
  for(const [key,input] of Object.entries(this.controls))input.disabled=this.sending||Boolean(this.selected&&!(status==='paused'&&!pausing&&key.startsWith('guard')));if(this.controls.project.value)this.controls.cwd.disabled=true;
  const copyAvailable=Boolean(state.claudex?.workspaceModes?.includes('copy')),reading=this.controls.requestMode.value==='read-only';
  this.controls.workspace.querySelector('option[value=copy]').disabled=!copyAvailable;this.controls.workspace.disabled||=reading;
  this.workspaceHint.textContent=reading?uiText('Só análise e planeamento: não cria cópia nem altera o projeto.'):(this.controls.workspace.value==='copy'?uiText('Os modelos trabalham numa cópia privada. O resultado só chega ao projeto depois dos testes e da aprovação final.'):uiText('Os modelos trabalham no projeto. As alterações são feitas durante a implementação.'))+(!copyAvailable?uiText(' A cópia privada requer o servidor atualizado.'):'');
  const selectedWriters=this.detail?.writers||(!this.writerCustom?[this.controls.author.value]:this.writers());this.options(this.controls.writers,roles.map(value=>({value,label:names[value]})));this.setWriters(selectedWriters.filter(k=>roles.includes(k)));
  const multiAvailable=copyAvailable&&state.claudex?.multiWriter&&this.controls.workspace.value==='copy'&&!reading;
  if(!this.selected&&!multiAvailable)this.setWriters([this.controls.author.value]);this.controls.writers.disabled||=!multiAvailable;
  this.controls.implementationPreferences.disabled||=reading;
  this.externalHint.hidden=this.controls.externalEnabled.value!=='true';this.externalHint.textContent=this.externalError||uiText('Os servidores escolhidos executam com as permissões do utilizador, fora do isolamento. Sem aprovação por chamada; ações já iniciadas podem continuar após uma pausa. Só os ficheiros exportados para a pasta de trabalho são revistos nos testes. A autorização não passa para tarefas novas.');
  this.controls.externalEnabled.disabled||=reading||!state.claudex?.externalMcp;
  for(const key of ['externalServers','externalScope','externalRisk']){this.controls[key].parentElement.hidden=this.controls.externalEnabled.value!=='true';this.controls[key].disabled||=reading||this.loadingExternal;}
  const committing=this.detail?.workspace?.action==='apply'||Boolean(this.detail?.workspace?.applying)&&active.has(status)&&!pausing;
  const disabledClients = roles.filter(role => state.providers?.[role]?.enabled === false || state.providers?.[role]?.disabling);
  const connected=roles.every(role=>state.providers?.[role]?.connection==='connected');
  for (const index of [0, 1, 2]) for (const option of this.controls['participant' + index].options) {
    const info = state.providers?.[option.value];
    option.disabled = info?.enabled === false || info?.disabling === true;
  }
  this.badge.textContent=interruptionPending?uiText('Interrupção por confirmar'):pausing?uiText('A pausar todos'):retired?uiText('Arquivada'):(active.has(status)?(this.detail?.workflow?.replan?uiText('A preparar novo plano'):this.detail?.workflow?.objection&&!this.detail.workflow.objection.response?uiText('Principal a responder à objeção'):phaseLabels[this.detail?.workflow?.phase]):null)||labels[status]||uiText('Plano, execução e revisão');this.error.textContent=state.claudex?.error||(retired?'':this.detail?.error)||'';this.error.hidden=!this.error.textContent;
  this.stop.hidden=!running;this.stop.disabled=pausing||this.sending||committing;this.stop.textContent=pausing?uiText('A pausar…'):interruptionPending?uiText('Voltar a tentar parar'):uiText('Pausar todos');this.finish.hidden=(status!=='paused'&&!this.detail?.workspace?.applying)||pausing||retired||committing;this.finish.textContent=this.detail?.workspace?.applying?uiText('Parar e desfazer aplicação'):uiText('Terminar tarefa');this.finish.disabled=this.sending||Boolean(state.claudex?.error);this.clone.hidden=!canResume||status==='paused'||Boolean(this.detail?.workspace?.applying);this.clone.disabled=this.sending||!this.detail||!connected||Boolean(state.claudex?.error);this.send.textContent=this.sending?uiText('A enviar…'):canResume?(this.detail?.pause?.kind==='workspace-reserved'?uiText('Confirmar alterações e retomar'):uiText('Retomar a mesma tarefa')):running?uiText('Atualizar o pedido de todos'):this.selected?uiText('Nova tarefa a partir deste progresso'):uiText('Iniciar ')+pairName(roles);this.send.disabled=committing||this.sending||Boolean(this.selected&&!this.detail)||!connected||Boolean(state.claudex?.error)||status==='preparing'||pausing||interruptionPending;if(!running&&!canResume&&!reading&&this.controls.workspace.value==='copy'&&!copyAvailable){this.send.disabled=true;this.clone.disabled=true;}
  this.prompt.maxLength=running||canResume?8000:16000;this.prompt.placeholder=canResume?uiText('Novo requisito opcional para todos; retoma também com a caixa vazia.'):this.selected&&!running?uiText('Pedido para uma nova tarefa com este progresso.'):uiText('O que queres que os participantes investiguem juntos?');
  this.hint.textContent=disabledClients.length ? uiText('Ativa em Configurações → Clientes: ') + disabledClients.map(role => names[role]).join(', ') + '.' : !connected?uiText('Liga ')+roles.map(role=>names[role]).join(uiText(' e '))+uiText(' nas Conversas.'):pausing?uiText('A preservar o progresso e a interromper os clientes.'):running?uiText('Novos requisitos chegam a todos e anulam aprovações anteriores.'):canResume?uiText('Retoma o mesmo histórico e as mesmas sessões nativas. Um requisito novo é opcional.'):this.selected?(this.detail?.inPlace?uiText('Nova tarefa na mesma conversa e com as mesmas sessões, com o progresso anterior identificado.'):uiText('Abre uma nova tarefa e novas sessões, com o progresso anterior identificado.')):uiText('Uma tarefa · 2–3 participantes · uma resposta comum');
  if(committing){this.hint.textContent=uiText('A aplicar o resultado aprovado ao projeto. Aguarda o fim desta operação.');this.send.textContent=uiText('A aplicar ao projeto…');}
  this.finish.title=this.detail?.inPlace?uiText('Para a tarefa e devolve a conversa ao modo anterior; o progresso fica guardado.'):uiText('Liberta as conversas; o progresso fica guardado.');
  const pauseReason=this.detail?.pauseReason||this.detail?.pause?.reason;this.pauseNotice.hidden=!canResume&&!retired;this.pauseNotice.textContent=retired?uiText('Arquivada: o agy desta tarefa trabalhava no ambiente privado antigo do Hydra, que foi retirado, e a sua sessão não pode ser retomada. Podes continuar o conteúdo numa tarefa nova, com sessões novas e o progresso identificado.'):canResume?(pauseReason||this.detail?.error||uiText('Progresso preservado. A retoma é explícita.'))+(status==='paused'?uiText` Ajusta as proteções ${inline?uiText('no painel Modo'):uiText('acima')}, se necessário, e retoma quando quiseres.`:uiText(' A retoma pode ser recusada se a entrega nativa for incerta. Podes abrir uma nova tarefa com este progresso e novas sessões.')):'';
  // A pause reason already opens the pause notice; the alert above would repeat it.
  if(canResume&&this.error.textContent&&this.pauseNotice.textContent.startsWith(this.error.textContent))this.error.hidden=true;
  if((state.claudex?.protocolVersion||0)<4){this.error.textContent=uiText('Reinicia o servidor HYDRAQ para ativar esta versão do Hydra. O histórico continua disponível.');this.error.hidden=false;this.send.disabled=true;this.stop.disabled=true;this.finish.disabled=true;this.clone.disabled=true;}
  if(!this.selected){this.workspaceInfo.hidden=true;this.workspaceInfo.replaceChildren();this.participants.replaceChildren();this.goal.replaceChildren();this.messages.replaceChildren();this.result.replaceChildren();this.versions.replaceChildren();this.approvals.replaceChildren();this.exchanges.hidden=this.draft.hidden=true;}
  this.view={roles,status,running,canResume,pausing,interruptionPending,connected,stopLabel:this.stop.textContent,stopDisabled:this.stop.disabled};
  // In a conversation the request and the common answer are its own messages, around this card.
  this.settings.hidden=this.promptLabel.hidden=this.prompt.hidden=this.send.hidden=this.hint.hidden=this.goal.hidden=this.result.hidden=inline;if(inline)this.stop.hidden=true;this.form.hidden=inline&&this.finish.hidden&&this.clone.hidden;this.intro.hidden=!inline||Boolean(this.selected);
  const quotas=this.quotaRows(this.detail),quotaSignature=JSON.stringify(quotas);
  if(this.quotaSignature!==quotaSignature){
   this.quotaSignature=quotaSignature;this.quotaHost.hidden=!quotas.length;
   this.quotaHost.replaceChildren(...(quotas.length?[this.quotaSection(quotas)]:[]));
  }
  this.changed();
 }
 async refresh(){if(this.loading||!this.selected)return;this.loading=true;const id=this.selected;try{const d=await this.api('/api/claudex/'+id);if(id!==this.selected)return;this.detail=d;this.renderDetail();this.render();}catch(e){this.error.textContent=e.message;this.error.hidden=false;}finally{this.loading=false;}}
 renderDetail(){
  const d=this.detail;if(!d)return;const roles=this.roles();
  this.controls.cwd.value=d.cwd;this.controls.author.value=d.author;this.controls.consensus.value=String(d.consensus);this.controls.requestMode.value=d.workflow?.mode||'read-only';
  this.controls.externalEnabled.value='false';this.controls.externalRisk.value='false';this.controls.implementationPreferences.value=d.implementationPreferences||'';
  this.controls.workspace.value=d.workspaceMode||(d.workspace?'copy':'direct');
  const guardSignature=JSON.stringify([d.id,d.guards]);if(this.guardSignature!==guardSignature){this.guardSignature=guardSignature;this.controls.guardTurns.value=d.guards?.turns??30;this.controls.guardMinutes.value=d.guards?.minutes??60;}if(d.status==='paused'&&this.detailStatus!=='paused')this.settings.open=true;this.detailStatus=d.status;
  const sig=JSON.stringify(d);if(sig===this.signature)return;this.signature=sig;
  this.workspaceInfo.hidden=false;this.workspaceInfo.replaceChildren(...this.taskCards(d));
  // Updates rebuild the view; what the person opened stays open.
  const opened=new Set([...this.main.querySelectorAll('details[data-key][open]')].map(e=>e.dataset.key));
  const request=d.messages.find(m=>m.type==='request')?.text||'';this.goal.replaceChildren(node('h2','',uiText('Pedido comum')),node('p','',request));if(request)this.goal.append(this.button(uiText('Copiar pedido'),()=>navigator.clipboard.writeText(request)));
  this.participants.dataset.count=String(roles.length);this.participants.replaceChildren();for(const role of roles){const p=d.participants[role],m=d.members[role],card=node('section','cx-participant');card.dataset.client=role;card.append(node('strong','',names[role]),node('span','',states[p?.status]||p?.status||uiText('A preparar')),node('small','',m?.model||''),node('small','',uiText`${m?.turns||0} turnos no total · proteção ${d.guards?.turns?d.guards.turns+uiText(' por retoma'):uiText('desativada')}`));const read=d.read?.[role];card.append(node('small','cx-last-read',read?uiText`Última leitura: mensagem ${read.seq} · ${read.at?new Date(read.at).toLocaleTimeString(uiLocale(),{hour:'2-digit',minute:'2-digit',second:'2-digit'}):uiText('hora não registada')}`:uiText('Ainda não leu o diálogo')));if(read?.at)card.lastChild.title=new Date(read.at).toLocaleString(uiLocale());for(const a of p?.activity||[]){const line=node('small','cx-tool-activity',a.name);if(a.at&&this.elapsed)line.append(document.createTextNode(' · '),this.elapsed(a.at));card.append(line);}if(p?.thought){const thought=node('details','claude-thought'),heading=node('summary','',p.thoughtLabel||uiText('Resumo do raciocínio · Claude'));thought.dataset.key='thought:'+role;
    // agy: open while it works, closed when it is done; a click counts for this request and phase.
    const live=['starting','running','waiting'].includes(p.status),choice=(this.thoughtChoices||=new Map()).get(thought.dataset.key),own=choice&&choice.live===live&&choice.request===m?.requestId;
    thought.open=own?choice.open:p.thoughtOpensLive?live:opened.has(thought.dataset.key);
    heading.addEventListener('click',()=>this.thoughtChoices.set(thought.dataset.key,{live,request:m?.requestId,open:!thought.open}));
    thought.append(heading,node('div','claude-thought-text',p.thought));card.append(thought);}if(d.workflow?.reviews?.[role])card.append(node('small','',uiText`Revisão: ${reviewLabels[d.workflow.reviews[role].decision]||d.workflow.reviews[role].decision}`));for(const t of d.workflow?.tests?.filter(t=>t.role===role&&t.round===d.workflow.round)||[])card.append(node('small','',uiText`Teste: ${testLabels[t.status]||t.status}${t.supersededBy?uiText(' (substituído)'):''} · ${t.command}`));if(d.approvals[role])card.append(node('span','cx-approved',uiText('Aprovou a versão atual')));if(p?.answer){const detail=node('details');detail.dataset.key='answer:'+role;detail.open=opened.has(detail.dataset.key);detail.append(node('summary','',uiText('Última contribuição')),this.markdown(p.answer));card.append(detail);}this.participants.append(card);}
  const pending=(this.getState()?.approvals||[]).filter(a=>roles.some(role=>d.members[role]?.conversationId===a.conversationId));this.approvals.replaceChildren();for(const a of pending)this.approvals.append(this.button(uiText('Responder à decisão de ')+names[a.provider||a.id.split(':')[0]],()=>this.openConversation(a.conversationId),'cx-decision'));
  // The newest contributions stay in view unless the person scrolled back to read.
  const pinned=this.messages.scrollHeight-this.messages.scrollTop-this.messages.clientHeight<40;
  this.exchanges.hidden=false;this.exchangeSummary.textContent=uiText`Diálogo · ${d.messages.length-1} contributos e atualizações`;this.messages.replaceChildren();for(const m of d.messages.filter(m=>m.type!=='request'))this.messages.append(this.messageCard(m,this.main.classList.contains('cx-inline')));if(pinned)this.messages.scrollTop=this.messages.scrollHeight;
  this.result.replaceChildren();if(d.result){if(this.resultTask!==d.id){this.resultTask=d.id;this.exchanges.open=false;}this.result.append(node('h2','',d.result.label||outcomes[d.result.outcome]||(d.result.agreed?outcomes.agreement:outcomes.synthesis)),this.markdown(d.result.text),this.button(uiText('Copiar resposta'),()=>navigator.clipboard.writeText(d.result.text)));}
  else if(d.candidateId)this.result.append(node('p','cx-hint',uiText('A versão candidata está em revisão. O documento final aparece aqui quando o processo terminar.')));
  this.draft.hidden=!d.candidates.length;this.versions.replaceChildren(...this.versionList(d,opened),...this.validationList(d));
 }
 quotaRows(task){return hydraQuotaUsage(task,this.getState()?.conversations||[]);}
 quotaSection(rows){
  const section=node('section','cx-workspace');
  section.append(node('strong','',uiText('Consumo de quota da tarefa')));
  for(const row of rows)section.append(quotaUsageView(row,{heading:[names[row.provider],row.model].filter(Boolean).join(' · ')}));
  return section;
 }
 taskCards(d){const cards=[this.workspaceCard(d)],remove=this.removeCard(d),steps=d.workflow?.steps||[];
  if(this.openCheckpoint&&d.gitCheckpoint&&['completed','no-agreement','interrupted'].includes(d.status)&&!d.pause?.draining&&!d.pause?.interruptionPending&&!d.workspace?.applying){
   const card=node('section','cx-workspace');
   card.append(node('strong','',uiText('Ponto de segurança Git · ')+d.gitCheckpoint.commit.slice(0,12)),this.button(uiText('Ver alterações desde o ponto de segurança'),()=>this.openCheckpoint(d)));
   cards.push(card);
  }
  if(steps.length){const card=node('section','cx-workspace');card.append(node('strong','',uiText('Etapas de implementação')));for(const [i,step] of steps.entries())card.append(node('p','',`${i+1}. ${names[step.role]||step.role}: ${step.instructions}${i===(d.workflow.stepIndex||0)&&['implementing','fixing'].includes(d.workflow.phase)?uiText(' · em execução'):''}`));card.append(node('small','',uiText('Escrita sequencial em pastas independentes; correções: ')+(names[d.workflow.approvedPlan?.implementation?.fixer]||names[d.author]||d.author)));cards.push(card);}
  if(d.externalMcp?.enabled){const card=node('section','cx-workspace');card.append(node('strong','',uiText('Ferramentas externas · fora do isolamento')),node('p','',d.externalMcp.servers.map(s=>s.name+' ('+s.source+')').join(', ')+uiText(' · autorizados: ')+d.externalMcp.roles.map(r=>names[r]).join(', ')),node('p','cx-hint',uiText('Ações externas não foram certificadas pelos testes isolados. Uma ação já iniciada pode continuar após uma pausa.')));for(const call of d.externalCalls||[])card.append(node('p','',`${names[call.role]} · ${call.server} / ${call.tool} · ${externalStates[call.status]||call.status}${call.error?' · '+call.error:''}`));cards.push(card);}
  if(remove)cards.push(remove);return cards;}

 /** A participant leaves only because the user says so, in a pause. The principal cannot, and two have to stay. */
 removeCard(d){
  const others=(d.roles||[]).filter(role=>role!==d.author);
  if(!d.workflow||d.roles?.length!==3||!resumable.has(d.status)||d.released||d.pause?.draining||d.retired)return null;
  const card=node('section','cx-workspace cx-remove'),stuck=d.pause?.stuck;card.setAttribute('aria-label',uiText('Retirar participante'));
  card.append(node('strong','',uiText('Continuar sem um participante')),node('p','cx-hint',uiText`Se um participante está preso ou sem acesso, podes retirá-lo e retomar com os outros dois, que passam a ter de estar de acordo. Os votos e revisões dele nesta versão deixam de contar. ${names[d.author]||d.author} é o principal e não pode sair.`));
  for(const role of [...others].sort((a,b)=>Number(b===stuck)-Number(a===stuck)))card.append(this.button(uiText`Retirar ${names[role]||role}${role===stuck?uiText(' (parece preso)'):''}`,()=>this.workspaceAction(d.id,'removeParticipant',{role,confirm:true})));
  return card;
 }
 workspaceCard(d){
  const card=node('section','cx-workspace'),space=d.workspace,mode=d.workspaceMode||(space?'copy':'direct'),reading=!d.workflow||d.workflow.mode==='read-only';card.setAttribute('aria-label',uiText('Local de trabalho do Hydra'));
  card.dataset.workspace=mode;card.append(node('strong','',uiText('Local de trabalho')));
  let state=reading?uiText('Só análise e planeamento'):mode==='copy'?uiText('Trabalho na cópia privada'):uiText('No projeto');
  let note=reading?uiText('Este pedido não altera o projeto.'):mode==='copy'?uiText('O projeto recebe o resultado depois dos testes e da aprovação final.'):uiText('As alterações são feitas no projeto durante a implementação.');
  if(space?.lost){state=uiText('Projeto libertado sem desfazer');note=uiText('A pasta privada desapareceu com a aplicação a meio. O projeto pode ter parte da versão aplicada; verifica-o antes de continuar.');}
  else if(space?.folderLost&&space.applying){state=uiText('Aplicação por concluir');note=uiText('O projeto pode estar parcialmente alterado, e a pasta privada desapareceu, por isso não dá para desfazer. Se foi movida ou está num disco desligado, repõe-na e tenta outra vez.');}
  else if(space?.applying){state=uiText('Aplicação por concluir');note=uiText('O projeto pode estar parcialmente alterado. A recuperação fica guardada até a aplicação terminar ou ser desfeita.');if(active.has(d.status)||space.action==='apply')state=uiText('A aplicar ao projeto');}
  else if(space?.applied){const count=space.applied.fileCount??space.applied.files?.length??0;state=uiText('Aplicado ao projeto');note=uiText`Resultado aprovado aplicado · ${count} ${count===1?uiText('ficheiro'):uiText('ficheiros')}.`;if(space.applied.drift?.length)note+=uiText(' Há alterações externas indicadas na conclusão.');}
  else if(space?.kept){state=uiText('Trabalho guardado na cópia');note=uiText('O trabalho ficou guardado e não foi aplicado ao projeto.');}
  else if(space?.left){state=uiText('Sem alterações aplicadas');note=uiText('A tarefa terminou sem aplicar alterações ao projeto.');}
  else if(space&&resumable.has(d.status)){state=uiText('Cópia privada em pausa');}
  card.append(node('span','cx-workspace-state',state),node('code','cx-workspace-project',d.cwd||space?.origin||''),node('p','cx-hint',note));
  if(d.pause?.kind==='workspace-reserved'){
   card.append(node('p','',uiText('A tarefa altera ficheiros usados pelo Git. Ao retomar, confirmas esta versão desses ficheiros.')));
   const list=node('ul');for(const file of Object.keys(d.pause.confirm||{}))list.append(node('li','',file));if(list.childElementCount)card.append(list);
  }
  if(space?.folderLost&&space.applying&&!space.action)card.append(this.button(uiText('Libertar o projeto'),()=>this.workspaceAction(d.id,'releaseLostWorkspace',{confirm:true})));
  if((space?.kept||space?.applying)&&space.folder&&!space.removed&&!space.folderLost){
   const recovery=node('details');recovery.append(node('summary','',uiText('Pasta de recuperação')),node('code','cx-workspace-path',space.folder),this.button(uiText('Copiar pasta de recuperação'),()=>navigator.clipboard.writeText(space.folder)));card.append(recovery);
  }
  if(space?.actionError)card.append(node('p','notice',space.actionError));
  if(space?.kept&&space.left&&!space.removed){
   if(space.applying){if(!space.action)card.append(this.button(uiText('Parar e desfazer aplicação'),()=>this.workspaceAction(d.id,'stop')));}
   else{
    if(!space.applied){
     const confirm=space.actionConfirm;
     if(confirm){card.append(node('p','',uiText('Esta cópia altera ficheiros usados pelo Git. Ao confirmar, aceitas esta versão destes ficheiros.')));const list=node('ul');for(const file of Object.keys(confirm))list.append(node('li','',file));card.append(list);}
     const apply=this.button(confirm?uiText('Confirmar e aplicar'):uiText('Aplicar ao projeto'),()=>this.workspaceAction(d.id,'applySavedWorkspace',confirm?{confirm}:{}));apply.disabled=Boolean(space.action)||Boolean(d.pause?.draining)||!d.workflow?.validatedVersion;card.append(apply);
    }
    const discard=this.button(uiText('Apagar cópia'),()=>this.workspaceAction(d.id,'deleteSavedWorkspace'));discard.disabled=Boolean(space.action)||Boolean(d.pause?.draining);card.append(discard);
   }
  }
  return card;
 }
 async workspaceAction(id,action,body={}){
  if(action==='deleteSavedWorkspace'&&!window.confirm(uiText('Apagar esta cópia guardada e o trabalho que contém? Esta ação não altera o projeto e não pode ser desfeita.')))return;
  if(action==='deleteTask'&&!window.confirm(uiText('Apagar esta tarefa? O diálogo, as versões, os votos e as saídas dos testes desaparecem. A resposta publicada fica na conversa.')))return;
  if(action==='removeParticipant'&&!window.confirm(uiText`Retirar ${names[body.role]||body.role} desta tarefa? Não volta a participar nela, e a conversa dele regressa ao modo normal.`))return;
  if(action==='releaseLostWorkspace'&&!window.confirm(uiText('Libertar o projeto sem desfazer? Usa isto só se a pasta privada foi mesmo apagada. O projeto fica como está, possivelmente com parte da versão aplicada, e deixa de ser possível desfazer.')))return;
  const detail=await this.api('/api/claudex/'+id+'/'+action,action==='deleteSavedWorkspace'?{confirm:true}:body);
  if(action==='deleteTask'){this.cache.delete(id);this.cards.get(id)?.element.remove();this.cards.delete(id);if(this.selected===id){this.selected=null;this.detail=null;}this.render();this.changed();return;}
  this.cache.set(id,{updatedAt:detail.updatedAt,detail});const entry=this.cards.get(id);if(entry)entry.signature=null;
  if(this.selected===id){this.detail=detail;this.renderDetail();this.render();}this.changed();
 }
 messageCard(m,inline){const card=node('article','cx-message'),asked=isClarification(m);card.dataset.client=asked?'clarification':m.from;card.append(node('strong','',`${names[m.from]||m.from} · ${asked?uiText('Esclarecimento'):kinds[m.type]||m.type} · #${m.seq}`));if(m.replyTo)card.append(node('small','',uiText`Em resposta a #${m.replyTo}`));if(m.type==='checkpoint'){let previous;try{previous=JSON.parse(m.text).previousTask;}catch{}card.append(node('p','',uiText('Progresso anterior incluído nesta tarefa. As aprovações anteriores não transitam.')));if(previous)card.append(this.button(uiText('Abrir tarefa anterior'),()=>inline&&this.openTask?this.openTask(previous):this.choose(previous)));}else if(asked)card.append(...clarification(m));else card.append(this.markdown(m.text));return card;}
 versionList(d,opened=new Set()){return d.candidates.map(c=>{const detail=node('details');detail.dataset.key='version:'+c.id;detail.open=opened.has(detail.dataset.key);detail.append(node('summary','',uiText`Versão ${c.version} · ${c.id===d.candidateId?uiText('atual'):uiText('substituída')}${d.result?.id===c.id?uiText(' · publicada'):''}${c.outcome?' · '+(candidateKinds[c.outcome]||c.outcome):''}`),this.markdown(c.text));for(const [role,v] of Object.entries(c.votes||(c.id===d.candidateId?d.workflow?.votes:null)||{}))detail.append(node('p','',`${names[role]}: ${reviewLabels[v.decision]||v.decision} — ${v.reason}`));return detail;});}
 validationList(d){return (d.workflow?.rounds||[]).map(round=>{const detail=node('details');detail.append(node('summary','',uiText`Revisão e testes · ronda ${round.round}`));for(const [role,review] of Object.entries(round.reviews||(round.round===d.workflow.round?d.workflow.reviews:{})||{})){detail.append(node('p','',`${names[role]}: ${reviewLabels[review.decision]||review.decision} — ${review.reason}`));if(review.visualReview)detail.append(node('p','',`${names[role]} · Visual: ${review.visualReview.status==='reviewed'?uiText('avaliação declarada após entrega das capturas'):uiText('não validado')} — ${review.visualReview.reason}`));for(const old of review.superseded||[])detail.append(node('p','',uiText`${names[role]}, revisão anterior ao esclarecimento: ${reviewLabels[old.decision]||old.decision} — ${old.reason}`));}for(const t of d.workflow.tests.filter(t=>t.round===round.round)){detail.append(node('strong','',uiText`${names[t.role]} · ${testLabels[t.status]||t.status} · código ${t.exitCode??'—'}${t.supersededBy?uiText(' · substituído'):''}`),...(t.supersedes?[node('p','',uiText`Substitui um teste anterior: ${t.supersedeReason}`)]:[]),node('p','',t.purpose),node('pre','',t.command),node('pre','',(t.error||'')+'\n'+(t.output||'')+(t.truncated?uiText('\n[Saída truncada a 32 000 caracteres]'):'')));if(t.outputFile){const full=this.button(uiText('Ver saída completa'),async()=>{full.disabled=true;try{const {output,length,complete}=await this.api('/api/claudex/'+d.id+'/tests/'+t.id+'/output');if(typeof output!=='string'||complete===false||(length!==undefined&&output.length!==length))throw Error(uiText('A saída completa está indisponível. O excerto foi conservado; tenta novamente depois de repor o ficheiro ou o acesso.'));full.previousElementSibling.textContent=(t.error||'')+'\n'+output;full.remove();}catch(e){full.disabled=false;this.toast(e.message);}});detail.append(full);}if(t.visual){const m=t.visual.metrics||{};detail.append(node('p','',uiText`Guião visual · rAF ${m.rafHz?.toFixed(1)??'—'} Hz · p95 ${m.p95Ms?.toFixed(1)??'—'} ms · ${m.longFramesOver50Ms??0} intervalos acima de 50 ms. Medição sem capturas, numa execução separada.`));for(const error of [...(t.visual.errors||[]),...(t.visual.probeErrors||[])])detail.append(node('p','notice',error));for(const check of t.visual.checks||[])detail.append(node('p','',`${check.passed?uiText('Passou'):uiText('Falhou')}: ${check.name}${check.error?' · '+check.error:''}`));for(const timing of t.visual.durations||[])detail.append(node('p','',`${timing.key} ${timing.value}: ${timing.ms.toFixed(1)} ms${timing.startObserved&&timing.endObserved?uiText(' · início e fim observados'):uiText(' · observação parcial')}`));for(const limit of t.visual.limits||[])detail.append(node('small','',limit));}this.testImages(detail,d,t);}return detail;});}
 testImages(detail,d,test){
  if(!test.artifacts?.length)return;
  detail.append(node('p','',uiText`${test.artifacts.length} captura(s) da versão testada · gerar imagens não significa avaliação visual.`));
  for(const meta of test.artifacts){
   const box=node('figure','cx-test-capture'),caption=node('figcaption','',meta.name+' · '+meta.width+' × '+meta.height),button=this.button(uiText('Ver captura · ')+meta.name,async()=>{
    button.disabled=true;
    try{
     const result=await this.api('/api/claudex/'+d.id+'/tests/'+test.id+'/images/'+meta.id);
     if(!['image/png','image/jpeg','image/webp'].includes(result.image?.mimeType)||result.sha256!==meta.sha256)throw Error(uiText('Captura indisponível ou alterada.'));
     const img=node('img','cx-test-image');img.alt=meta.name;img.src='data:'+result.image.mimeType+';base64,'+result.image.data;
     img.addEventListener('error',()=>{img.remove();button.disabled=false;button.hidden=false;this.toast(uiText('Não foi possível apresentar esta captura.'));},{once:true});
     box.append(img);button.hidden=true;
    }catch(e){button.disabled=false;this.toast(e.message);}
   });box.append(caption,button);detail.append(box);
  }
 }
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
   const d=this.detailOf(record.id,live),requests=(d?.messages||[]).filter(m=>m.from==='user'&&!isClarification(m));
   // A past task waits for its detail, so that its card does not jump from the end to its place.
   if(!d&&!live&&!this.cache.get(record.id)?.failed)continue;
   for(const message of requests)entries.push({at:message.at,record,message});
   if(requests.length)shown.add(record.id);
   entries.push({at:requests.at(-1)?.at||'￿',record,card:true});
  }
  return {tasks,entries,shown,signature:JSON.stringify([liveId,tasks.map(r=>[r.id,r.id===liveId?null:[r.status,r.updatedAt,this.cache.get(r.id)?.failed,this.cache.get(r.id)?.detail?.updatedAt,this.quotaRows(this.detailOf(r.id))],entries.filter(e=>e.record===r).map(e=>e.message?.seq??'card')])])};
 }
 /** A finished task in the conversation: one line that opens to its dialogue and versions. Kept between renders, so what was opened stays open. */
 card(record){
  const d=this.detailOf(record.id),signature=JSON.stringify([record.status,record.retired,record.released,record.unvalidated,record.result,d?.messages.length,d?.candidates.length,d?.workspace,record.workspace,d?.deletionError,record.deletionError,this.cache.get(record.id)?.failed,this.quotaRows(d)]);
  let entry=this.cards.get(record.id);
  if(!entry){const element=node('details','cx-card'),pair=record.roles||legacyRoles;element.dataset.task=record.id;element.style.setProperty('--pair-a',`var(--c-${pair[0]})`);element.style.setProperty('--pair-b',`var(--c-${pair[1]})`);element.addEventListener('toggle',()=>{if(element.open)this.fillCard(record.id);});entry={element};this.cards.set(record.id,entry);}
  if(entry.signature!==signature){
   entry.signature=signature;entry.filled=false;const summary=node('summary'),count=d?.messages.filter(m=>m.from!=='user').length;
   summary.append(node('strong','','Hydra · '+pairName(record.roles||legacyRoles)),node('span','cx-card-state',record.retired?uiText('Arquivada'):record.result?.label||(labels[record.status]||record.status)+(record.unvalidated?uiText(' · alterações por validar'):'')));
   if(count!==undefined)summary.append(node('small','',`${count} ${count===1?uiText('contributo'):uiText('contributos')}`));
   entry.element.dataset.status=record.status;entry.element.replaceChildren(summary);if(entry.element.open)this.fillCard(record.id);
  }
  return entry.element;
 }
 fillCard(id){
  const entry=this.cards.get(id),d=this.detailOf(id);if(!entry||entry.filled)return;const failed=this.cache.get(id)?.failed;if(failed){entry.filled=true;const body=node('div','cx-card-body'),record=this.getState()?.claudex?.records.find(r=>r.id===id);if(record?.workspace)body.append(this.workspaceCard(record));body.append(node('p','',uiText('Não foi possível carregar os detalhes desta tarefa. O estado acima é o mais recente recebido.')),this.button(uiText('Tentar carregar novamente'),()=>{this.cache.delete(id);entry.signature=null;entry.filled=false;if(record)this.load(record);this.changed();}));entry.element.append(body);return;}if(!d)return;entry.filled=true;
  const body=node('div','cx-card-body'),list=node('div','cx-messages');if(d.deletionError)body.append(node('p','notice',d.deletionError));body.append(...this.taskCards(d));for(const m of d.messages.filter(m=>m.from!=='user'||isClarification(m)))list.append(this.messageCard(m,true));body.append(list);
  if(d.candidates.length){const versions=node('details','cx-draft');versions.append(node('summary','',uiText('Versões e aprovações')),...this.versionList(d),...this.validationList(d));body.append(versions);}
  const quotas=this.quotaRows(d);if(quotas.length)body.append(this.quotaSection(quotas));
  body.append(this.button(uiText('Abrir no separador Hydra'),()=>this.choose(id)));
  // Finished, given back and with nothing left to apply: only then can the user remove it.
  const record=this.getState()?.claudex?.records.find(r=>r.id===id);
  if(record&&['completed','no-agreement','interrupted'].includes(record.status)&&(!record.inPlace||record.released)&&!(record.workspace?.kept&&!record.workspace.removed)&&!record.workspace?.applying)body.append(this.button(d.deletionError?uiText('Tentar apagar tarefa novamente'):uiText('Apagar tarefa'),()=>this.workspaceAction(id,'deleteTask',{confirm:true})));
  entry.element.append(body);
 }
 guards(){const values=[this.controls.guardTurns.value,this.controls.guardMinutes.value],guards={turns:Number(values[0]),minutes:Number(values[1])};if(values.some(value=>!value.trim())||Object.values(guards).some(value=>!Number.isSafeInteger(value)||value<0))throw Error(uiText('As proteções devem ser números inteiros iguais ou superiores a 0.'));return guards;}
 async sendRequest(newTask=false){if(this.sending)return;this.sending=true;this.render();try{await this.submit(newTask);}catch(e){this.toast(e.message);}finally{this.sending=false;this.render();}}
 async submit(newTask=false,gitCheckpoint,permissionPolicy){const text=this.prompt.value.trim()||(newTask?this.detail?.messages.find(m=>m.type==='request')?.text||'Continuar a partir do progresso anterior.':''),running=!newTask&&active.has(this.detail?.status),canResume=!newTask&&resumable.has(this.detail?.status)&&!this.detail?.released&&!this.detail?.retired;if(!text&&!canResume)return;const guards=this.guards(),key=JSON.stringify([this.selected,this.inlineConversation,newTask,text,this.controls.project.value,gitCheckpoint,permissionPolicy,...Object.values(this.controls).map(c=>c.multiple?[...c.selectedOptions].map(o=>o.value):c.value)]);if(this.pending?.key!==key)this.pending={key,requestId:crypto.randomUUID()};
  if(this.selected&&canResume){this.detail=await this.api('/api/claudex/'+this.selected+'/resume',{guards,...(text?{text}:{}),requestId:this.pending.requestId});this.settings.open=false;}
  else if(this.selected&&running){this.detail=await this.api('/api/claudex/'+this.selected+'/update',{text,requestId:this.pending.requestId});}
  else{const workspace=this.controls.workspace?.value||'direct';if(workspace==='copy'&&this.controls.requestMode?.value!=='read-only'&&!this.getState()?.claudex?.workspaceModes?.includes('copy'))throw Error(uiText('Atualiza o servidor para iniciar uma tarefa na cópia privada.'));const roles=this.roles();if(![2,3].includes(roles.length)||new Set(roles).size!==roles.length)throw Error(uiText('Escolhe dois ou três clientes distintos.'));const members=Object.fromEntries(roles.map(role=>[role,{model:this.controls[role+'Model'].value,effort:this.controls[role+'Effort'].value}]));
   // A task from a conversation, or the next one from its progress, runs in that same conversation.
   const conversationId=this.selected?(this.detail?.inPlace?this.detail.origin?.conversationId:null):this.inlineConversation;
   let cwd=this.controls.cwd.value;if(!this.selected&&!conversationId&&!this.controls.project.value&&!cwd){this.pending.cwd??=(await this.api('/api/folders/loose',{})).path;cwd=this.pending.cwd;}
   const writers=this.selected?[this.controls.author.value]:this.writers();if(!writers.length)throw Error(uiText('Escolhe pelo menos um implementador.'));const externalMcp=!this.selected&&this.controls.externalEnabled?.value==='true'?{enabled:true,servers:[...this.controls.externalServers.selectedOptions].map(o=>o.value),scope:this.controls.externalScope.value,serverSignatures:Object.fromEntries([...this.controls.externalServers.selectedOptions].map(o=>[o.value,o.dataset.signature])),confirmRisk:this.controls.externalRisk.value==='true'}:undefined;
   const result=await this.api('/api/claudex',{permissionPolicy,writers,implementationPreferences:this.controls.implementationPreferences?.value||'',...(externalMcp?{externalMcp}:{}),text,requestId:this.pending.requestId,workflow:2,requestMode:this.controls.requestMode?.value||'auto',workspace,cwd,projectId:this.controls.project.value||null,projectRevision:this.getState().projectCatalog?.revision,roles,members,author:this.controls.author.value,consensus:this.controls.consensus.value==='true',guards,...(this.selected?{resumeFrom:this.selected}:{}),...(conversationId?{conversationId}:{}),gitCheckpoint});this.prompt.value='';this.saveDraft();this.wanted=null;this.selected=result.task.id;this.detail=result.task;localStorage.setItem('hydraq.claudex',this.selected);this.settings.open=false;}
  this.prompt.value='';this.saveDraft();this.pending=null;this.renderDetail();this.render();await this.refresh();
 }
}
