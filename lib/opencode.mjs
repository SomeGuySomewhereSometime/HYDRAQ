import {turnPermissions} from './permissions.mjs';
import {randomUUID} from 'node:crypto';
import {OpenCodeAcp} from './opencode-acp.mjs';
import {reconcileOpenCode} from './opencode-history.mjs';
import {imageRecords,messageImages} from './attachments.mjs';
import {validateElicitation} from '../public/elicitation.js';
import {openCodePermissions} from './opencode-permissions.mjs';
import {CONTEXT_TOOLS} from './context-mcp.mjs';

const active=new Set(['starting','running','waiting']);
const now=()=>new Date().toISOString();
const inputId=()=> 'msg_'+(BigInt(Date.now())*4096n).toString(16).slice(-12).padStart(12,'0')+randomUUID().replaceAll('-','').slice(0,14);
const route=(c,suffix='')=>'/api/session/'+encodeURIComponent(c.threadId)+suffix;
const idleSweepMs=60_000,eventBatchMs=250;

// Read complete SSE frames: network chunks need not end at an event or UTF-8 boundary.
async function* nativeEvents(body){
  const decoder=new TextDecoder();let buffer='';
  for await(const chunk of body){
    buffer+=decoder.decode(chunk,{stream:true});
    let boundary;
    while((boundary=/\r?\n\r?\n/.exec(buffer))){
      const frame=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
      const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
      if(data)yield JSON.parse(data);
    }
    if(buffer.length>1024*1024)throw Error('Evento OpenCode incompleto; recuperar pelo histórico.');
  }
}

/** Native HTTP is the executor. ACP is an explicit compatibility implementation, never a retry path. */
export class OpenCode extends OpenCodeAcp {
  constructor(options={}){super(options);this.syncing=new Map();this.sendTasks=new Set();this.settleTimers=new Map();this.syncRetry=new Map();this.eventSessions=new Set();this.eventAll=false;this.lastIdleSweep=Date.now();this.isArchived=options.isArchived||(()=>false);this.observing=false;}
  snapshot(){return {...super.snapshot(),transport:'http',permissionProfile:'routine',nativeEvents:this.eventState||'disconnected',nativeVersion:this.nativeVersion||null};}
  async connect(){
    if(this.closing)throw Error('OpenCode está a encerrar.');
    if(this.submitting||this.conversations.some(c=>active.has(c.status)))throw Error('Aguarda o fim do pedido OpenCode.');
    if(this.connection==='connecting')throw Error('A ligação OpenCode já está em curso.');
    this.connection='connecting';this.connectionError=null;this.changed();
    try{
      await this.refreshModels(this.defaultCwd,{force:true});
      const info=await this.runtime.api('/api/info');this.nativeVersion=info.version||info.data?.version||null;
      this.connection='connected';this.supportsImages=true;
      for(const c of this.conversations.filter(c=>c.threadId))await this.sync(c).catch(()=>{});
      this.observe();
    }catch(error){this.connection='disconnected';this.connectionError=error.message;throw error;}
    finally{this.changed();}
    return this.snapshot();
  }
  async create(body){const c=await super.create(body);c.nativeTransport='http';await this.persist();return c;}
  async prepare(c,settings,context){
    const model={providerID:'opencode',id:settings.model.slice('opencode/'.length),...(settings.effort!=='default'?{variant:settings.effort}:{})};
    if(context){
      const query=new URLSearchParams({'location[directory]':c.cwd});
      await this.runtime.api('/api/experimental/mcp/'+encodeURIComponent(context.name)+'?'+query,{method:'PUT',body:{config:{type:'local',command:[context.command,...context.args],environment:context.env}}});
    }
    if(!c.threadId){
      const result=await this.runtime.api('/api/session',{method:'POST',body:{location:{directory:c.cwd},title:c.title,agent:settings.sandbox==='plan'?'plan':'build',model,permissions:openCodePermissions(context,settings)}});
      if(typeof result?.data?.id!=='string'||!result.data.id)throw Error('OpenCode não confirmou o ID da sessão nativa.');
      c.threadId=result.data.id;c.nativeTransport='http';await this.persist();
    }else{
      const info=await this.runtime.api(route(c));
      if(info?.data?.id!==c.threadId||info.data.location?.directory!==c.cwd)throw Error('A sessão nativa OpenCode não corresponde à pasta desta conversa.');
      await this.runtime.api(route(c),{method:'PATCH',body:{permissions:openCodePermissions(context,settings)}});
      await this.runtime.api(route(c,'/agent'),{method:'POST',body:{agent:settings.sandbox==='plan'?'plan':'build'}});
      await this.runtime.api(route(c,'/model'),{method:'POST',body:{model}});
    }
    c.nativePermissionProfile='routine';c.nativePermissionSandbox=settings.sandbox;
    this.runtime.executionActive=true;
  }
  send(...args){const task=this.nativeSend(...args);this.sendTasks.add(task);task.finally(()=>this.sendTasks.delete(task)).catch(()=>{});return task;}
  async nativeSend(id,text,requestId,settings={}){
    if(this.closing||this.connection!=='connected')throw Error('Liga primeiro o OpenCode.');
    if(typeof text!=='string'||!text.trim()||typeof requestId!=='string'||!requestId||requestId.length>100)throw Error('Pedido OpenCode inválido.');
    const c=this.conversation(id),shown=(settings.displayText??text).trim(),old=c.messages.find(m=>m.requestId===requestId);
    if(old){if(old.text!==shown)throw Error('Identificador já usado para outro texto.');return {accepted:true,duplicate:true};}
    if(this.submitting||this.steerTasks.size||this.conversations.some(c=>active.has(c.status)||c.terminal))throw Error('Aguarda o fim do pedido ou do terminal OpenCode.');
    this.submitting=true;
    let turn;
    try{
      await this.refreshModels(c.cwd,{force:true});
      if(c.threadId)await this.sync(c,{preparing:true});
      if(c.status==='uncertain')throw Error('O resultado anterior é incerto. Recupera o histórico nativo antes de continuar; nada foi reenviado.');
      if(active.has(c.status))throw Error('A sessão nativa OpenCode ainda está em execução.');
      await this.settleSteers(c);
      const selected=this.validateSettings(c,settings);
      turn={id:randomUUID(),nativeInputId:inputId(),requestId,...selected,startedAt:now(),status:'starting',delivery:'preparing',completedAt:null,usage:null,interactions:[],...(settings.internal?{internal:settings.internal}:{})};
      if(settings.projectDelivery)turn.projectDelivery=settings.projectDelivery;
      if(settings.images?.length)turn.inputAttachments=imageRecords(settings.images);
      Object.assign(c,selected,{status:'starting',turnId:turn.id,error:null,updatedAt:now(),diff:''});Object.assign(turn,turnPermissions(settings));c.turns.push(turn);
      const user={id:randomUUID(),nativeInputId:turn.nativeInputId,requestId,turnId:turn.id,role:'user',text:shown,at:now(),...selected,...(settings.internal?{internal:settings.internal}:{}),...(settings.handoffContext?{handoffContext:settings.handoffContext}:{})};
      if(messageImages(settings).length)user.attachments=imageRecords(messageImages(settings));
      if(settings.projectContext)user.projectContext=settings.projectContext;
      if(settings.contextImages?.length)user.contextImages=settings.contextImages;
      c.messages.push(user);if(c.title==='Nova conversa'&&!settings.internal)c.title=shown.replace(/\s+/g,' ').slice(0,66);
      this.session={conversation:c,turn,phase:'preparing',stopping:false};this.changed();await this.persist();
      await this.prepare(c,selected,settings.contextMcp);
      if(turn.cancelRequested){this.finishPreparation(c,turn,'interrupted');return {accepted:true,interrupted:true};}
      turn.delivery='sending';c.status=turn.status='running';await this.persist();
      if(turn.cancelRequested){this.finishPreparation(c,turn,'interrupted');return {accepted:true,interrupted:true};}
      this.session.phase='prompt';
      const files=(settings.images||[]).map(image=>({uri:'data:'+image.mimeType+';base64,'+Buffer.from(image.bytes).toString('base64')}));
      const result=await this.runtime.api(route(c,'/prompt'),{method:'POST',body:{id:turn.nativeInputId,text:text.trim(),...(files.length?{files}:{}),metadata:{hydraq:{requestId}},resume:true},beforeSend:()=>!turn.cancelRequested&&!this.closing});
      if(result?.data?.id!==turn.nativeInputId||result.data.sessionID!==c.threadId||result.data.type!=='user')throw Error('O recibo OpenCode não corresponde ao pedido. Nada foi reenviado.');
      turn.delivery='accepted';this.changed();await this.persist();return {accepted:true};
    }catch(error){
      if(turn){this.finishPreparation(c,turn,['sending','accepted'].includes(turn.delivery)?'uncertain':'failed',error.message);await this.persist();}
      throw error;
    }finally{this.submitting=false;this.recount();this.sweep().catch(()=>{});}
  }
  finishPreparation(c,turn,status,error=null){turn.status=c.status=status;turn.error=c.error=error;turn.completedAt=now();c.turnId=null;if(this.session?.conversation===c)this.session.phase='idle';this.changed();}
  recount(){this.runtime.executionActive=this.conversations.some(c=>active.has(c.status)||c.status==='uncertain'||c.terminal);}
  sync(c,{preparing=false}={}){
    if(this.syncing.has(c.id))return this.syncing.get(c.id);
    if(this.submitting&&!preparing)return Promise.resolve();
    const task=(async()=>{
      const comparable=value=>JSON.stringify({...value,nativeHistory:value.nativeHistory?{...value.nativeHistory,checkedAt:undefined,attemptedAt:undefined}:undefined});
      const before=comparable(c);
      try{
        const info=await this.runtime.api(route(c));
        if(info?.data?.id!==c.threadId||info.data.location?.directory!==c.cwd)throw Error('A sessão OpenCode não corresponde à pasta desta conversa.');
        // Session rules survive native agent switches. Refresh them for existing sessions and for
        // /plan or /build in the original TUI, without sending or resuming a model request.
        if(['plan','build'].includes(info.data.agent)){
          const sandbox=info.data.agent==='plan'?'plan':'workspace-write';
          if(c.nativePermissionProfile!=='routine'||c.nativePermissionSandbox!==sandbox){
            const context=c.contextMcpName?{name:c.contextMcpName,names:CONTEXT_TOOLS}:null;
            await this.runtime.api(route(c),{method:'PATCH',body:{permissions:openCodePermissions(context,{sandbox})}});
            c.nativePermissionProfile='routine';c.nativePermissionSandbox=sandbox;
          }
        }
        const history=await this.runtime.history(c.threadId);
        const [permissions,forms]=await Promise.all([this.runtime.api(route(c,'/permission')),this.runtime.api(route(c,'/form'))]);
        if(!Array.isArray(permissions?.data)||!Array.isArray(forms?.data))throw Error('OpenCode não confirmou as decisões pendentes.');
        if([...permissions.data,...forms.data].some(p=>p.sessionID!==c.threadId||typeof p.id!=='string'))throw Error('Decisão OpenCode para outra sessão.');
        reconcileOpenCode(c,history,{publicText:(text,final)=>this.runtime.publicText(text,final)});
        if(info.data.model?.providerID&&info.data.model?.id){c.model=info.data.model.providerID+'/'+info.data.model.id;c.effort=info.data.model.variant||'default';}
        if(['plan','build'].includes(info.data.agent))c.sandbox=info.data.agent==='plan'?'plan':'workspace-write';
        if(c.nativeHistory.settling&&!this.settleTimers.has(c.id))this.settleTimers.set(c.id,setTimeout(()=>{this.settleTimers.delete(c.id);if(!this.closing)this.sync(c).catch(()=>{});},250));
        if(this.session?.conversation===c){this.session.turn=c.turns.find(t=>t.id===c.turnId)||c.turns.at(-1);this.session.phase=active.has(c.status)?'prompt':'idle';}
        this.decisions(c,permissions.data,forms.data);this.recount();this.syncRetry.delete(c.id);if(comparable(c)!==before)this.changed();
      }catch(error){
        const previous=this.syncRetry.get(c.id),failures=previous?.error===error.message?previous.failures+1:1;
        this.syncRetry.set(c.id,{error:error.message,failures,nextAt:Date.now()+Math.min(300_000,5000*2**Math.min(failures-1,6))});
        if(c.nativeHistory?.status!=='unavailable'||c.nativeHistory.error!==error.message)c.nativeHistory={...c.nativeHistory,status:'unavailable',error:error.message,attemptedAt:now()};
        if(comparable(c)!==before)this.changed();throw error;
      }
    })().finally(()=>this.syncing.delete(c.id));this.syncing.set(c.id,task);return task;
  }
  decisions(c,permissions,forms){
    const pending=new Set(),turn=c.turns.find(t=>t.id===c.turnId)||c.turns.at(-1);
    for(const [kind,native]of [...permissions.map(x=>['permission',x]),...forms.filter(x=>!x.state||x.state.status==='pending').map(x=>['form',x])]){
      if(native.sessionID!==c.threadId||typeof native.id!=='string')throw Error('Decisão OpenCode para outra sessão.');
      const id=c.id+':'+kind+':'+native.id;pending.add(id);
      if(this.approvals.has(id)){const old=this.approvals.get(id);old.interaction=turn?.interactions.find(i=>i.id===id)||old.interaction;continue;}
      if(!turn)throw Error('Decisão OpenCode sem pedido identificado.');
      const interaction=turn.interactions.find(i=>i.id===id)||{id,method:kind,status:'pending',at:now()};if(!turn.interactions.includes(interaction))turn.interactions.push(interaction);
      interaction.status='pending';
      const params=kind==='permission'?{sessionId:c.threadId,turnId:turn.id,toolCall:{title:native.action,rawInput:{resources:native.resources}},options:[{optionId:'once',name:'Permitir uma vez',kind:'allow_once'},{optionId:'always',name:'Permitir sempre no OpenCode privado',kind:'allow_always'},{optionId:'reject',name:'Recusar',kind:'reject_once'}]}:{sessionId:c.threadId,turnId:turn.id,form:native};
      if(kind==='form'){
        const properties=Object.fromEntries((native.fields||[]).map(f=>[f.key,{...f,...(f.type==='multiselect'?{type:'array',items:{type:'string',...(f.options&&!f.custom?{enum:f.options.map(o=>o.value)}:{})}}:f.options&&!f.custom?{enum:f.options.map(o=>o.value)}:{})}]));
        params.message=native.title;params.requestedSchema={type:'object',properties,required:(native.fields||[]).filter(f=>f.required).map(f=>f.key),additionalProperties:false};
      }
      this.approvals.set(id,{id,nativeId:native.id,method:kind==='permission'?'session/request_permission':'elicitation/create',conversationId:c.id,interaction,params});
    }
    for(const [id,a]of this.approvals)if(a.conversationId===c.id&&!pending.has(id)){if(a.interaction.status==='pending')a.interaction.status='resolved-externally';this.approvals.delete(id);}
    if(pending.size&&turn){c.status=turn.status='waiting';c.turnId=turn.id;}
    else if(c.status==='waiting'&&turn){c.status=turn.status='running';}
  }
  async respond(id,body){
    const request=this.approvals.get(id);if(!request||request.resolving)throw Error('Este pedido já foi resolvido.');
    const c=this.conversation(request.conversationId);if(c.terminal)throw Error('Responde às decisões no terminal OpenCode.');
    let suffix,payload;
    if(request.method==='session/request_permission'){
      const decision=body.decision==='cancel'?'reject':body.optionId;
      if(!['once','always','reject'].includes(decision))throw Error('Escolhe uma autorização anunciada pelo OpenCode.');
      suffix='/permission/'+encodeURIComponent(request.nativeId)+'/reply';payload={decision};
    }else{
      if(body.action!=='accept'&&body.decision!=='cancel'&&body.action!=='decline')throw Error('Responde ao formulário OpenCode.');
      if(body.decision==='cancel'||body.action==='decline')suffix='/form/'+encodeURIComponent(request.nativeId);
      else{validateElicitation(request.params.requestedSchema,body.content);suffix='/form/'+encodeURIComponent(request.nativeId)+'/reply';payload={answer:body.content};}
    }
    request.resolving=true;request.interaction.status='responding';await this.persist();
    try{await this.runtime.api(route(c,suffix),{method:payload?'POST':'DELETE',...(payload?{body:payload}:{})});request.interaction.status='answered';this.approvals.delete(id);if(body.decision==='cancel')await this.interrupt(c.id);else await this.sync(c);return {sent:true};}
    catch(error){request.interaction.status='uncertain';this.approvals.delete(id);this.changed();await this.persist();throw error;}
  }
  async interrupt(id){
    const c=this.conversation(id),turn=c.turns.at(-1);
    if(!active.has(c.status)&&c.status!=='uncertain')throw Error('Não há tarefa OpenCode para interromper.');
    if(this.submitting&&this.session?.conversation===c){turn.cancelRequested=true;this.session.stopping=true;return {requested:true};}
    await this.runtime.api(route(c,'/interrupt?resume=false'),{method:'POST'});await this.sync(c);return {requested:true};
  }
  queueEvent(event){
    if(this.closing||['server.connected','server.heartbeat'].includes(event?.type))return;
    const id=event?.data?.sessionID;
    if(typeof id==='string'){
      if(!this.conversations.some(c=>c.threadId===id))return;
      this.eventSessions.add(id);
    }else this.eventAll=true; // Unknown/global events still invalidate tracked sessions conservatively.
    this.scheduleEvents();
  }
  scheduleEvents(){
    if(this.closing||this.submitting||this.eventTimer||this.eventFlush)return;
    this.eventTimer=setTimeout(()=>{
      this.eventTimer=null;
      this.eventFlush=this.sweep().catch(()=>{}).finally(()=>{
        this.eventFlush=null;
        if(this.eventAll||this.eventSessions.size)this.scheduleEvents();
      });
    },eventBatchMs);this.eventTimer.unref();
  }
  observe(){
    if(this.observing||this.closing)return;this.observing=true;
    this.pollTimer=setInterval(()=>this.sweep().catch(()=>{}),1000);this.pollTimer.unref();
    this.eventTask=(async()=>{
      while(!this.closing){
        this.eventAbort=new AbortController();
        try{
          const response=await this.runtime.api('/api/event',{raw:true,signal:this.eventAbort.signal});
          this.eventState='connected';this.connectionError=null;this.changed();await this.sweep(true);
          for await(const event of nativeEvents(response.body)){if(this.closing)break;this.queueEvent(event);}
        }catch(error){if(!this.closing){
          const message='Ligação aos eventos OpenCode interrompida. A recuperar pelo histórico, sem reenviar pedidos.';
          if(this.eventState!=='reconnecting'||this.connectionError!==message){this.eventState='reconnecting';this.connectionError=message;this.changed();}
        }}
        if(!this.closing)await new Promise(r=>{this.reconnectTimer=setTimeout(r,1000);this.reconnectWake=r;});
      }
    })();
  }
  async sweep(all=false){
    if(this.closing||this.submitting)return;
    const at=Date.now(),idle=all||at-this.lastIdleSweep>=idleSweepMs;
    if(idle)this.lastIdleSweep=at;
    const sessions=this.eventSessions,globalEvent=this.eventAll;this.eventSessions=new Set();this.eventAll=false;
    const tasks=[];
    for(const c of this.conversations){
      if(!c.threadId)continue;
      const busy=active.has(c.status)||c.status==='uncertain'||c.terminal;
      if(!all&&!busy&&this.isArchived(c))continue;
      const retry=this.syncRetry.get(c.id);
      if(!all&&retry?.nextAt>at)continue;
      if(!all&&!idle&&!busy&&!globalEvent&&!sessions.has(c.threadId)&&!retry)continue;
      // An event arriving during a read may describe data newer than that read. Keep a trailing read.
      if(this.syncing.has(c.id)&&(globalEvent||sessions.has(c.threadId)))this.eventSessions.add(c.threadId);
      tasks.push(this.sync(c));
    }
    await Promise.allSettled(tasks);
    if(this.eventSessions.size)this.scheduleEvents();
  }
  async close(){
    this.closing=true;clearInterval(this.pollTimer);clearTimeout(this.eventTimer);clearTimeout(this.reconnectTimer);this.reconnectWake?.();this.eventAbort?.abort();
    for(const timer of this.settleTimers.values())clearTimeout(timer);this.settleTimers.clear();
    await Promise.allSettled([this.eventTask,this.eventFlush,...this.syncing.values(),...this.steerTasks,...this.sendTasks].filter(Boolean));
    await this.runtime.close();clearTimeout(this.changeTimer);clearTimeout(this.saveTimer);await this.persist();
  }
}
