const el = (tag, cls, text) => { const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node; };
const inside = (root,folder) => folder===root || folder.startsWith(root==='/'?'/':root+'/');
const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity',cursor:'Cursor',opencode:'OpenCode'};
export function conversationGroups(state) {
  const map=new Map();
  for(const chat of state.conversations)map.set(chat.group,[...(map.get(chat.group)||[]),chat]);
  return [...map].map(([id,members])=>{
    members.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    const first=[...members].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const organization=members[0].organization||{};
    return {id,members,latest:members[0],organization,title:organization.title||first.find(c=>c.title!=='Nova conversa')?.title||members[0].title};
  });
}

export class ProjectUI {
  constructor({getState,api,refresh,choose,openProject,newChat,toast,memory}) {
    Object.assign(this,{getState,api,refresh,choose,openProject,newChat,toast,memory});this.open=new Set();this.archived=false;
    this.search=document.querySelector('#project-search');
    this.search.addEventListener('input',()=>{this.signature='';this.render(this.selection);});
    document.querySelector('#new-project').addEventListener('click',()=>this.editProject());
    document.querySelector('#organize-projects').addEventListener('click',()=>this.organize());
    document.querySelector('#show-archived').addEventListener('click',()=>{this.archived=!this.archived;this.signature='';this.render(this.selection);});
    this.dialog=el('dialog','project-dialog');document.body.append(this.dialog);
  }
  button(text,action,cls=''){const button=el('button',cls,text);button.type='button';button.addEventListener('click',action);return button;}
  field(form,text,input){input.setAttribute('aria-label',text);const label=el('label','',text);label.append(input);form.append(label);return input;}
  input(value='',maxLength=80){const input=el('input');input.value=value;input.maxLength=maxLength;return input;}
  select(options,value){const input=el('select');for(const [key,text]of options){const option=el('option','',text);option.value=key;input.append(option);}input.value=value;return input;}
  modal(title){
    this.dialog.dataset.revision=String(this.getState().projectCatalog?.revision||0);this.dialog.replaceChildren();const top=el('div','project-dialog-heading');top.append(el('h2','',title),this.button('Fechar',()=>this.dialog.close()));
    const form=el('form','project-form');this.dialog.append(top,form);if(!this.dialog.open)this.dialog.showModal();return form;
  }
  async mutate(route,body){
    try {const result=await this.api(route,{...body,revision:Number(this.dialog.dataset.revision)});await this.refresh();return result;}
    catch(error){await this.refresh().catch(()=>{});this.dialog.dataset.revision=String(this.getState().projectCatalog.revision);this.toast(error.message);return null;}
  }
  async submit(form,action){
    const buttons=[...form.querySelectorAll('button')];for(const b of buttons)b.disabled=true;
    try{await action();}catch(error){this.toast(error.message);}finally{for(const b of buttons)b.disabled=false;}
  }
  render(selection){
    this.selection=selection||{};const state=this.getState(),catalog=state.projectCatalog||{projects:[],groups:{},revision:0},groups=conversationGroups(state),query=this.search.value.trim().toLocaleLowerCase('pt');
    const signature=JSON.stringify([catalog,groups.map(g=>[g.id,g.title,g.latest.updatedAt,g.members.map(c=>c.status)]),this.selection,query,this.archived]);
    if(signature===this.signature)return;this.signature=signature;
    const list=document.querySelector('#conversation-list');list.replaceChildren();document.querySelector('#conversation-count').textContent=String(groups.length).padStart(2,'0');
    const matches=g=>g.title.toLocaleLowerCase('pt').includes(query);
    const visible=groups.filter(g=>this.archived?g.organization.archived||catalog.projects.find(p=>p.id===g.organization.projectId)?.archived:!g.organization.archived);
    const sorted=[...catalog.projects].sort((a,b)=>{
      const last=p=>groups.filter(g=>g.organization.projectId===p.id).reduce((max,g)=>g.latest.updatedAt>max?g.latest.updatedAt:max,p.updatedAt);
      return last(b).localeCompare(last(a));
    });
    for(const project of sorted){
      const own=visible.filter(g=>g.organization.projectId===project.id),nameMatch=project.name.toLocaleLowerCase('pt').includes(query);
      if((!this.archived&&project.archived)||(this.archived&&!project.archived&&!own.length)||(!nameMatch&&!own.some(matches)))continue;
      const details=el('details','project-section');details.open=this.open.has(project.id)||this.selection.projectId===project.id||Boolean(query);
      details.addEventListener('toggle',()=>{if(details.open)this.open.add(project.id);else this.open.delete(project.id);});
      const summary=el('summary');summary.append(el('span','',project.name),el('small','',String(groups.filter(g=>g.organization.projectId===project.id).length)));
      if(project.available===false)summary.append(el('span','project-unavailable','!'));
      details.append(summary);const actions=el('div','project-actions');
      actions.append(this.button('Abrir',()=>this.openProject(project.id)),this.button('＋ Conversa',()=>this.newChat(project.id)),this.button('⋯',()=>this.editProject(project)));
      actions.children[2].setAttribute('aria-label',`Definições de ${project.name}`);
      actions.children[1].disabled=project.archived||project.available===false||Boolean(catalog.error);details.append(actions);
      for(const group of own.filter(g=>nameMatch||matches(g)))details.append(this.groupRow(group));list.append(details);
    }
    const loose=visible.filter(g=>!g.organization.projectId&&matches(g));
    list.append(this.button('Sem projeto',()=>this.openProject(null),'loose-heading'));
    for(const group of loose)list.append(this.groupRow(group));
    if(!groups.length)list.append(el('p','no-conversations','Cria um projeto ou começa uma conversa solta.'));
    document.querySelector('#show-archived').textContent=this.archived?'Voltar aos ativos':'Arquivados';
    document.querySelector('#catalog-error').textContent=catalog.error||'';document.querySelector('#catalog-error').classList.toggle('hidden',!catalog.error);
    document.querySelector('#new-project').disabled=Boolean(catalog.error);document.querySelector('#organize-projects').disabled=Boolean(catalog.error)||!catalog.projects.some(p=>!p.archived);
    this.renderOverview();
  }
  groupRow(group){
    const row=el('div','conversation-row'),button=this.button('',()=>this.choose(group.latest.id),`conversation-link${this.selection.group===group.id?' active':''}`);
    button.title=group.title;button.append(el('strong','',group.title));
    const status=group.members.find(c=>['starting','running','waiting'].includes(c.status))?.status||group.latest.status;
    button.append(el('small','',`${[...new Set([...group.members].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(c=>names[c.provider]))].join(' → ')} · ${{completed:'Concluída',running:'A trabalhar',waiting:'Decisão pendente',idle:'Pronta',failed:'Falhou',uncertain:'Por confirmar'}[status]||status}`));
    const menu=this.button('⋯',()=>this.editGroup(group),'conversation-menu');menu.setAttribute('aria-label',`Organizar ${group.title}`);menu.disabled=Boolean(this.getState().projectCatalog?.error);row.append(button,menu);return row;
  }
  renderOverview(){
    const view=document.querySelector('#project-overview');if(!this.selection.overview){view.classList.add('hidden');return;}view.classList.remove('hidden');view.replaceChildren();
    const state=this.getState(),catalog=state.projectCatalog,project=catalog?.projects.find(p=>p.id===this.selection.projectId);
    const title=project?.name||'Sem projeto';view.append(el('p','eyebrow','PROJETOS'),el('h1','',title),el('p','project-path',project?.root||'Conversas independentes, cada uma com a sua pasta de trabalho.'));
    if(project?.available===false)view.append(el('p','notice',project.folderError));
    const actions=el('div','project-page-actions');const create=this.button('＋ Nova conversa',()=>this.newChat(project?.id||null),'primary-action');create.disabled=Boolean(catalog?.error||project?.archived||project?.available===false);actions.append(create);
    if(project)actions.append(this.button('Definições do projeto',()=>this.editProject(project)),this.button('Memória e conversas',()=>this.memory(project.id)));view.append(actions);
    view.append(el('p','',project?.archived?'Projeto arquivado. Restaura-o nas definições para continuar.':'Cada conversa mantém a sua sessão. A memória curada e os avisos recentes seguem com os pedidos; as outras conversas são consultadas apenas quando necessário.'));
    const own=conversationGroups(state).filter(g=>(g.organization.projectId||null)===(project?.id||null)&&(!g.organization.archived||this.archived||project?.archived));
    for(const group of own)view.append(this.groupRow(group));if(!own.length)view.append(el('p','no-conversations','Ainda não há conversas aqui.'));
  }
  editProject(project){
    const state=this.getState(),form=this.modal(project?'Definições do projeto':'Novo projeto');
    const name=this.field(form,'Nome',this.input(project?.name||''));name.required=true;
    const root=this.field(form,'Pasta local',this.input(project?.root||state.defaultCwd||'',4096));root.required=true;root.readOnly=Boolean(project);root.addEventListener('change',()=>{if(!name.value.trim())name.value=root.value.split('/').filter(Boolean).at(-1)||'Projeto';});
    const provider=this.field(form,'Cliente inicial',this.select([['','Usar preferência atual'],...Object.entries(names)],project?.defaults?.provider||''));
    const defaults=structuredClone(project?.defaults||{}),clients=defaults.clients||{};
    const advanced=el('details');advanced.append(el('summary','','Modelos e raciocínio por cliente'));const fields={};
    for(const [id,label]of Object.entries(names)){
      const section=el('fieldset');section.append(el('legend','',label));const models=state.providers[id]?.models||[],saved=clients[id]||{};
      const options=[['','Usar catálogo atual'],...models.map(m=>[m.id,m.name||m.id])];if(saved.model&&!models.some(m=>m.id===saved.model))options.push([saved.model,`${saved.model} · indisponível`]);
      const model=this.field(section,'Modelo',this.select(options,saved.model||''));const effort=this.field(section,'Raciocínio',this.select([['','Automático']],''));
      const context=id==='cursor'?this.field(section,'Contexto',this.select([['','Automático']],'')):null;
      const fast=id==='cursor'?this.field(section,'Fast',this.select([['','Automático'],['off','Desligado'],['on','Ligado']],saved.fast===undefined?'':saved.fast?'on':'off')):null;
      const populate=(initial=false)=>{const current=models.find(m=>m.id===model.value);effort.replaceChildren(...[['','Automático'],...(current?.efforts||[]).map(e=>[e,e])].map(([id,text])=>{const o=el('option','',text);o.value=id;return o;}));effort.value=initial?saved.effort||'':'';if(context){context.replaceChildren(...[['','Automático'],...(current?.contexts||[]).map(e=>[e,e])].map(([id,text])=>{const o=el('option','',text);o.value=id;return o;}));context.value=initial?saved.context||'':'';}};
      populate(true);model.addEventListener('change',()=>populate());fields[id]={model,effort,context,fast};advanced.append(section);
    }
    form.append(advanced,el('p','','Estas escolhas aplicam-se apenas a conversas novas. As permissões continuam a ser escolhidas na conversa.'));
    const save=this.button('Guardar',()=>{});save.type='submit';form.append(save);
    if(project)form.append(this.button(project.archived?'Restaurar projeto':'Arquivar projeto',()=>this.submit(form,async()=>{if(await this.mutate(`/api/projects/${project.id}`,{archived:!project.archived}))this.dialog.close();})));
    form.addEventListener('submit',event=>{event.preventDefault();this.submit(form,async()=>{
      const next={clients:{}};if(provider.value)next.provider=provider.value;
      for(const [id,f]of Object.entries(fields)){const value={};for(const key of ['model','effort','context'])if(f[key]?.value)value[key]=f[key].value;if(f.fast?.value)value.fast=f.fast.value==='on';if(Object.keys(value).length)next.clients[id]=value;}
      const result=await this.mutate(project?`/api/projects/${project.id}`:'/api/projects',{name:name.value,root:root.value,defaults:next});
      if(result){this.open.add(result.id);this.dialog.close();this.openProject(result.id);}
    });});
  }
  editGroup(group){
    const state=this.getState(),form=this.modal('Organizar conversa');
    const title=this.field(form,'Título',this.input(group.title));title.required=true;
    const projects=state.projectCatalog.projects.filter(p=>!p.archived&&group.members.every(c=>inside(p.root,c.cwd)));
    const currentId=group.organization.projectId||'';
    if(currentId&&!projects.some(p=>p.id===currentId)){const current=state.projectCatalog.projects.find(p=>p.id===currentId);if(current)projects.push(current);}
    const project=this.field(form,'Projeto',this.select([['','Sem projeto'],...projects.map(p=>[p.id,p.name])],currentId));
    form.append(el('p','',`Pasta das sessões: ${group.latest.cwd}. A organização conserva esta pasta e todas as sessões ligadas. Mudar de projeto revoga consultas futuras, mas não apaga contexto já lido pela sessão nativa.`));
    const save=this.button('Guardar',()=>{});save.type='submit';form.append(save);
    form.addEventListener('submit',event=>{event.preventDefault();this.submit(form,async()=>{const body={groups:[group.id],title:title.value};if(project.value!==currentId)body.projectId=project.value||null;if(await this.mutate('/api/groups/organize',body))this.dialog.close();});});
    form.append(this.button(group.organization.archived?'Restaurar conversa':'Arquivar conversa',()=>this.submit(form,async()=>{if(await this.mutate('/api/groups/organize',{groups:[group.id],archived:!group.organization.archived}))this.dialog.close();})));
  }
  organize(){
    const state=this.getState(),projects=state.projectCatalog.projects.filter(p=>!p.archived),form=this.modal('Organizar conversas existentes');
    const select=this.field(form,'Projeto de destino',this.select(projects.map(p=>[p.id,p.name]),this.selection.projectId||projects[0]?.id));
    const list=el('div','organize-candidates');let checks=[];
    const populate=()=>{list.replaceChildren();checks=[];const project=projects.find(p=>p.id===select.value);for(const group of conversationGroups(state).filter(g=>!g.organization.projectId&&g.members.every(c=>inside(project.root,c.cwd)))){const input=el('input');input.type='checkbox';input.value=group.id;const label=el('label','candidate');label.append(input,el('span','',`${group.title} — ${group.latest.cwd}`));list.append(label);checks.push(input);}if(!checks.length)list.append(el('p','','Não há conversas soltas compatíveis com esta pasta.'));};
    select.addEventListener('change',populate);if(projects.length)populate();form.append(list,el('p','','Só as conversas selecionadas serão associadas. Não são movidos ficheiros nem copiados contextos.'));
    const save=this.button('Associar selecionadas',()=>{});save.type='submit';form.append(save);form.addEventListener('submit',event=>{event.preventDefault();this.submit(form,async()=>{const groups=checks.filter(c=>c.checked).map(c=>c.value);if(!groups.length){this.toast('Seleciona pelo menos uma conversa.');return;}if(await this.mutate('/api/groups/organize',{groups,projectId:select.value}))this.dialog.close();});});
  }
}
