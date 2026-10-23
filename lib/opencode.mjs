import { Cursor } from './cursor.mjs';
import { AcpRpc } from './acp-rpc.mjs';
import { OpenCodeRuntime } from './opencode-runtime.mjs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const active=new Set(['starting','running','waiting']);
const values=o=>(o?.options||[]).flatMap(e=>e.options||[e]);
let inputTime=0,inputCounter=0;
// Match OpenCode's sortable timestamp prefix, with an independent random suffix.
const inputId=()=>{const time=Date.now();inputCounter=time===inputTime?inputCounter+1:1;inputTime=time;return 'msg_'+(BigInt(time)*4096n+BigInt(inputCounter)).toString(16).slice(-12).padStart(12,'0')+randomUUID().replaceAll('-','').slice(0,14);};
export class OpenCode extends Cursor {
  constructor({dataDir,defaultCwd,executable=process.env.HYDRAQ_OPENCODE_BIN||(existsSync(path.join(os.homedir(),'.opencode/bin/opencode'))?path.join(os.homedir(),'.opencode/bin/opencode'):'opencode'),env=process.env,prefixArgs=[],runtime}={}){
    const adapter=new OpenCodeAdapter();super({dataDir,defaultCwd,executable,env,prefixArgs,adapter});
    this.runtime=runtime||new OpenCodeRuntime({directory:path.join(dataDir,'native'),executable,env:this.env,args:prefixArgs});
    this.steerTasks=new Set();this.steerSettlements=new Map();
    this.on('state',()=>{if(this.closing||this.steerTasks.size)return;for(const c of this.conversations)if(!active.has(c.status)&&c.messages.some(m=>m.kind==='steer'&&m.delivery==='sending'))this.settleSteers(c).catch(()=>{});});
  }
  async load(){await super.load();await this.runtime.loadCache?.();for(const c of this.conversations)for(const m of c.messages)if(m.kind==='steer'&&['preparing','sending'].includes(m.delivery)){m.delivery='uncertain';m.error='O HYDRAQ reiniciou antes de confirmar a orientação. Nada foi reenviado.';}}
  snapshot(){return {...super.snapshot(),account:this.connection==='connected'?{type:'opencode',planType:'OpenCode · só gratuitos'}:null,capabilities:{steer:true,nativeApprovals:true,images:true,questions:true,plans:true,tokenUsage:true,accessModes:['workspace-write','plan']},catalogs:Object.fromEntries(this.runtime.cache),catalogScope:this.catalogScope||null};}
  async refreshModels(cwd=this.defaultCwd,options={}){
    try{const record=await this.runtime.refresh(cwd,options);if(this.models.length&&JSON.stringify(this.models)!==JSON.stringify(record.models))this.needsCatalogRestart=true;this.catalogScope=record.cwd;this.models=record.models;this.changed();return record;}
    catch(e){this.changed();throw e;}
  }
  async create(body){await this.refreshModels(body.cwd);return super.create(body);}
  async send(id,text,requestId,settings={}){
    const c=this.conversation(id);
    // Duplicate admission must not depend on a changed catalogue; it never resends bytes.
    if(!c.messages.some(m=>m.requestId===requestId)){
      if(active.has(c.status)||this.steerTasks.size)throw Error('Aguarda o fim do pedido ou da orientação OpenCode.');
      await this.refreshModels(c.cwd,{force:true});await this.settleSteers(c);
      if(this.needsCatalogRestart&&this.session?.phase==='idle'){await this.session.rpc.close();this.session=null;}this.needsCatalogRestart=false;
    }
    return super.send(id,text,requestId,settings);
  }
  steer(id,text,requestId,expectedTurnId,mode='steer') {
    const task=this.submitSteer(id,text,requestId,expectedTurnId,mode);this.steerTasks.add(task);
    task.finally(()=>{this.steerTasks.delete(task);this.changed();}).catch(()=>{});return task;
  }
  async submitSteer(id,text,requestId,expectedTurnId,mode) {
    if(this.closing||this.connection!=='connected')throw Error('O OpenCode não está disponível.');
    if(typeof text!=='string'||!text.trim()||text.length>100000||typeof requestId!=='string'||!requestId||requestId.length>100||mode!=='steer')throw Error('Orientação inválida.');
    const c=this.conversation(id),session=this.session,old=c.messages.find(m=>m.requestId===requestId);
    if(old){if(old.kind!=='steer'||old.text!==text.trim()||old.turnId!==expectedTurnId||old.mode!==mode)throw Error('Identificador já usado para outra orientação.');return {accepted:true,duplicate:true,delivery:old.delivery};}
    const running=()=>!this.closing&&c.turnId===expectedTurnId&&['running','waiting'].includes(c.status)&&session===this.session&&session?.conversation===c&&session.phase==='prompt'&&!session.stopping;
    if(!expectedTurnId||!running())throw Error('Esse turno já terminou. A orientação não iniciou outro pedido.');
    if(c.messages.some(m=>m.kind==='steer'&&['preparing','sending','uncertain'].includes(m.delivery)))throw Error('Já há uma orientação a aguardar confirmação.');
    const message={id:randomUUID(),nativeInputId:inputId(),nativeSessionId:c.threadId,requestId,role:'user',kind:'steer',mode,text:text.trim(),turnId:expectedTurnId,model:c.model,effort:c.effort,at:new Date().toISOString(),delivery:'preparing'};
    c.messages.push(message);this.changed();
    try{
      await this.persist();if(!running())throw Error('O turno terminou antes de receber a orientação.');
      message.delivery='sending';await this.persist();
      if(!running()){message.delivery='rejected';throw Error('O turno terminou antes de receber a orientação.');}
      await this.runtime.admitSteer(c.threadId,message,running);message.nativeEnqueued=true;
    }catch(error){message.delivery=message.delivery==='sending'?'uncertain':'rejected';message.error=error.message;this.changed();await this.persist();throw error;}
    this.changed();await this.persist();if(!active.has(c.status))await this.settleSteers(c);
    return {accepted:true,delivery:message.delivery,turnId:expectedTurnId};
  }
  settleSteers(c) {
    if(this.steerSettlements.has(c.id))return this.steerSettlements.get(c.id);
    const messages=c.messages.filter(m=>m.kind==='steer'&&['sending','uncertain'].includes(m.delivery));
    if(!messages.length)return Promise.resolve();
    const task=(async()=>{for(const m of messages){
      try{const delivered=await this.runtime.settleSteer(m.nativeSessionId||c.threadId,m);m.delivery=delivered?'accepted':'rejected';m.nativeEnqueued=false;m.error=delivered?null:'O turno terminou sem receber esta orientação. Foi retirada da fila nativa e não será reenviada.';}
      catch(error){m.delivery='uncertain';m.error='Não foi possível confirmar ou retirar a orientação nativa. Nada foi reenviado.';throw error;}
      finally{this.changed();await this.persist();}
    }})();this.steerSettlements.set(c.id,task);task.finally(()=>this.steerSettlements.delete(c.id)).catch(()=>{});return task;
  }
  async close(){this.closing=true;await Promise.allSettled([...this.steerTasks]);await super.close();await Promise.allSettled(this.conversations.map(c=>this.settleSteers(c)));await this.runtime.close();clearTimeout(this.changeTimer);clearTimeout(this.saveTimer);await this.persist();}
}
class OpenCodeAdapter {
  id='opencode';label='OpenCode';
  async process(owner,cwd,contextMcp){
    const env=await owner.runtime.environment('acp:'+cwd,contextMcp);delete env.OPENCODE_SERVER_PASSWORD;if(owner.closing)throw Error('OpenCode está a encerrar.');
    const rpc=new AcpRpc({executable:process.execPath,args:[fileURLToPath(new URL('./opencode-process.mjs',import.meta.url)),String(process.pid),owner.executable,...owner.prefixArgs,'acp'],cwd,env,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false,elicitation:{form:true},session:{compaction:true}}});
    return rpc;
  }
  async connect(owner){
    if(owner.submitting||owner.conversations.some(c=>active.has(c.status)))throw Error('Aguarda o fim do pedido OpenCode.');
    if(owner.connection==='connecting')throw Error('A ligação ao OpenCode já está em curso.');
    owner.connection='connecting';owner.connectionError=null;owner.changed();
    try{await owner.refreshModels(owner.defaultCwd,{force:true});owner.connection='connected';owner.supportsImages=true;}
    catch(e){owner.connection='disconnected';owner.connectionError=e.message;throw e;}
    finally{owner.changed();}return owner.snapshot();
  }
  validate(owner,c,settings){
    const model=owner.models.find(m=>m.id===(settings.model??c?.model));
    if(!model||model.providerID!=='opencode'||model.free!==true)throw Error('Escolhe um modelo gratuito do fornecedor OpenCode.');
    const effort=settings.effort??(model.efforts.includes(c?.effort)?c.effort:model.defaultEffort);
    if(!model.efforts.includes(effort))throw Error('Variante indisponível neste modelo OpenCode.');
    const sandbox=settings.sandbox??c?.sandbox??'workspace-write';
    if(!['workspace-write','plan','read-only'].includes(sandbox))throw Error('No OpenCode escolhe Executar ou Planear.');
    if(settings.images?.length&&!model.images)throw Error('Este modelo OpenCode não anuncia entrada de imagens.');
    return {model:model.id,effort,sandbox:sandbox==='read-only'?'plan':sandbox,context:null,fast:false};
  }
  async configure(owner,session,settings){
    const {rpc,conversation:c}=session;
    const model=owner.models.find(m=>m.id===settings.model);
    if(!model?.free)throw Error('O modelo deixou de estar disponível como gratuito.');
    const changes=[['model',settings.model],['mode',settings.sandbox==='plan'?'plan':'build']];let result;
    for(const [configId,value]of changes){if(session.stopping||!active.has(c.status))throw Error('Preparação OpenCode interrompida.');result=await rpc.call('session/set_config_option',{sessionId:c.threadId,configId,value});if(!result?.configOptions?.some(o=>o.id===configId&&o.currentValue===value))throw Error(`OpenCode não confirmou ${configId}.`);}
    const effort=result.configOptions.find(o=>o.id==='effort');
    if(effort){if(!values(effort).some(o=>o.value===settings.effort))throw Error('A variante já não está disponível no OpenCode.');result=await rpc.call('session/set_config_option',{sessionId:c.threadId,configId:'effort',value:settings.effort});}
    else if(settings.effort!=='default')throw Error('O OpenCode não anunciou variantes para este modelo.');
    for(const [id,value]of [...changes,...(effort?[['effort',settings.effort]]:[])])if(!result.configOptions.some(o=>o.id===id&&o.currentValue===value))throw Error('A configuração OpenCode mudou antes do envio.');
    session.costBefore=c.nativeCost??0;
  }
  notification(owner,session,u){
    const c=session.conversation,t=session.turn;
    if(u.sessionUpdate==='usage_update'&&u.cost?.currency==='USD'&&Number.isFinite(u.cost.amount)){c.nativeCost=u.cost.amount;t.costUSD=Math.max(0,u.cost.amount-session.costBefore);}
    if(u.sessionUpdate==='compaction_update'&&u.status==='completed'){
      c.compactions||=[];if(!c.compactions.includes(u.compactionId)){c.compactions.push(u.compactionId);c.contextEpoch=(c.contextEpoch||0)+1;}
    }
    if(u.sessionUpdate==='config_option_update'){t.catalogChanged=true;const cached=owner.runtime.cache.get(c.cwd);if(cached)cached.stale=true;}
    if(u.sessionUpdate==='session_info_update'&&u._meta?.['opencode/retry'])t.nativeRetry={attempt:u._meta['opencode/retry'].attempt,nextRetryAt:u._meta['opencode/retry'].nextRetryAt};
  }
  result(owner,session,r){
    const t=session.turn,u=r.usage;if(u&&[u.inputTokens,u.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)){
      t.usage={inputTokens:u.inputTokens,outputTokens:u.outputTokens,totalTokens:u.totalTokens??u.inputTokens+u.outputTokens,source:'OpenCode · chamadas da sessão principal',cacheMeasured:false};
    }
    // Usage update may be absent even on a free request: cost is unavailable, never fabricated.
    delete t.nativeRetry;
  }
  formResult(params,body){
    if(body.decision==='cancel'||body.action==='decline')return {action:body.decision==='cancel'?'cancel':'decline'};
    if(body.action!=='accept'||!body.content||typeof body.content!=='object'||Array.isArray(body.content)||JSON.stringify(body.content).length>16000)throw Error('Responde ao formulário OpenCode com um objeto válido.');
    for(const name of params.requestedSchema?.required||[])if(!Object.hasOwn(body.content,name))throw Error('Falta a resposta a '+name+'.');
    return {action:'accept',content:body.content};
  }
}
