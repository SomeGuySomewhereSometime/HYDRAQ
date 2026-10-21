import { writeHistory } from './state-store.mjs';
import { imageText, imageRecords, messageImages } from './attachments.mjs';
import { withoutCursorCredentials } from './cursor-auth.mjs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { summarizeProgress } from './progress.mjs';
import { observeAction } from './turn-facts.mjs';

const active = new Set(['starting', 'running', 'waiting']);
const now = () => new Date().toISOString();
const limit = value => String(value ?? '').slice(-60_000);
const effortsOrder = ['low', 'medium', 'high', 'xhigh', 'max'];
const nativeFamily = /^(?:gemini-\d|claude-(?:opus|sonnet|haiku)-|gpt-oss-|gemma-\d)[\w.-]*$/;
const effortSuffix = /^(.+)-(low|medium|high|xhigh|max)$/;
const usageKeys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'thinking_tokens', 'total_tokens'];
const ZERO_NATIVE_USAGE = Object.freeze({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 0 });
const fileTools = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file', 'create_file', 'delete_file']);
const webTools = new Set(['search_web', 'read_url_content']);

export function parseAntigravityModels(output) {
  const models = new Map();
  const clean = stripVTControlCharacters(String(output ?? ''));
  for (const rawLine of clean.split(/\r\n|[\r\n]/)) {
    const line = rawLine.replace(/^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+/, '').trim();
    const entry = /^(\S+)\s+(.+)$/.exec(line);
    if (!entry || !nativeFamily.test(entry[1])) continue;
    const suffix = effortSuffix.exec(entry[1]);
    const id = suffix ? suffix[1] : entry[1];
    const effort = suffix ? suffix[2] : (/\((low|medium|high|xhigh|max)\)$/i.exec(entry[2])?.[1]?.toLowerCase() || 'medium');
    if (!models.has(id)) {
      models.set(id, {
        id,
        name: entry[2].replace(/\s*\((?:Low|Medium|High|Xhigh|Max)\)$/i, '').trim(),
        description: 'Catálogo do Antigravity original · sessão existente',
        efforts: [],
        slugs: {},
        defaultEffort: effort,
        supportsReasoningEffortUpdates: null,
      });
    }
    const model = models.get(id);
    if (!model.efforts.includes(effort)) model.efforts.push(effort);
    model.slugs[effort] = entry[1];
  }
  for (const model of models.values()) {
    model.efforts.sort((a, b) => effortsOrder.indexOf(a) - effortsOrder.indexOf(b));
    model.defaultEffort = model.efforts.includes('high') ? 'high' : model.efforts.at(-1);
  }
  if (!models.size) throw new Error('O agy não devolveu um catálogo nativo reconhecido. Confirma a sessão no CLI original.');
  return [...models.values()];
}

export function nativeTurnUsage(total, baseline) {
  if (!total || !baseline) return null;
  const delta = {};
  for (const key of usageKeys) {
    const current = total[key] ?? (key === 'total_tokens' ? (total.input_tokens ?? 0) + (total.output_tokens ?? 0) : undefined);
    const before = baseline[key] ?? (key === 'total_tokens' ? (baseline.input_tokens ?? 0) + (baseline.output_tokens ?? 0) : 0);
    if (!Number.isFinite(current) || !Number.isFinite(before) || current < before) return null;
    delta[key] = current - before;
  }
  return delta;
}

export async function checkAntigravitySettings(settingsFile) {
  let settings;
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Não foi possível verificar as opções de créditos do Antigravity.');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Configuração do Antigravity inválida.');
  if (settings.useG1Credits !== undefined && settings.useG1Credits !== false) throw new Error('Desativa Use G1 Credits no agy (/settings) para usar apenas a quota do plano. O HYDRAQ não altera esta opção global.');
  if (settings.customModels && Object.keys(settings.customModels).length) throw new Error('Esta integração aceita apenas o catálogo nativo, sem modelos personalizados com API.');
}

function classifyToolStep(step, item) {
  const info = step.tool_info || {};
  const subagentInfo = step.subagent_info;
  const name = step.tool_name || info.name || (subagentInfo ? 'invoke_subagent' : 'Ferramenta');
  const params = info.parameters || {};
  const errorMessage = info.error?.message || (typeof info.error === 'string' ? info.error : '');
  const permissionDenied = Boolean(info.error && (info.error.type === 'PERMISSION_DENIED' || /permiss|approval|aprov|confirm|headless|soft-denied/i.test(`${errorMessage} ${info.output || ''}`)));
  const status = info.error ? 'failed' : step.state === 'DONE' ? 'completed' : 'inProgress';
  const rawOutput = [info.output, errorMessage].filter(Boolean).join('\n');

  Object.assign(item, {
    tool: name,
    server: 'Antigravity',
    status,
    permissionDenied,
    aggregatedOutput: limit(rawOutput),
    parameters: params,
    error: info.error,
  });

  if (subagentInfo || name === 'invoke_subagent') {
    const subagents = subagentInfo?.subagents || params.Subagents || [];
    const labels = Array.isArray(subagents)
      ? subagents.map(s => s.role || s.Role || s.type_name || s.TypeName).filter(Boolean)
      : [];
    item.type = 'subagent';
    item.subagents = labels;
    item.detail = labels.join(', ') || 'Subagente';
  } else if (name === 'run_command') {
    item.type = 'commandExecution';
    item.command = params.CommandLine || params.command || name;
  } else if (fileTools.has(name)) {
    item.type = 'fileChange';
    const target = params.TargetFile || params.file_path || params.path || name;
    const snippet = params.ReplacementContent ?? params.CodeContent ?? '';
    item.changes = [{ path: String(target), diff: limit(snippet) }];
  } else if (webTools.has(name)) {
    item.type = 'webSearch';
    item.query = params.query || params.Url || params.url || name;
  } else {
    item.type = 'mcpToolCall';
    const target = params.AbsolutePath || params.SearchPath || params.DirectoryPath || params.Query || '';
    if (target && !item.aggregatedOutput) item.summary = String(target);
  }
}

/** Original agy process, native NDJSON protocol; no control/steer messages or retries. */
export class Antigravity extends EventEmitter {
  constructor({ dataDir, defaultCwd, executable = process.env.HYDRAQ_AGY_BIN || 'agy', prefixArgs = [], env = process.env, settingsFile = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json') }) {
    super();
    Object.assign(this, { dataDir, defaultCwd, executable, prefixArgs, settingsFile });
    this.env = withoutCursorCredentials(env);
    for (const key of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_APPLICATION_CREDENTIALS','ANTHROPIC_API_KEY','OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_BASE_URL']) delete this.env[key];
    this.conversations = [];
    this.models = [];
    this.connection = 'disconnected';
    this.connectionError = null;
    this.account = null;
    this.saveChain = Promise.resolve();
    this.session = null;
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDir, 'state.json'), 'utf8'));
      if (!Array.isArray(saved.conversations)) throw new Error('Histórico inválido.');
      this.conversations = saved.conversations;
      for (const conversation of this.conversations) conversation.messages = conversation.messages.filter(message=>message.role!=='assistant'||message.text?.trim());
      for (const conversation of this.conversations) if (active.has(conversation.status)) {
        conversation.status = 'uncertain';
        conversation.turnId = null;
        conversation.error = 'O HYDRAQ terminou sem confirmar o resultado. O pedido não foi reenviado.';
        for (const turn of conversation.turns) if (active.has(turn.status)) turn.status = 'uncertain';
        for (const message of conversation.messages) message.streaming = false;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  snapshot() {
    return { connection: this.connection, connectionError: this.connectionError, account: this.account, models: this.models.map(({slugs,...model})=>model), defaultCwd: this.defaultCwd, capabilities: { steer: false, nativeApprovals: false }, conversations: this.conversations.map(c=>({...c, progress:summarizeProgress(c)})), approvals: [] };
  }

  changed() {
    if (!this.changeTimer) this.changeTimer = setTimeout(()=> { this.changeTimer = null; this.emit('state',this.snapshot()); },75);
    if (!this.saveTimer) this.saveTimer = setTimeout(()=> { this.saveTimer = null; this.persist().catch(error=> { this.connectionError = `Não foi possível guardar o histórico: ${error.message}`; this.emit('state',this.snapshot()); }); },600);
  }

  persist() {
    const contents = JSON.stringify({version:1,conversations:this.conversations},null,2);
    this.saveChain = this.saveChain.catch(()=>{}).then(async()=> {
      await writeHistory(this.dataDir, contents);
    });
    return this.saveChain;
  }

  async connect() {
    if (this.connection === 'connecting') throw new Error('A ligação ao Antigravity já está em curso.');
    this.connection = 'connecting'; this.connectionError = null; this.changed();
    try {
      await checkAntigravitySettings(this.settingsFile);
      const output = await new Promise((resolve,reject)=> {
        const child = spawn(this.executable,[...this.prefixArgs,'models'],{env:this.env,stdio:['ignore','pipe','pipe'],detached:true});
        this.catalogProcess = child;
        let stdout = '', stderr = '';
        const timer = setTimeout(()=> { this.#kill(child); reject(new Error('O agy não confirmou o catálogo. Abre o CLI original e verifica a sessão.')); },30_000);
        child.stdout.on('data',data=> { stdout += data; if (stdout.length>1_000_000) { this.#kill(child); reject(new Error('Catálogo demasiado grande.')); } });
        child.stderr.on('data',data=> { stderr = limit(stderr+data); });
        child.once('error',error=> { clearTimeout(timer);reject(new Error(`Não foi possível executar o Antigravity (agy): ${error.message}`)); });
        child.once('close',code=> { clearTimeout(timer);if(this.catalogProcess===child)this.catalogProcess=null; code===0 ? resolve(stdout) : reject(new Error(limit(stderr)||`O agy terminou (${code}). Abre o CLI original e verifica a sessão.`)); });
      });
      this.models = parseAntigravityModels(output);
      this.account = {type:'native',planType:'Sessão do agy · catálogo confirmado'};
      this.connection = 'connected';
    } catch (error) {
      this.connection = 'disconnected'; this.models = []; this.account = null; this.connectionError = error.message;
      this.changed(); throw error;
    }
    this.changed(); return this.snapshot();
  }

  conversation(id) { const c=this.conversations.find(c=>c.id===id); if(!c)throw new Error('Conversa não encontrada.');return c; }
  #ready() { if(this.connection!=='connected')throw new Error('Liga primeiro o Antigravity. Se necessário, inicia sessão no agy original.'); }

  async create({cwd,model,effort,sandbox='workspace-write'}) {
    this.#ready();
    const selected = this.models.find(m=>m.id===model);
    if(!selected || (effort && !selected.efforts.includes(effort)))throw new Error('Escolhe modelo e raciocínio do catálogo do Antigravity.');
    if(!['workspace-write','accept-edits','plan'].includes(sandbox))throw new Error('No Antigravity escolhe execução, aceitação de edições ou planeamento nativo.');
    if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('Indica o caminho absoluto do projeto.');
    const folder = await realpath(cwd);
    if(!(await stat(folder)).isDirectory())throw new Error('O projeto não é uma pasta.');
    const c={id:randomUUID(),provider:'antigravity',threadId:null,turnId:null,title:'Nova conversa',cwd:folder,model,effort:effort||selected.defaultEffort,sandbox,status:'idle',createdAt:now(),updatedAt:now(),messages:[],items:[],turns:[],diff:'',error:null};
    this.conversations.unshift(c);await this.persist();this.changed();return c;
  }

  async send(id,text,requestId,settings={}) {
    this.#ready();
    if(typeof text!=='string'||!text.trim()||text.length>100_000)throw new Error('Escreve um pedido com até 100 000 caracteres.');
    if(typeof requestId!=='string'||!requestId||requestId.length>100)throw new Error('Identificador do pedido inválido.');
    const c=this.conversation(id);
    const shown=(settings.displayText??text).trim();
    const previous=c.messages.find(m=>m.requestId===requestId);
    if(previous) { if(previous.text!==shown)throw new Error('Identificador já usado para outro texto.');return {accepted:true,duplicate:true}; }
    if(this.submitting||this.conversations.some(c=>active.has(c.status)))throw new Error('Já há uma tarefa em curso.');
    if(c.status==='uncertain')throw new Error('O resultado anterior é incerto. Cria outra conversa para evitar repetição de trabalho.');
    const model=this.models.find(m=>m.id===(settings.model??c.model));
    const effort=settings.effort??(model?.efforts.includes(c.effort)?c.effort:model?.defaultEffort);
    if(!model?.slugs[effort])throw new Error('Combinação de modelo e raciocínio indisponível no Antigravity.');
    const sandbox=settings.sandbox??c.sandbox;
    if(!['workspace-write','accept-edits','plan'].includes(sandbox))throw new Error('Modo de acesso inválido no Antigravity.');
    this.submitting=true;
    try {
      await checkAntigravitySettings(this.settingsFile);
      const slug=model.slugs[effort];
      const imageDirectory=settings.imageDirectory ?? (this.session?.conversation===c?this.session.imageDirectory:undefined);
      const switchingProcess = Boolean(this.session && (this.session.conversation!==c || this.session.slug!==slug || c.sandbox!==sandbox || this.session.imageDirectory!==imageDirectory));
      const reusingWarmProcess = Boolean(this.session && !switchingProcess);
      const baseline = reusingWarmProcess
        ? (c.nativeUsage ? { ...c.nativeUsage } : null)
        : (!c.threadId ? { ...ZERO_NATIVE_USAGE } : (c.nativeUsage ? { ...c.nativeUsage } : null));
      c.model=model.id;c.effort=effort;c.sandbox=sandbox;c.error=null;c.status='starting';c.turnId=randomUUID();c.updatedAt=now();
      const turn={id:c.turnId,requestId,model:c.model,effort,sandbox,status:'starting',delivery:'preparing',startedAt:now(),completedAt:null,usage:null,nativeUsageBaseline:baseline,nativeTurnUsage:null,...(settings.internal?{internal:settings.internal}:{})};
      if(settings.projectDelivery)turn.projectDelivery=settings.projectDelivery;
    c.turns.push(turn);
      if(settings.images?.length)turn.inputAttachments=imageRecords(settings.images);
      c.messages.push({id:randomUUID(),requestId,role:'user',text:shown,at:now(),model:c.model,effort,turnId:turn.id,...(settings.internal?{internal:settings.internal}:{}),...(settings.handoffContext?{handoffContext:settings.handoffContext}:{})});
      if(messageImages(settings).length)c.messages.at(-1).attachments=imageRecords(messageImages(settings));
      if(settings.projectContext)c.messages.at(-1).projectContext=settings.projectContext;
      if(settings.contextImages?.length)c.messages.at(-1).contextImages=settings.contextImages;
      if(c.title==='Nova conversa'&&!settings.internal)c.title=shown.replace(/\s+/g,' ').slice(0,66);
      this.changed();
      try {
        if(switchingProcess)await this.#retire();
        if(turn.cancelRequested)return {accepted:true,interrupted:true};
        await this.persist();
        if(turn.cancelRequested)return {accepted:true,interrupted:true};
        if(!this.session) this.#start(c,slug,imageDirectory);
        this.session.turn=turn;
        turn.delivery='sending';
        await this.#writePrompt(this.session,{event:'user',message:{content:imageText(text.trim(),settings.images)}});
        if(c.status==='starting') { c.status='running';turn.status='running'; }
        this.changed();return {accepted:true};
      } catch(error) {
        if(turn.cancelRequested&&turn.delivery==='preparing')return {accepted:true,interrupted:true};
        if(active.has(c.status)){c.status=turn.delivery==='sending'?'uncertain':'failed';turn.status=c.status;c.turnId=null;}
        c.error=`Sem confirmação do agy: ${error.message}. O pedido não foi reenviado.`;this.changed();await this.persist();throw error;
      }
    } finally {this.submitting=false;}
  }

  #writePrompt(session,payload) {
    return new Promise((resolve,reject)=> {
      const {child}=session;
      if(!child.stdin||child.stdin.destroyed||child.exitCode!==null) {
        reject(new Error(session.protocolError||limit(session.stderr)||'O processo do agy terminou antes de receber o pedido.'));
        return;
      }
      const onClose=()=>reject(new Error(session.protocolError||limit(session.stderr)||'O processo do agy fechou durante o envio.'));
      const onError=error=>reject(error);
      child.once('close',onClose);
      child.stdin.once('error',onError);
      child.stdin.write(JSON.stringify(payload)+'\n',error=> {
        child.off('close',onClose);
        child.stdin.off('error',onError);
        error ? reject(error) : resolve();
      });
    });
  }

  #start(c,slug,imageDirectory) {
    const args=[...this.prefixArgs,'--input-format','stream-json','--output-format','stream-json','--disable-slash-commands','--model',slug,'--sandbox'];
    if(c.sandbox==='plan')args.push('--mode','plan');
    else if(c.sandbox==='accept-edits')args.push('--mode','accept-edits');
    if(c.threadId)args.push('--conversation',c.threadId);
    if(imageDirectory)args.push('--add-dir',imageDirectory);
    const child=spawn(this.executable,args,{cwd:c.cwd,env:this.env,stdio:['pipe','pipe','pipe'],detached:true});
    const session={child,conversation:c,slug,imageDirectory,turn:null,buffer:'',stderr:'',decoder:new StringDecoder('utf8'),retiring:false,stopping:false,settled:false};
    session.closed=new Promise(resolve=>session.resolveClosed=resolve);
    this.session=session;
    child.stdin.on('error',()=>{});
    child.stdout.on('data',data=> {
      session.buffer+=session.decoder.write(data);
      if(session.buffer.length>8_000_000){session.protocolError='Evento do agy demasiado grande.';this.#kill(child);return;}
      let newline;
      while((newline=session.buffer.indexOf('\n'))>=0) {
        const line=session.buffer.slice(0,newline).trim();session.buffer=session.buffer.slice(newline+1);
        if(!line)continue;
        try { this.#event(session,JSON.parse(line)); }
        catch(error){session.protocolError=error.message;this.#kill(child);break;}
      }
    });
    child.stderr.on('data',data=>{session.stderr=limit(session.stderr+data);});
    child.once('error',error=>{session.protocolError=`Não foi possível executar o agy: ${error.message}`;});
    child.once('close',(code,signal)=> {
      const tail= (session.buffer+session.decoder.end()).trim();
      session.buffer='';
      if(tail && !session.protocolError) {
        for(const raw of tail.split(/\r?\n/)) {
          const line=raw.trim();
          if(!line)continue;
          try { this.#event(session,JSON.parse(line)); }
          catch(error){session.protocolError=error.message;break;}
        }
      }
      if(session.turn && active.has(session.turn.status)) {
        const status=session.stopping?'interrupted':'uncertain';
        session.turn.status=status;session.turn.completedAt=now();c.status=status;c.turnId=null;
        c.error=session.stopping?null:(session.protocolError||limit(session.stderr)||`O agy terminou (${signal||code}) sem confirmar o resultado. O pedido não foi reenviado.`);
        for(const message of c.messages)if(message.turnId===session.turn.id)message.streaming=false;
        this.changed();
      }
      clearTimeout(session.stopTimer);
      if(this.session===session)this.session=null;
      session.resolveClosed();
    });
  }

  #event(session,event) {
    const c=session.conversation, turn=session.turn;
    if(event.event==='init') {
      if(!event.conversation_id || (c.threadId && c.threadId!==event.conversation_id))throw new Error('O agy não retomou a conversa esperada. Nenhum pedido será reenviado.');
      if(event.init?.model && event.init.model!==session.slug)throw new Error('O agy indicou um modelo diferente do solicitado.');
      c.threadId=event.conversation_id;
      if(event.init?.permission_mode)c.permissionMode=event.init.permission_mode;
      this.changed();return;
    }
    if(!turn||!active.has(turn.status))return;
    if(event.event==='step_update') {
      const step=event.step_update;
      if(!step || !Number.isInteger(step.step_index) || step.step_index<0 || (step.conversation_id && step.conversation_id!==c.threadId))throw new Error('Atualização do agy inválida ou para uma conversa diferente.');
      const id=`${turn.id}:${step.step_index}`;
      if(step.step_type==='agent_response') {
        let message=c.messages.find(m=>m.id===id);
        if(!message && !step.text_delta)return;
        if(!message){message={id,role:'assistant',text:'',at:now(),turnId:turn.id,requestId:turn.requestId,model:c.model,effort:c.effort,phase:'commentary',...(turn.internal?{internal:turn.internal}:{})};c.messages.push(message);}
        message.text+=step.text_delta||'';message.streaming=step.state!=='DONE';
      } else if(step.step_type==='tool' || step.step_type==='subagent' || step.subagent_info) {
        let item=c.items.find(i=>i.id===id);
        if(!item){item={id,turnId:turn.id,at:now(),type:'nativeTool'};c.items.push(item);if(c.items.length>200)c.items.shift();}
        classifyToolStep(step,item);
        observeAction(c,turn,item);
      }
      this.changed();
    } else if(event.event==='result') {
      const result=event.result||{};
      if((!c.threadId || result.conversation_id!==c.threadId) && !(result.status==='ERROR' && !result.conversation_id))throw new Error('Resultado sem confirmação da conversa nativa.');
      if((result.response!==undefined && typeof result.response!=='string') || (result.status==='SUCCESS' && typeof result.response!=='string'))throw new Error('Resposta nativa inválida; conclusão não confirmada.');
      const status={SUCCESS:'completed',ERROR:'failed',CANCELED:'interrupted',INTERRUPTED:'interrupted',INVALID:'failed'}[result.status]||'uncertain';
      c.status=status;turn.status=status;turn.completedAt=now();c.turnId=null;c.updatedAt=now();
      c.error=result.error||(['completed','interrupted'].includes(status)?null:'O CLI terminou sem confirmar a conclusão.');
      for(const message of c.messages)if(message.turnId===turn.id)message.streaming=false;
      c.messages=c.messages.filter(message=>message.turnId!==turn.id||message.role!=='assistant'||message.text.trim());
      if(result.response) {
        turn.finalAnswer=result.response;
        const turnMessages=c.messages.filter(m=>m.turnId===turn.id&&m.role==='assistant');
        const last=turnMessages.at(-1);
        const combined=turnMessages.map(m=>m.text.trim()).filter(Boolean).join('\n\n');
        const trimmed=result.response.trim();
        if(last && (last.text.trim()===trimmed || (turnMessages.length>1 && combined===trimmed))) {
          last.phase='final_answer';
        } else {
          c.messages.push({id:`${turn.id}:final`,role:'assistant',text:result.response,at:now(),turnId:turn.id,requestId:turn.requestId,model:c.model,effort:c.effort,phase:'final_answer',...(turn.internal?{internal:turn.internal}:{})});
        }
      }
      // Native counters are cumulative over the session; compute turn delta separately without Codex cache conversion.
      const usage=result.usage;
      if(usage&&['input_tokens','output_tokens','cache_read_tokens','thinking_tokens'].every(k=>Number.isFinite(usage[k])&&usage[k]>=0)) {
        const normalized={...usage,total_tokens:Number.isFinite(usage.total_tokens)&&usage.total_tokens>=0?usage.total_tokens:usage.input_tokens+usage.output_tokens};
        turn.nativeUsage=normalized;
        turn.nativeTurnUsage=nativeTurnUsage(normalized,turn.nativeUsageBaseline);
        c.nativeUsage=normalized;
      }
      this.changed();
    }
  }

  #kill(child,signal='SIGTERM') { if(!child?.pid)return;try {process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;} }
  async #retire() {
    const session=this.session;if(!session)return;
    if(this.session===session)this.session=null;
    session.retiring=true;
    session.child.stdin.end();
    const timer=setTimeout(()=>this.#kill(session.child),1000);
    const force=setTimeout(()=>this.#kill(session.child,'SIGKILL'),2500);
    await session.closed;clearTimeout(timer);clearTimeout(force);
  }
  async interrupt(id) {
    const c=this.conversation(id), session=this.session;
    const turn=c.turns.at(-1);
    if(active.has(c.status)&&turn?.delivery==='preparing'){
      turn.cancelRequested=true;turn.status=c.status='interrupted';turn.completedAt=now();c.turnId=null;
      this.changed();await this.persist();return {requested:true};
    }
    if(!active.has(c.status)||session?.conversation!==c)throw new Error('Não há uma tarefa do Antigravity ativa.');
    session.stopping=true;this.#kill(session.child,'SIGINT');
    session.stopTimer=setTimeout(()=>this.#kill(session.child,'SIGKILL'),3000);
    return {requested:true};
  }
  async steer() { throw new Error('O protocolo stream-json do agy não suporta orientar um turno ativo. Aguarda o resultado ou usa Parar.'); }
  respond() { throw new Error('O agy em modo headless usa as permissões nativas; autorizações interativas não são suportadas por este protocolo.'); }
  async close() {
    if(this.catalogProcess)this.#kill(this.catalogProcess);
    if(this.session)await this.#retire();
    clearTimeout(this.changeTimer);clearTimeout(this.saveTimer);await this.persist();
  }
}
