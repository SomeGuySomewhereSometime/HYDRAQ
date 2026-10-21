const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(text,action)=>{const b=node('button',text);b.type='button';b.addEventListener('click',action);return b;};
const detail=(title,text)=>{const d=node('details');d.append(node('summary',title),node('pre',text));return d;};

export class ProjectMemoryUI {
  constructor({api,getState,getCurrent,getProject,getKey,getProvider,toast,renderImages,changed}){
    Object.assign(this,{api,getState,getCurrent,getProject,getKey,getProvider,toast,renderImages,changed});this.pending=new Map();
    this.proposalPoll=null;
    this.dialog=node('dialog',undefined,'project-dialog memory-dialog');document.body.append(this.dialog);this.dialog.addEventListener('close',()=>clearTimeout(this.proposalPoll));
    this.controls=node('div',undefined,'project-context-controls');document.querySelector('#composer').before(this.controls);
  }
  async run(action){try{return await action();}catch(e){this.toast(e.message);}}
  modal(title){clearTimeout(this.proposalPoll);this.dialog.replaceChildren();const top=node('div',undefined,'project-dialog-heading');top.append(node('h2',title),button('Fechar',()=>this.dialog.close()));const body=node('div',undefined,'project-form');this.dialog.append(top,body);if(!this.dialog.open)this.dialog.showModal();return body;}
  stage(value){this.pending.set(this.getKey(),value);this.changed();this.dialog.close();this.toast('Contexto preparado. Segue apenas com o próximo pedido enviado por ti.');}
  move(from,to){if(from!==to&&this.pending.has(from)){this.pending.set(to,this.pending.get(from));this.pending.delete(from);}}
  consume(key,value){if(this.pending.get(key)===value)this.pending.delete(key);}
  render(){
    const project=this.getProject(),key=this.getKey(),pending=this.pending.get(key),current=this.getCurrent();this.controls.replaceChildren();this.controls.hidden=!project;
    if(!project)return;
    this.controls.append(button('Memória e conversas do projeto',()=>this.open(project.id)),button('Rever contexto automático',()=>this.review(project.id)));
    if(current){const refresh=button('Atualizar no próximo pedido',()=>this.run(async()=>{await this.api(`/api/conversations/${current.id}/context-refresh`,{});this.toast('O contexto atualizado seguirá no próximo pedido.');}));refresh.disabled=project.archived;this.controls.append(refresh);}
    if(pending){this.controls.append(button(`Importação preparada · ${pending.images.length} imagens`,()=>this.inspect(pending)),button('Remover importação',()=>{this.pending.delete(key);this.changed();}));}
  }
  async open(projectId){return this.run(async()=>{
    const view=await this.api(`/api/projects/${projectId}/memory`),body=this.modal('Memória e atividade do projeto');let memory=view.memory;
    body.append(node('p','A memória curada segue no primeiro pedido de cada sessão e quando muda. A atividade contém apenas avisos de outras conversas; o código no disco continua a ser a referência.'));
    const input=node('textarea');input.rows=9;input.maxLength=view.limit;input.value=memory.text;input.setAttribute('aria-label','Memória do projeto');
    const count=node('small');const update=()=>count.textContent=`${input.value.length}/${view.limit} caracteres · versão ${memory.revision}`;input.addEventListener('input',update);update();body.append(input,count);
    let sources=memory.sources;
    const save=button('Guardar memória',()=>this.run(async()=>{save.disabled=true;try{await this.api(`/api/projects/${projectId}/memory`,{revision:memory.revision,text:input.value,sources});this.toast('Memória guardada. Aplicada aos próximos pedidos.');await this.open(projectId);}catch(e){if(e.status===409){const latest=(await this.api(`/api/projects/${projectId}/memory`)).memory;const conflict=node('div',undefined,'memory-comparison');conflict.append(node('p','A versão atual é diferente. O teu texto foi conservado. Compara antes de voltares a guardar.'),detail(`Versão atual ${latest.revision}`,latest.text),button('Revi a versão atual · manter o meu texto',()=>{memory=latest;update();conflict.remove();}));body.prepend(conflict);}throw e;}finally{save.disabled=false;}}));
    const actions=node('div',undefined,'project-page-actions');actions.append(save,button('Exportar Markdown',()=>{
      const a=node('a');a.href=URL.createObjectURL(new Blob([input.value],{type:'text/markdown;charset=utf-8'}));a.download='HYDRAQ_MEMORY.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    }));
    const file=node('input');file.type='file';file.accept='.md,.txt,text/markdown,text/plain';file.hidden=true;
    file.addEventListener('change',()=>this.run(async()=>{const f=file.files?.[0];if(!f)return;if(f.size>20000)throw Error('O ficheiro excede o limite.');const text=await f.text();if(text.length>view.limit)throw Error(`O conteúdo excede ${view.limit} caracteres.`);input.value=text;sources=[];update();this.toast('Texto importado para revisão. Guarda para aplicar.');}));
    actions.append(button('Importar Markdown',()=>file.click()),file);body.append(actions);
    if(view.versionCount){
      const history=node('details');history.append(node('summary',`Versões anteriores (${view.versionCount})`));
      const appendVersions=versions=>{for(const version of versions){const d=detail(`Versão ${version.revision} · ${version.updatedAt||'inicial'}`,version.text);d.append(button('Usar no editor',()=>{input.value=version.text;sources=version.sources;update();}));history.append(d);}};
      appendVersions([...memory.versions].reverse());let cursor=view.nextVersionCursor;
      const more=button('Carregar versões anteriores',()=>this.run(async()=>{const result=await this.api(`/api/projects/${projectId}/memory-versions?cursor=${cursor}`);appendVersions(result.versions);cursor=result.nextCursor;more.hidden=cursor===null;}));more.hidden=cursor===null;history.append(more);body.append(history);
    }
    const sourceBox=node('details');sourceBox.append(node('summary','Fontes da memória'));
    sourceBox.append(node('pre',memory.sources.map(s=>`${s.groupId} / ${s.requestId}${s.unavailable?' · referência histórica indisponível neste projeto':''}`).join('\n')||'Sem fontes associadas.'));
    sourceBox.append(button('Retirar fontes da edição',()=>{sources=[];this.toast('A edição será guardada sem fontes. As versões anteriores conservam as referências.');}));body.append(sourceBox);
    const state=this.getState(),groups=new Map();
    for(const c of state.conversations.filter(c=>c.organization?.projectId===projectId&&!c.organization.archived)){
      const group=groups.get(c.group)||{members:[]};group.members.push(c);groups.set(c.group,group);
    }
    const projectChats=[...groups.values()].filter(g=>!g.members.some(c=>c.status==='uncertain')&&g.members.some(c=>c.turns?.some(t=>!t.internal&&t.status==='completed'))).map(g=>[...g.members].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]);
    const proposals=node('details');proposals.append(node('summary','Propostas de memória guardadas'));
    const cards=node('div');let proposalCursor=0;
    const use=(result)=>{input.value=result.text;sources=result.sources;update();this.toast('Proposta colocada no editor. Revê e guarda para a aplicar.');};
    const refreshProposals=async()=>{
      if(!this.dialog.open||!body.isConnected)return;
      const result=await this.api(`/api/projects/${projectId}/memory-proposals?cursor=${proposalCursor}`);cards.replaceChildren();
      for(const record of result.records){
        const card=node('div',undefined,'memory-comparison');card.append(node('strong',`${record.provider} · ${record.model} · ${{running:'Em curso',ready:'Pronta para revisão',failed:'Falhou',uncertain:'Por confirmar'}[record.status]} · memória base ${record.baseRevision}`));
        if(record.error)card.append(node('p',record.error));for(const warning of record.warnings)card.append(node('p',warning));
        if(record.status==='ready'){
          card.append(detail('Memória no editor',input.value),detail('Proposta guardada',record.text));
          const accept=button('Colocar proposta no editor',()=>use(record));
          if(record.warnings.length){accept.disabled=true;const label=node('label','Revi os avisos e o estado do projeto');const check=node('input');check.type='checkbox';check.addEventListener('change',()=>accept.disabled=!check.checked);label.prepend(check);card.append(label);}
          card.append(accept);
          if(record.baseRevision!==memory.revision)card.append(node('p','Esta proposta partiu de outra versão da memória. Compara com a versão atual antes de guardar.'));
        }else if(record.text)card.append(detail('Texto parcial, sem aplicar',record.text));
        cards.append(card);
      }
      if(!result.records.length)cards.append(node('p','Ainda não há propostas guardadas.'));
      if(proposalCursor>0)cards.append(button('Propostas mais recentes',()=>{proposalCursor=0;this.run(refreshProposals);}));
      if(result.nextCursor!==null)cards.append(button('Propostas anteriores',()=>{proposalCursor=result.nextCursor;this.run(refreshProposals);}));
      clearTimeout(this.proposalPoll);if(result.records.some(r=>r.status==='running'))this.proposalPoll=setTimeout(()=>this.run(refreshProposals),1500);
    };
    if(projectChats.length){
      const select=node('select');select.setAttribute('aria-label','Conversa que propõe a memória');for(const c of projectChats){const o=node('option',`${c.organization.title||c.title} · ${c.provider} · ${c.model}`);o.value=c.id;select.append(o);}
      proposals.append(select,node('p','Pedido adicional na sessão/modelo escolhidos. Usa a memória, os três últimos pedidos públicos concluídos do grupo e avisos recentes de outras conversas. Pede apenas texto com as permissões atuais. Inspeções incompletas ou alterações exigem revisão explícita; nada é desfeito. A proposta fica guardada, mesmo se recarregares.'));
      const generate=button('Gerar proposta',()=>this.run(async()=>{generate.disabled=true;try{await this.api(`/api/projects/${projectId}/memory-proposal`,{conversationId:select.value,revision:memory.revision});proposalCursor=0;await refreshProposals();this.toast('Proposta iniciada. Podes fechar ou recarregar; consulta o resultado neste painel.');}finally{generate.disabled=false;}}));proposals.append(generate);
    }else proposals.append(node('p','É necessário um grupo com pedidos públicos concluídos e sem resultado incerto pendente para gerar uma proposta.'));
    proposals.append(cards,button('Atualizar propostas',()=>this.run(refreshProposals)));body.append(proposals);if(view.proposalError)cards.append(node('p',view.proposalError));else await refreshProposals();
    body.append(node('h3','Atividade recente · factos observados e conclusões declaradas'));
    for(const e of view.activity)body.append(node('p',`${e.title} · ${e.provider} · ${e.status} · ${e.at}\nFicheiros observados: ${e.files.join(', ')||'nenhum'}\nConclusão declarada: ${e.conclusion||'(sem resposta final)'}`));
    if(!view.activity.length)body.append(node('p','Ainda não há pedidos terminados neste projeto.'));
    body.append(button('Pesquisar e importar outra conversa',()=>this.browse(projectId)));
    const caps=this.getState().contextCapabilities||{};body.append(node('small',`Consulta pelo modelo: ${caps[this.getProvider()]?'MCP de leitura disponível para esta sessão.':'MCP não ativado neste cliente; usa a importação explícita abaixo.'} Os conteúdos consultados são enviados ao fornecedor do modelo. A filtragem de segredos conhecidos é limitada; revê os excertos.`));
  });}
  async review(projectId){return this.run(async()=>{
    const current=this.getCurrent();if(!current){await this.open(projectId);return;}
    const result=await this.api(`/api/projects/${projectId}/context-preview`,{conversationId:current.id,provider:this.getProvider()});
    const body=this.modal('Contexto automático do próximo pedido');body.append(node('p','Pré-visualização neste momento. Novas conclusões ou alterações à memória podem atualizá-la antes do envio. A passagem entre clientes e a importação selecionada têm os seus próprios registos.'),node('pre',result.text||'Esta sessão já recebeu a memória e os avisos atuais; não há contexto novo a acrescentar.'));
  });}
  async browse(projectId,query='',cursor=0,includeArchived=false){return this.run(async()=>{
    const ownGroup=this.getCurrent()?.group||null;
    const result=await this.api(`/api/projects/${projectId}/context-query`,{ownGroup,tool:query?'search_project_conversations':'list_project_conversations',args:{...(query?{query}:{}),cursor,includeArchived}});
    const body=this.modal('Consultar outras conversas do projeto'),form=node('form'),search=node('input');search.value=query;search.placeholder='Pesquisar palavras';search.maxLength=160;search.setAttribute('aria-label','Pesquisar conversas');const submit=node('button','Pesquisar');submit.type='submit';form.append(search,submit);form.addEventListener('submit',e=>{e.preventDefault();this.browse(projectId,search.value.trim(),0,includeArchived);});body.append(form);
    const archived=node('input');archived.type='checkbox';archived.checked=includeArchived;const label=node('label','Incluir conversas arquivadas');label.prepend(archived);archived.addEventListener('change',()=>this.browse(projectId,query,0,archived.checked));body.append(label);
    const entries=result.matches||result.entries;for(const e of entries){const item=node('div',undefined,'context-result');item.append(node('strong',`${e.title} · ${e.status}`),node('small',`${e.groupId} / ${e.requestId}`));if(e.excerpt)item.append(node('pre',e.excerpt));else item.append(node('p',e.conclusion||'Sem conclusão declarada.'));item.append(button('Ler este pedido',()=>this.read(projectId,e.groupId,e.requestId,e.offset||0,includeArchived)),button('Pré-visualizar importação',()=>this.importPreview(projectId,e.groupId,[e.requestId])));body.append(item);}
    if(!entries.length)body.append(node('p','Sem resultados. A conversa atual é excluída.'));
    if(result.nextCursor!==null)body.append(button('Página seguinte',()=>this.browse(projectId,query,result.nextCursor,includeArchived)));
  });}
  async read(projectId,groupId,requestId,offset=0,includeArchived=false){return this.run(async()=>{
    const result=await this.api(`/api/projects/${projectId}/context-query`,{ownGroup:this.getCurrent()?.group||null,tool:'read_conversation_excerpt',args:{groupId,requestId,offset,includeArchived}}),body=this.modal('Excerto citado da conversa');
    body.append(node('p',`${result.status} · origem ${groupId}/${requestId} · posição ${offset}`),node('pre',result.text),node('small',result.note));
    if(result.nextOffset!==null)body.append(button('Excerto seguinte',()=>this.read(projectId,groupId,requestId,result.nextOffset,includeArchived)));
    body.append(button('Pré-visualizar importação deste pedido',()=>this.importPreview(projectId,groupId,[requestId])),node('p',`${result.images.length} imagens originais disponíveis. Para as enviar ao modelo, escolhe incluir imagens na importação e envia um pedido normal.`));
  });}
  async importPreview(projectId,sourceGroupId,requestIds,includeImages=false){return this.run(async()=>{
    const result=await this.api(`/api/projects/${projectId}/import-preview`,{sourceGroupId,requestIds,includeImages,targetGroupId:this.getCurrent()?.group||null});
    this.inspect({...result,projectId,sourceGroupId,requestIds,includeImages});
  });}
  inspect(value){const body=this.modal('Rever importação antes do envio');body.append(node('p','Este é o texto que será acrescentado ao próximo pedido. Não liga as sessões nem envia nada agora. A pré-visualização expira em 15 minutos.'),node('pre',value.text));
    if(value.sourceGroupId){const input=node('input');input.type='checkbox';input.checked=value.includeImages;const label=node('label','Incluir as imagens originais deste pedido');label.prepend(input);input.addEventListener('change',()=>this.importPreview(value.projectId,value.sourceGroupId,value.requestIds,input.checked));body.append(label);}
    this.renderImages?.(body,value.images.map(image=>({...image,group:value.sourceGroupId})));
    body.append(node('p',`${value.images.length} imagens incluídas${value.images.length?': '+value.images.map(i=>i.name).join(', '):''}.`));
    const stage=button('Usar com o próximo pedido',()=>this.stage(value));stage.disabled=this.getProject()?.id!==value.projectId||this.getCurrent()?.group===value.sourceGroupId;body.append(stage);
  }
}
