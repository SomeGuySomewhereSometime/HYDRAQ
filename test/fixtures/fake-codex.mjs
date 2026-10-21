import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
let sequence = 0;
let active;
let approval;
const totals = new Map();
const usageUpdate = (input, cached, output) => {
  const total = totals.get(active.threadId) || { inputTokens:0, cachedInputTokens:0, cacheWriteInputTokens:0, outputTokens:0, reasoningOutputTokens:0, totalTokens:0 };
  total.inputTokens += input; total.cachedInputTokens += cached; total.outputTokens += output; total.totalTokens += input+output;
  totals.set(active.threadId,total);
  send({method:'thread/tokenUsage/updated',params:{...active,tokenUsage:{total:{...total},last:{inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:0,outputTokens:output,reasoningOutputTokens:0,totalTokens:input+output},modelContextWindow:100000}}});
};
const complete = (text = 'Resultado confirmado') => {
  usageUpdate(1000,700,10);
  usageUpdate(2000,1500,20);
  send({method:'item/completed',params:{threadId:active.threadId,turnId:active.turnId,item:{id:active.messageId,type:'agentMessage',text}}});
  send({method:'turn/completed',params:{threadId:active.threadId,turn:{id:active.turnId,status:'completed'}}});
  active.finished = true;
};
const planUpdate = plan => send({method:'turn/plan/updated',params:{threadId:active.threadId,turnId:active.turnId,explanation:'Plano público de teste',plan}});
const progressStart = () => {
  active.progress = true;
  planUpdate([{step:'Ler o projeto',status:'inProgress'},{step:'Corrigir o ficheiro',status:'pending'},{step:'Validar',status:'pending'}]);
  send({method:'item/completed',params:{...active,item:{id:randomUUID(),type:'agentMessage',phase:'commentary',text:'Vou ler o projeto e corrigir o ficheiro.'}}});
  send({method:'item/started',params:{...active,item:{id:'command-progress',type:'commandExecution',command:'cat exemplo.mjs',status:'inProgress'}}});
  send({method:'item/commandExecution/outputDelta',params:{...active,itemId:'command-progress',delta:'Conteúdo lido'}});
  send({method:'item/completed',params:{...active,item:{id:'command-progress',type:'commandExecution',command:'cat exemplo.mjs',status:'completed',exitCode:0}}});
  send({method:'item/started',params:{...active,item:{id:'file-progress',type:'fileChange',changes:[{path:'exemplo.mjs',diff:'- antigo\n+ novo'}]}}});
  planUpdate([{step:'Ler o projeto',status:'completed'},{step:'Corrigir o ficheiro',status:'inProgress'},{step:'Validar',status:'pending'}]);
};
createInterface({input:process.stdin}).on('line',line=> {
  const message = JSON.parse(line);
  if (!message.method) {
    if (message.id === approval) { complete(approval.startsWith('elicit-') ? JSON.stringify(message.result) : `Decisão: ${message.result.decision}`); approval = null; }
    return;
  }
  const result = value => send({id:message.id,result:value});
  if (message.method === 'initialize') result({userAgent:'fake-codex/0.159.0'});
  if (message.method === 'account/read') result({account:{type:process.env.FAKE_AUTH || 'chatgpt',planType:'test'},requiresOpenaiAuth:true});
  if (message.method === 'experimentalFeature/list') result({data:[{name:'reasoning_effort_override',stage:'underDevelopment',enabled:process.env.FAKE_REASONING_UPDATES !== 'false',defaultEnabled:false}]});
  if (message.method === 'model/list') result({data:[
    {id:'gpt-test',model:'gpt-test',displayName:'Modelo de teste',isDefault:true,hidden:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},
    {id:'gpt-other',model:'gpt-other',displayName:'Outro modelo',isDefault:false,hidden:false,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]},
    {id:'gpt-unknown',model:'gpt-unknown',displayName:'Sem metadados',isDefault:false,hidden:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]},
  ]});
  if (message.method === 'thread/start') result({thread:{id:`thread-${++sequence}`}});
  if (message.method === 'thread/resume') {
    if (process.env.FAKE_CODEX_WRITER_CONFLICT) send({id:message.id,error:{message:`thread ${message.params.threadId} already has an active writer`}});
    else result({thread:{id:message.params.threadId}});
  }
  if (message.method === 'turn/start') {
    if (!['readOnly','workspaceWrite'].includes(message.params.sandboxPolicy?.type)) { send({id:message.id,error:{message:'É necessária uma política explícita por turno'}}); return; }
    if (process.env.FAKE_CODEX_SETTINGS_LOG) appendFileSync(process.env.FAKE_CODEX_SETTINGS_LOG,JSON.stringify(message.params)+'\n');
    const text = message.params.input[0].text;
    if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(text)+'\n');
    active = {threadId:message.params.threadId,turnId:`turn-${++sequence}`,messageId:randomUUID()};
    send({method:'turn/started',params:{threadId:active.threadId,turn:{id:active.turnId,status:'inProgress'}}});
    result({turn:{id:active.turnId,status:'inProgress'}});
    if (text === 'hold') return;
    if (text === 'many-tools') {
      send({method:'item/completed',params:{...active,item:{id:'first-file',type:'fileChange',status:'completed',changes:[{path:'first.txt'}]}}});
      for(let i=0;i<205;i++)send({method:'item/completed',params:{...active,item:{id:`many-${i}`,type:'commandExecution',command:`command-${i}`,status:'completed',exitCode:i===0?42:0}}});
      complete();return;
    }
    if (text === 'progress') { progressStart(); return; }
    if (text === 'approval') {
      approval = `approve-${sequence}`;
      send({id:approval,method:'item/commandExecution/requestApproval',params:{threadId:active.threadId,turnId:active.turnId,itemId:'cmd-1',command:'echo exemplo',reason:'Teste de autorização'}});
      return;
    }
    if (text === 'elicitation') {
      approval = `elicit-${sequence}`;
      send({id:approval,method:'mcpServer/elicitation/request',params:{threadId:active.threadId,turnId:active.turnId,message:'Autorizar acesso de teste?',requestedSchema:{type:'object',properties:{}}}});
      return;
    }
    send({method:'item/agentMessage/delta',params:{...active,itemId:active.messageId,delta:'Resultado '}});
    send({method:'item/agentMessage/delta',params:{...active,itemId:active.messageId,delta:'confirmado'}});
    complete(text === 'settings' ? `${message.params.model}/${message.params.effort}` : 'Resultado confirmado');
  }
  if (message.method === 'turn/steer') {
    if (!active || active.finished || message.params.expectedTurnId !== active.turnId || message.params.threadId !== active.threadId) {
      send({id:message.id,error:{code:-32000,message:'No active turn matching expectedTurnId'}}); return;
    }
    const text = message.params.input[0].text;
    if (text === 'uncertain') return;
    if (text === 'race') {
      complete('A tarefa terminou antes da orientação.');
      send({id:message.id,error:{code:-32000,message:'No active turn matching expectedTurnId'}}); return;
    }
    if (text === 'delayed') { setTimeout(()=>result({turnId:active.turnId}),80); return; }
    result({turnId:active.turnId});
    if (text === 'finish') {
      if (active.progress) {
        send({method:'item/completed',params:{...active,item:{id:'file-progress',type:'fileChange',status:'completed',changes:[{path:'exemplo.mjs',diff:'- antigo\n+ novo'}]}}});
        planUpdate([{step:'Ler o projeto',status:'completed'},{step:'Corrigir o ficheiro',status:'completed'},{step:'Validar',status:'completed'}]);
      }
      complete('Orientação recebida no mesmo turno.');
    }
  }
  if (message.method === 'turn/interrupt') {
    result({});
    send({method:'turn/completed',params:{threadId:active.threadId,turn:{id:active.turnId,status:'interrupted'}}});
    active.finished = true;
  }
});
