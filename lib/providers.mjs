import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hydraq } from './hydraq.mjs';
import { Antigravity } from './antigravity.mjs';
import { ClaudeCode } from './claude.mjs';
import { Cursor } from './cursor.mjs';
import { PROVIDER_NAMES, terminal, groupOf, turnFacts, uncoveredOwnTurns, unseenTurns, turnKey, summaryPrompt, finalAnswer, saferSandbox, gitStatus, buildHandoff, withHandoff } from './handoff.mjs';
import { inspectProject, compareProjects } from './project-state.mjs';
import { uncertaintyKey, needsUncertaintyReview } from './uncertainty.mjs';
import { AttachmentStore, MAX_MESSAGE_IMAGES, imageRecords } from './attachments.mjs';

const busy = new Set(['starting', 'running', 'waiting']);

/**
 * Independent original clients. Each keeps its own history and native session; a conversation group links
 * them, and a handoff sends each session only what it has not confirmed receiving.
 */
export class Providers extends EventEmitter {
  constructor({dataDir,defaultCwd,clients,git=gitStatus,inspect=inspectProject}) {
    super();
    this.git=git;
    this.inspect=inspect;
    this.loadErrors=new Map();
    this.clients=clients||{
      codex:new Hydraq({dataDir,defaultCwd}),
      antigravity:new Antigravity({dataDir:path.join(dataDir,'antigravity'),defaultCwd}),
      claude:new ClaudeCode({dataDir:path.join(dataDir,'claude'),defaultCwd}),
      cursor:new Cursor({dataDir:path.join(dataDir,'cursor'),defaultCwd}),
    };
    this.attachments = new AttachmentStore(path.join(dataDir || Object.values(this.clients).find(client=>client.dataDir)?.dataDir || defaultCwd || process.cwd(), 'attachments'));
    for(const client of Object.values(this.clients))client.on('state',()=>{this.#captureFacts(client);this.emit('state',this.snapshot());});
  }
  async load(){
    const entries=Object.entries(this.clients);
    const results=await Promise.allSettled(entries.map(([,client])=>client.load()));
    for(const [index,[id,client]] of entries.entries()){
      if(results[index].status==='rejected'){
        const message=`Não foi possível carregar o histórico do ${PROVIDER_NAMES[id]||id}. Os ficheiros foram preservados; os outros clientes continuam disponíveis. ${results[index].reason.message}`;
        this.loadErrors.set(id,message);client.conversations=[];client.connection='disconnected';client.connectionError=message;continue;
      }
      this.#captureFacts(client,false);
      let recovered=false;
      for(const c of client.conversations)if(['summarizing','sending'].includes(c.handoffState?.status)){
        c.handoffState.status='failed';c.handoffState.error='O HYDRAQ reiniciou sem confirmar a passagem. Nada foi reenviado automaticamente.';recovered=true;
      }
      if(recovered)await client.persist();
    }
  }
  snapshot(){
    const snapshots=Object.entries(this.clients).map(([id,client])=>[id,client.snapshot()]);
    const providers=Object.fromEntries(snapshots.map(([id,snapshot])=> {
      const {conversations,approvals,...info}=snapshot;
      return [id,{...info,name:PROVIDER_NAMES[id]||id,capabilities:info.capabilities||{steer:true,nativeApprovals:true}}];
    }));
    return {...providers.codex,providers,handoff:this.handoff?{conversationId:this.handoff.targetId,status:this.handoff.status}:null,conversations:snapshots.flatMap(([provider,snapshot])=>snapshot.conversations.map(c=>({...c,provider,group:groupOf(c),capabilities:providers[provider].capabilities}))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),approvals:snapshots.flatMap(([provider,snapshot])=>snapshot.approvals.map(a=>({...a,id:`${provider}:${a.id}`})))};
  }
  #client(provider){const client=this.clients[provider];if(!client)throw new Error(`Cliente desconhecido. Escolhe ${Object.keys(this.clients).map(id=>PROVIDER_NAMES[id]||id).join(', ')}.`);if(this.loadErrors.has(provider))throw new Error(this.loadErrors.get(provider));return client;}
  #owner(id){const client=Object.values(this.clients).find(c=>c.conversations.some(chat=>chat.id===id));if(!client)throw new Error('Conversa não encontrada.');return client;}
  #providerOf(client){return Object.keys(this.clients).find(id=>this.clients[id]===client);}
  #members(conversation){const group=groupOf(conversation);return Object.entries(this.clients).flatMap(([provider,client])=>client.conversations.filter(c=>groupOf(c)===group).map(c=>{c.provider||=provider;return c;}));}
  #anyActive(){return Object.values(this.clients).some(client=>client.conversations.some(c=>busy.has(c.status)));}
  #captureFacts(client,notify=true){
    let added=false;
    for(const conversation of client.conversations)for(const turn of conversation.turns||[])if(!turn.facts&&(terminal.has(turn.status)||turn.status==='uncertain')){turn.facts=turnFacts(conversation,turn);added=true;}
    if(added&&notify)client.changed();
  }
  async connect(provider='codex'){await this.#client(provider).connect();return this.snapshot();}
  async connectAll(){return Promise.allSettled(Object.keys(this.clients).map(id=>this.connect(id)));}
  async create(body){const provider=body.provider||'codex';const chat=await this.#client(provider).create(body);return {...chat,provider,group:groupOf(chat),capabilities:this.snapshot().providers[provider].capabilities};}
  async uploadAttachment(id, bytes, name, mimeType) {
    const conversation=this.#owner(id).conversation(id);
    return this.attachments.put(groupOf(conversation),bytes,name,mimeType);
  }

  async send(id,text,requestId,settings={}){
    if(this.preparing)throw new Error('Já há um pedido a ser enviado.');
    this.preparing=true;
    try{return await this.#send(id,text,requestId,settings);}finally{this.preparing=false;}
  }
  async #send(id,text,requestId,settings={}){
    if(this.closing)throw new Error('O HYDRAQ está a encerrar. Nada foi enviado.');
    if(this.sending||this.handoff)throw new Error(this.handoff?'Há uma passagem entre clientes em curso. Aguarda que termine.':'Já há um pedido a ser enviado.');
    if(typeof text!=='string'||text.length>100_000)throw new Error('Escreve um pedido com até 100 000 caracteres.');
    if(!text.trim() && settings.attachments?.length) text='Analisa as imagens anexadas.';
    if(!text.trim())throw new Error('Escreve um pedido ou anexa uma imagem.');
    if(typeof requestId!=='string'||!requestId||requestId.length>100)throw new Error('Identificador do pedido inválido.');
    // Clients reset error and diff when a turn starts; record facts of finished turns first.
    for(const entry of Object.values(this.clients))this.#captureFacts(entry,false);
    const client=this.#owner(id);
    const conversation=client.conversation(id);
    const source=this.#providerOf(client);
    const target=settings.provider||source;
    this.#client(target);
    if(target!==source)return this.#switch(client,conversation,target,text,requestId,settings);
    // Preserve backend idempotence for an already submitted request.
    const duplicate=conversation.messages.some(m=>m.requestId===requestId);
    if(duplicate && JSON.stringify(conversation.messages.find(m=>m.requestId===requestId).attachments?.map(image=>image.id)||[])!==JSON.stringify(settings.attachments||[]))throw new Error('Identificador já usado para outras imagens.');
    if(!duplicate && settings.attachments!==undefined) await this.attachments.resolve(groupOf(conversation),settings.attachments,MAX_MESSAGE_IMAGES);
    if(!duplicate && this.#members(conversation).some(needsUncertaintyReview))throw new Error('Uma conversa ligada tem estado incerto. Revê o projeto e confirma na interface antes de continuar noutro cliente.');
    if(!duplicate && this.#anyActive())throw new Error('Já há uma tarefa em curso. Aguarda ou interrompe-a primeiro.');
    this.sending=true;
    try{
      if(duplicate)return await client.send(id,text,requestId,{model:settings.model,effort:settings.effort,sandbox:settings.sandbox,context:settings.context,fast:settings.fast});
      const result=await this.#deliver(client,conversation,text,requestId,settings);
      if(conversation.handoffState){conversation.handoffState=null;client.changed();}
      return result;
    }
    finally{this.sending=false;}
  }

  /** Adds the context this native session is missing; the record counts only once the turn is confirmed. */
  async #deliver(client,conversation,text,requestId,settings){
    if(this.closing)throw new Error('O HYDRAQ está a encerrar. Nada foi enviado.');
    if(typeof text!=='string'||!text.trim()||text.length>100_000)throw new Error('Escreve um pedido com até 100 000 caracteres.');
    const members=this.#members(conversation);
    const ownImages=await this.attachments.resolve(groupOf(conversation),settings.attachments || [],MAX_MESSAGE_IMAGES);
    const unseen=unseenTurns(conversation,members);
    const inherited=unseen.flatMap(({member,turn})=>member.messages.find(message=>message.role==='user'&&message.requestId===turn.requestId)?.attachments || []);
    const images=await this.attachments.resolve(groupOf(conversation),[...new Set([...ownImages,...inherited].map(image=>image.id))]);
    const imageDirectory=client===this.clients.antigravity && (images.length || members.some(member=>member.messages.some(message=>message.attachments?.length)))
      ? await this.attachments.folder(groupOf(conversation),true) : undefined;
    const deliverySettings={model:settings.model,effort:settings.effort,sandbox:settings.sandbox,context:settings.context,fast:settings.fast,images,ownImages,imageDirectory};
    let context;
    try{context=members.length>1?buildHandoff({target:conversation,members,git:await this.git(conversation.cwd),budget:Math.min(40_000,99_000-text.trim().length)}):null;}
    catch(error){
      if(error.code==='HANDOFF_CONTEXT_TOO_LARGE'){
        conversation.handoffRecovery={id:randomUUID(),status:'required',keys:unseenTurns(conversation,members).map(entry=>entry.key),at:new Date().toISOString(),error:error.message};
        client.changed();await client.persist();
      }
      throw error;
    }
    if(this.handoff?.cancelled)throw new Error('Passagem interrompida pelo utilizador. Nada foi enviado ao destino.');
    if(!context)return client.send(conversation.id,text,requestId,deliverySettings);
    if(text.trim().length+context.text.length>99_000)throw new Error('O pedido e o contexto da passagem excedem o limite de 100 000 caracteres. Encurta o pedido.');
    (conversation.handoffDeliveries||=[]).push({requestId,keys:context.keys,at:new Date().toISOString()});
    return client.send(conversation.id,withHandoff(context.text,text.trim()),requestId,{...deliverySettings,displayText:text,handoffContext:context.text});
  }

  async #switch(sourceClient,source,targetProvider,text,requestId,settings){
    const members=this.#members(source);
    const existing=members.find(m=>m.provider===targetProvider);
    const previous=existing?.messages.find(m=>m.requestId===requestId);
    if(previous){if(previous.text!==String(text).trim() || JSON.stringify(previous.attachments?.map(image=>image.id)||[])!==JSON.stringify(settings.attachments||[]))throw new Error('Identificador já usado para outro texto ou imagens.');return {accepted:true,duplicate:true,conversationId:existing.id};}
    if(typeof text!=='string'||!text.trim()||text.length>100_000)throw new Error('Escreve um pedido com até 100 000 caracteres.');
    if(typeof requestId!=='string'||!requestId||requestId.length>100)throw new Error('Identificador do pedido inválido.');
    if(this.#anyActive())throw new Error('Já há uma tarefa em curso. Aguarda ou interrompe-a primeiro.');
    if(members.some(needsUncertaintyReview))throw new Error('Uma conversa ligada tem estado incerto. Revê o projeto e confirma na interface antes de continuar noutro cliente.');
    const mode=settings.handoffMode==='quick'?'quick':'model';
    const targetClient=this.#client(targetProvider);
    settings={...settings,sandbox:settings.sandbox??saferSandbox(source.sandbox,existing?.sandbox,targetProvider)};
    const sourceName=PROVIDER_NAMES[source.provider]||source.provider, targetName=PROVIDER_NAMES[targetProvider]||targetProvider;
    if(targetClient.connection!=='connected')throw new Error(`Liga primeiro o ${targetName}.`);
    await this.attachments.resolve(groupOf(source),settings.attachments || [],MAX_MESSAGE_IMAGES);
    const incomingIds=[...new Set([...(settings.attachments||[]),...unseenTurns(existing||{id:'new',turns:[]},members).flatMap(({member,turn})=>member.messages.find(m=>m.role==='user'&&m.requestId===turn.requestId)?.attachments?.map(image=>image.id)||[])])];
    await this.attachments.resolve(groupOf(source),incomingIds);
    if(incomingIds.length && targetClient.snapshot().capabilities?.images===false)throw new Error('O cliente de destino não anunciou suporte a imagens. Nada foi enviado.');
    const model=targetClient.models.find(m=>m.id===(settings.model??existing?.model));
    if(!model || (settings.effort && !model.efforts.includes(settings.effort)))throw new Error(`Escolhe modelo e raciocínio do catálogo do ${targetName}.`);
    const modes=targetClient.snapshot().capabilities?.accessModes || (targetProvider==='codex'?['read-only','workspace-write']:['plan','workspace-write','accept-edits']);
    if(!modes.includes(settings.sandbox))throw new Error('Modo de acesso inválido para o cliente de destino.');
    targetClient.validateSettings?.(existing,settings);
    const needsSummary=mode==='model'&&uncoveredOwnTurns(source).length>0;
    if(source.status==='uncertain'&&mode==='model')throw new Error('A origem tem resultado incerto. Escolhe a passagem rápida para continuar noutro cliente com o aviso e os resultados parciais.');
    if(existing?.status==='uncertain')throw new Error('A sessão de destino continua incerta. Escolhe outro cliente ou cria uma nova conversa.');
    if(sourceClient.connection!=='connected'&&needsSummary)throw new Error(`O ${sourceName} não está ligado para gerar o resumo. Liga-o ou escolhe a passagem rápida.`);
    this.sending=true;
    let target;
    try{
      source.group||=source.id;
      target=existing||await targetClient.create({cwd:source.cwd,model:settings.model,effort:settings.effort,sandbox:settings.sandbox,context:settings.context,fast:settings.fast});
      target.group=source.group;target.provider||=targetProvider;
      target.handoffState={status:needsSummary?'summarizing':'sending',requestId,text:text.trim(),attachments:imageRecords(await this.attachments.resolve(groupOf(source),settings.attachments || [],MAX_MESSAGE_IMAGES)),from:source.provider,sourceId:source.id,mode,settings:{model:settings.model??target.model,effort:settings.effort??target.effort,sandbox:settings.sandbox,context:settings.context??target.context,fast:settings.fast??target.fast},at:new Date().toISOString(),error:null};
      this.handoff={targetId:target.id,status:target.handoffState.status};
      for(const client of [sourceClient,targetClient]){client.changed();await client.persist();}
    }catch(error){
      if(target?.handoffState){target.handoffState.status='failed';target.handoffState.error=error.message;targetClient.changed();}
      this.handoff=null;throw error;
    }finally{this.sending=false;}
    this.handoffTask=this.#runHandoff(sourceClient,source,targetClient,target,text,requestId,settings,targetName).catch(()=>{});
    return {accepted:true,conversationId:target.id,handoff:target.handoffState.status};
  }

  async #runHandoff(sourceClient,source,targetClient,target,text,requestId,settings,targetName){
    const state=target.handoffState;
    try{
      if(state.status==='summarizing'){
        const keys=uncoveredOwnTurns(source).map(turn=>turnKey(source,turn));
        const before=await this.inspect(source.cwd);
        if(!before.complete)throw new Error(`Não foi possível verificar o projeto antes do resumo: ${before.warnings.join(' ')} Usa a passagem rápida se quiseres continuar sem o resumo.`);
        if(this.handoff.cancelled)throw new Error('Passagem interrompida pelo utilizador. Nada foi enviado ao destino.');
        const summaryId=`handoff-${randomUUID()}`;
        await sourceClient.send(source.id,summaryPrompt(targetName),summaryId,{internal:'handoff-summary',displayText:`Resumo de passagem para o ${targetName}`});
        const turn=await this.#finished(sourceClient,source,summaryId);
        if(turn.status!=='completed')throw new Error(`O resumo do ${PROVIDER_NAMES[source.provider]} não foi concluído (${turn.status}). Nada foi enviado ao ${targetName}.`);
        if(this.handoff.cancelled)throw new Error('Passagem interrompida pelo utilizador. Nada foi enviado ao destino.');
        const summary=finalAnswer(source,summaryId);
        if(!summary.trim())throw new Error('O resumo veio vazio. Nada foi enviado.');
        const after=await this.inspect(source.cwd);
        const {changed:changedDuringSummary,warnings}=compareProjects(before,after);
        if(!after.complete||changedDuringSummary.length){
          (source.handoffSummaryChecks||=[]).push({id:summaryId,changed:changedDuringSummary,warnings,at:new Date().toISOString()});
          sourceClient.changed();await sourceClient.persist();
          throw new Error(changedDuringSummary.length?`O projeto mudou durante o resumo (${changedDuringSummary.slice(0,10).join(', ')}). Nada foi enviado ao destino. Revê as alterações antes de continuar.`:'A inspeção do projeto ficou incompleta durante o resumo. Nada foi enviado ao destino.');
        }
        (source.handoffSummaries||=[]).push({id:summaryId,keys,text:summary,model:turn.model,effort:turn.effort,for:target.provider,changedDuringSummary,at:new Date().toISOString()});
        sourceClient.changed();await sourceClient.persist();
        state.status='sending';this.handoff.status='sending';targetClient.changed();
      }
      this.sending=true;
      try{await this.#deliver(targetClient,target,text,requestId,settings);}finally{this.sending=false;}
      target.handoffState=null;
    }catch(error){
      state.status='failed';state.error=error.message;
    }finally{
      this.handoff=null;targetClient.changed();await targetClient.persist().catch(()=>{});this.emit('state',this.snapshot());
    }
  }

  #finished(client,conversation,requestId){
    return new Promise(resolve=>{
      const check=()=>{const turn=conversation.turns.find(t=>t.requestId===requestId);if(this.closing||(turn&&(terminal.has(turn.status)||turn.status==='uncertain'))){client.off('state',check);this.off('closing',check);resolve(this.closing?{status:'interrupted'}:turn);}};
      client.on('state',check);this.on('closing',check);check();
    });
  }

  async reviewHandoff(id,{expectedRecoveryId,summary}={}){
    if(this.closing||this.#anyActive()||this.sending||this.handoff)throw new Error('Aguarda que a tarefa em curso termine.');
    const client=this.#owner(id),conversation=client.conversation(id),recovery=conversation.handoffRecovery;
    if(!recovery||recovery.status!=='required'||recovery.id!==expectedRecoveryId)throw new Error('A passagem mudou. Atualiza a página antes de rever o contexto.');
    const keys=unseenTurns(conversation,this.#members(conversation)).map(entry=>entry.key);
    if(JSON.stringify(keys)!==JSON.stringify(recovery.keys))throw new Error('Há novos pedidos no grupo. Tenta enviar novamente para atualizar o contexto a rever.');
    if(typeof summary!=='string'||!summary.trim()||summary.length>12_000)throw new Error('Escreve um resumo revisto com até 12 000 caracteres, incluindo as instruções e restrições importantes.');
    const review={id:randomUUID(),keys:[...keys],text:summary.trim(),at:new Date().toISOString()};
    const previous=conversation.handoffReviews;
    conversation.handoffReviews=[...(previous||[]),review];conversation.handoffRecovery={...recovery,status:'reviewed',reviewId:review.id};
    try{await client.persist();}catch(error){conversation.handoffReviews=previous;conversation.handoffRecovery=recovery;throw error;}
    client.changed();return {reviewed:true,conversationId:id};
  }

  async acknowledgeUncertainty(id,{expectedRequestId}={}){
    const client=this.#owner(id), conversation=client.conversation(id);
    if(conversation.status!=='uncertain'||expectedRequestId!==uncertaintyKey(conversation))throw new Error('O estado incerto mudou. Atualiza a página e revê o resultado atual.');
    if(this.#anyActive()||this.sending||this.handoff)throw new Error('Aguarda que a tarefa em curso termine antes de confirmar.');
    const previous=conversation.uncertaintyReview;
    conversation.uncertaintyReview={key:expectedRequestId,requestIds:conversation.turns.filter(t=>t.status==='uncertain').map(t=>t.requestId),at:new Date().toISOString()};
    try{await client.persist();}catch(error){conversation.uncertaintyReview=previous;throw error;}
    client.changed();return {acknowledged:true,conversationId:id};
  }

  interrupt(id){
    const owner=this.#owner(id), conversation=owner.conversation(id);
    if(this.handoff && this.#members(conversation).some(c=>c.id===this.handoff.targetId)){
      this.handoff.cancelled=true;
      const running=this.#members(conversation).find(c=>busy.has(c.status));
      return running?this.#owner(running.id).interrupt(running.id):Promise.resolve({requested:true});
    }
    return owner.interrupt(id);
  }
  steer(id,...args){return this.#owner(id).steer(id,...args);}
  respond(id,body){const colon=String(id).indexOf(':');if(colon<0)throw new Error('Pedido de autorização inválido.');return this.#client(id.slice(0,colon)).respond(id.slice(colon+1),body);}
  async close(){
    this.closing=true;if(this.handoff)this.handoff.cancelled=true;this.emit('closing');
    const results=await Promise.allSettled(Object.entries(this.clients).filter(([id])=>!this.loadErrors.has(id)).map(([,c])=>c.close()));
    await this.handoffTask;
    const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
    if(errors.length)throw new AggregateError(errors,'Não foi possível guardar todo o histórico ao encerrar.');
  }
}
