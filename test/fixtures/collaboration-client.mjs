import {EventEmitter} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export class CollaborationClient extends EventEmitter {
  constructor(role,directory){super();this.role=role;this.dataDir=directory;this.defaultCwd=directory;this.conversations=[];this.approvals=new Map();this.connection='connected';this.models=role==='executor'?[{id:'grok-4.7',name:'Grok 4.7',efforts:['low','medium'],defaultEffort:'low',contexts:['256k','500k'],defaultContext:'500k',supportsFast:true}]:[{id:'gpt-test',name:'Principal de teste',efforts:['low','medium'],defaultEffort:'medium',isDefault:true}];this.timers=new Set();this.executable='unused';this.prefixArgs=[];}
  async load(){await mkdir(this.dataDir,{recursive:true});try{this.conversations=JSON.parse(await readFile(this.dataDir+'/state.json','utf8')).conversations;for(const c of this.conversations)if(['running','waiting','starting'].includes(c.status))c.status='uncertain';}catch(e){if(e.code!=='ENOENT')throw e;}}
  async persist(){await writeFile(this.dataDir+'/state.json',JSON.stringify({conversations:this.conversations}));}
  snapshot(){return{connection:this.connection,models:this.models,account:{type:'chatgpt'},defaultCwd:this.defaultCwd,conversations:this.conversations,approvals:[...this.approvals.values()],capabilities:{images:false,steer:false}};}
  changed(){this.emit('state');}
  async connect(){this.connection='connected';}
  async create(body){const c={id:randomUUID(),...body,provider:this.role==='executor'?'cursor':'codex',status:'idle',title:'Nova conversa',threadId:randomUUID(),messages:[],turns:[],items:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};this.conversations.unshift(c);await this.persist();return c;}
  conversation(id){const c=this.conversations.find(c=>c.id===id);if(!c)throw Error('Conversa não encontrada');return c;}
  later(fn,ms=20){const timer=setTimeout(()=>{this.timers.delete(timer);fn().catch(e=>{this.fixtureError=e;});},ms);this.timers.add(timer);}
  async send(id,text,requestId,settings={}){
    const c=this.conversation(id);if(c.messages.some(m=>m.requestId===requestId&&m.role==='user'))return{accepted:true,duplicate:true};
    this.lastPrompt=text;const t={id:randomUUID(),requestId,status:'running',delivery:'sending',startedAt:new Date().toISOString()};c.status='running';c.turns.push(t);c.turnId=t.id;c.messages.push({role:'user',text:settings.displayText||text,requestId,internal:settings.internal});await this.persist();this.changed();
    this.later(async()=>{
      if(c.status!=='running')return;
      if(this.role==='executor'){
        if(text.includes('COL_APPROVAL')){const id=randomUUID();this.approvals.set(id,{id,conversationId:c.id,method:'session/request_permission',params:{toolCall:{title:'node --test add.test.mjs',kind:'execute'},options:[{optionId:'allow',kind:'allow_once',name:'Permitir'},{optionId:'reject',kind:'reject_once',name:'Recusar'}]}});c.status=t.status='waiting';await this.persist();this.changed();return;}
        if(text.includes('COL_WORKER_HOLD')){c.messages.push({role:'assistant',text:'PARCIAL-REAL-DO-TESTE',requestId,turnId:t.id});await this.persist();this.changed();return;}
        if(text.includes('COL_WORKER_LOST')){c.messages.push({role:'assistant',text:'PARCIAL-INCERTO',requestId,turnId:t.id});c.status=t.status='uncertain';await this.persist();this.changed();return;}
        c.items.push({id:randomUUID(),turnId:t.id,type:'commandExecution',command:'node --test',status:'completed',exitCode:0});await this.finish(c,'EXECUTOR-RESULT · teste aprovado');return;
      }
      if(this.role==='normal'){await this.finish(c,'NORMAL');return;}
      if(text.includes('Pedido do utilizador:\nCOL_DIRECT')){await this.finish(c,'Resposta direta');return;}
      if(text.includes('Pedido do utilizador:\nCOL_PARENT_HOLD'))return;
      const lease=JSON.parse(await readFile(settings.contextMcp.file,'utf8'));
      this.lastToken=lease.token;
      if(text.startsWith('O HYDRAQ concluiu')){
        const jobId=text.match(/Tarefa ([a-f0-9-]{36})/)[1],r=await this.engine.tool(lease.token,'get_delegation_result',{jobId});
        if(c.loop&&!c.looped){c.looped=true;await this.engine.tool(lease.token,'delegate_to_executor',{requestKey:'fix',instructions:'Corrigir e testar',task:'implement'});await this.finish(c,'Pedi correção');return;}
        await this.finish(c,'Avaliação: '+r.text);return;
      }
      c.loop=text.includes('COL_LOOP');
      const instructions=text.includes('COL_WORKER_HOLD')?'COL_WORKER_HOLD':text.includes('COL_WORKER_LOST')?'COL_WORKER_LOST':text.includes('COL_APPROVAL')?'COL_APPROVAL':'Implementar e testar';
      const args={requestKey:'task',instructions,task:'implement'};
      await this.engine.tool(lease.token,'delegate_to_executor',args);
      this.duplicate=await this.engine.tool(lease.token,'delegate_to_executor',args);
      if(text.includes('COL_BUDGET'))for(let i=1;i<=3;i++){try{await this.engine.tool(lease.token,'delegate_to_executor',{...args,requestKey:'task-'+i});}catch(e){this.budgetError=e.message;}}
      if(text.includes('COL_GATE'))return;
      await this.finish(c,'Deleguei; aguardo o resultado');
    });return{accepted:true};
  }
  async finish(c,text){const t=c.turns.at(-1);c.status=t.status='completed';t.delivery='confirmed';t.completedAt=new Date().toISOString();t.finalAnswer=text;c.turnId=null;c.messages.push({role:'assistant',text,turnId:t.id,requestId:t.requestId});await this.persist();this.changed();}
  async interrupt(id){const c=this.conversation(id);c.status=c.turns.at(-1).status='interrupted';c.turnId=null;for(const[key,r]of this.approvals)if(r.conversationId===id)this.approvals.delete(key);await this.persist();this.changed();return{requested:true};}
  async respond(id,body){const r=this.approvals.get(id);if(!r)throw Error('Pedido inexistente');this.approvals.delete(id);const c=this.conversation(r.conversationId);if(body.optionId==='allow')await this.finish(c,'EXECUTOR-RESULT · autorização confirmada');else await this.interrupt(c.id);return{sent:true};}
  async close(){for(const timer of this.timers)clearTimeout(timer);this.timers.clear();for(const c of this.conversations)if(['running','waiting'].includes(c.status))c.status='uncertain';await this.persist();}
}

export class TestSupervisor {
  constructor(){this.stops=[];this.availableValue=true;}
  async available(){return{available:this.availableValue,reason:'Supervisão indisponível no teste'};}
  wrap(executable,args,unit){this.lastUnit=unit;return{executable,args};}
  async stop(unit){if(this.stopError)throw Error('Não foi confirmada a limpeza');this.stops.push(unit);}
}
