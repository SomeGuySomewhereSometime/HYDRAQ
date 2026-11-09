import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rename, chmod, realpath, stat } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {openCodePermissions,openCodePlanPermissions} from './opencode-permissions.mjs';

export const OPEN_CODE_TTL = 10 * 60_000;
/** Never infer free status from a model name or accept an unknown/missing price. */
export function parseOpenCodeModels(entries) {
  if (!Array.isArray(entries)) throw Error('Catálogo OpenCode inválido.');
  const seen=new Set();
  return entries.filter(m=>m?.providerID==='opencode' && m.enabled===true && ['active','beta','alpha'].includes(m.status) && typeof m.id==='string' && m.id && !m.id.includes('#') && Array.isArray(m.cost) && m.cost.length && m.cost.every(t=>t&&typeof t==='object'&&[t.input,t.output,t.cache?.read,t.cache?.write].every(n=>typeof n==='number' && n===0)))
    .filter(m=>!seen.has(m.id)&&seen.add(m.id)).map(m=>({id:`opencode/${m.id}`,name:m.name||m.id,providerID:'opencode',nativeId:m.id,free:true,cost:m.cost,efforts:['default',...new Set((m.variants||[]).map(v=>v?.id).filter(v=>typeof v==='string'&&v&&v!=='default'))],defaultEffort:'default',images:m.capabilities?.input?.includes('image')===true,contextWindow:m.limit?.context||null,isDefault:false,description:'OpenCode · gratuito no catálogo atual · conta/quota OpenCode.'})).sort((a,b)=>a.name.localeCompare(b.name));
}

/** Private native server and database. Neither transport uses the personal OpenCode environment. */
export class OpenCodeRuntime {
  #password; #starting; #manifestPromise;
  constructor({directory,executable,env=process.env,args=[],minimumSettleMs=2000,settleMs=20000,manifest=true}) {Object.assign(this,{directory:path.resolve(directory),executable,env,args});this.children=new Set();this.cache=new Map();this.pending=new Map();this.manifestEnabled=manifest;this.minimumSettleMs=minimumSettleMs;this.settleMs=settleMs;this.#password=randomBytes(32).toString('hex');}
  async environment(scope,contextMcp) {
    const configHome=path.join(this.directory,'config',createHash('sha256').update(scope).digest('hex'));
    await mkdir(path.join(configHome,'opencode'),{recursive:true,mode:0o700});await mkdir(path.join(this.directory,'share'),{recursive:true,mode:0o700});await chmod(this.directory,0o700);
    const permissions=openCodePermissions(contextMcp);
    const config={update:'disable',share:'disabled',policies:[{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'opencode',effect:'allow'},{action:'tool.use',resource:'subagent:*',effect:'deny'}],permissions,agents:{plan:{permissions:openCodePlanPermissions()}}};
    await writeFile(path.join(configHome,'opencode','opencode.json'),JSON.stringify(config),{mode:0o600});
    const env={...this.env,XDG_CONFIG_HOME:configHome,XDG_CACHE_HOME:path.join(this.directory,'cache'),XDG_DATA_HOME:path.join(this.directory,'share'),OPENCODE_DB:path.join(this.directory,'native.db'),OPENCODE_SERVER_PASSWORD:this.#password,OPENCODE_DISABLE_FREE_MODELS:'0'};
    for(const k of Object.keys(env))if(/^(?:OPENCODE_API_KEY$|OPENCODE_CONFIG|OPENAI|ANTHROPIC|CURSOR_API|GEMINI|GOOGLE_API|XAI|GROK_API|NVIDIA|VERCEL|GROQ|AWS_|VERTEX)/.test(k))delete env[k];
    return env;
  }
  launch(args,env,cwd) {
    if(this.closing)throw Error('OpenCode está a encerrar.');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./opencode-process.mjs',import.meta.url)),String(process.pid),this.executable,...this.args,...args],{env,cwd,stdio:['pipe','pipe','pipe'],detached:true});
    this.children.add(child);child.once('close',()=>this.children.delete(child));return child;
  }
  async start() {
    if(this.closing)throw Error('OpenCode está a encerrar.');
    if(this.url&&this.child?.exitCode===null)return;
    if(this.#starting)return this.#starting;
    this.#starting=(async()=>{
      await mkdir(this.directory,{recursive:true,mode:0o700});await this.manifest();if(this.closing)throw Error('OpenCode está a encerrar.');const env=await this.environment('catalog');
      const child=this.child=this.launch(['serve','--hostname','127.0.0.1','--port','0'],env,this.directory);let text='';
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.kill(child);reject(Error('O catálogo OpenCode não confirmou o arranque.'));},30000);const done=(error)=>{clearTimeout(timer);child.stdout.off('data',data);error?reject(error):resolve();};const data=d=>{text=(text+d).slice(-8192);const url=text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(url){this.url=url;done();}};child.stdout.on('data',data);child.stderr.on('data',()=>{});child.once('error',()=>done(Error('Não foi possível executar OpenCode. Verifica HYDRAQ_OPENCODE_BIN.')));child.once('close',()=>{if(this.child===child)this.url=null;done(Error('O processo privado OpenCode terminou.'));});});
    })().finally(()=>this.#starting=null);return this.#starting;
  }
  async manifest(){
    if(!this.manifestEnabled)return null;
    if(this.manifestIds&&Date.now()-this.manifestAt<OPEN_CODE_TTL)return this.manifestIds;
    if(this.#manifestPromise)return this.#manifestPromise;
    this.#manifestPromise=this.fetchRegistry().finally(()=>this.#manifestPromise=null);return this.#manifestPromise;
  }
  async fetchRegistry(){
    const response=await fetch('https://opencode.ai/inference/v1/models',{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Não foi possível confirmar o catálogo atual do fornecedor OpenCode.');
    const j=await response.json();if(!Array.isArray(j.data)||!j.data.length||j.data.some(m=>typeof m.id!=='string'))throw Error('Índice de modelos OpenCode inválido.');
    const ids=new Set(j.data.map(m=>m.id));
    const registryResponse=await fetch('https://models.dev/api.json',{signal:AbortSignal.timeout(15000)});if(!registryResponse.ok)throw Error('Não foi possível atualizar os metadados OpenCode.');
    const registry=await registryResponse.json(),provider=registry.opencode;if(!provider?.models)throw Error('Metadados do fornecedor OpenCode indisponíveis.');
    const models=Object.fromEntries(Object.entries(provider.models).filter(([id,m])=>m.status!=='deprecated'&&m.cost?.input===0&&m.cost?.output===0));
    if(!Object.keys(models).length)throw Error('Não há preços gratuitos confirmados no catálogo atual OpenCode.');
    const contents=JSON.stringify({opencode:{...provider,models}}),digest=createHash('sha256').update(contents).digest('hex');
    const cacheDir=path.join(this.directory,'cache','opencode');await mkdir(cacheDir,{recursive:true,mode:0o700});const temp=path.join(cacheDir,'models.'+randomBytes(8).toString('hex')+'.tmp');await writeFile(temp,contents,{mode:0o600});await rename(temp,path.join(cacheDir,'models.json'));
    if(this.registryDigest&&this.registryDigest!==digest&&this.child){
      // Native execution and terminals share this server: a catalogue refresh must never kill a turn.
      if(this.executionActive)throw Error('O catálogo OpenCode mudou durante uma sessão ativa. Aguarda antes de atualizar.');
      const old=this.child;this.child=null;this.url=null;this.kill(old);
    }
    this.registryDigest=digest;this.registryIds=new Set(Object.keys(models));this.manifestIds=ids;this.manifestAt=Date.now();return ids;
  }
  async loadCache(){
    try{const saved=JSON.parse(await readFile(path.join(this.directory,'catalog.json'),'utf8'));if(saved.version!==1||!Array.isArray(saved.entries))return;for(const r of saved.entries.slice(-50))if(typeof r.cwd==='string'&&path.isAbsolute(r.cwd)&&Array.isArray(r.models)&&r.models.every(m=>m.providerID==='opencode'&&m.free===true))this.cache.set(r.cwd,{...r,error:'Catálogo guardado; a confirmar com OpenCode.',checkedAt:r.checkedAt||null});}catch(e){if(e.code!=='ENOENT')this.cacheError='O catálogo guardado não pôde ser lido; será verificado novamente.';}
  }
  async saveCache(){await mkdir(this.directory,{recursive:true,mode:0o700});const file=path.join(this.directory,'catalog.json'),temp=file+'.'+randomBytes(8).toString('hex')+'.tmp';await writeFile(temp,JSON.stringify({version:1,entries:[...this.cache.values()].slice(-50)}),{mode:0o600});await rename(temp,file);}
  async request(cwd) {
    await this.start();const url=new URL('/api/model',this.url);url.searchParams.set('location[directory]',cwd);
    const res=await fetch(url,{headers:{authorization:'Basic '+Buffer.from('opencode:'+this.#password).toString('base64')},signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw Error(`OpenCode não confirmou o catálogo (${res.status}).`);const j=await res.json();if(!Array.isArray(j.data))throw Error('Catálogo nativo sem modelos.');return j.data;
  }
  async api(route,{method='GET',body,signal,raw=false,start=true,beforeSend}={}) {
    if(start)await this.start();
    if(!this.url||this.child?.exitCode!==null)throw Error('O servidor privado OpenCode não está disponível. Nada foi reenviado.');
    if(beforeSend&&!beforeSend())throw Error('A preparação OpenCode foi interrompida. Nada foi enviado.');
    const response=await fetch(new URL(route,this.url),{method,headers:{authorization:'Basic '+Buffer.from('opencode:'+this.#password).toString('base64'),'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:signal||AbortSignal.timeout(15000)});
    if(!response.ok){const error=Error(`OpenCode não confirmou a operação (${response.status}). Nada foi reenviado.`);error.httpStatus=response.status;throw error;}
    if(raw)return response;
    return response.status===204?null:JSON.parse(this.redact(JSON.stringify(await response.json())));
  }
  redact(value){return String(value??'').split(this.#password).join('[CHAVE OCULTA]');}
  publicText(value,final=false){const text=this.redact(value);if(final)return text;let held=0;for(let n=1;n<this.#password.length&&n<=text.length;n++)if(text.endsWith(this.#password.slice(0,n)))held=n;return held?text.slice(0,-held):text;}
  async history(sessionId) {
    const messages=[],seen=new Map(),cursors=new Set();let cursor;
    do {
      const query=new URLSearchParams({limit:'100',...(cursor?{cursor}:{order:'asc'})});
      const page=await this.api('/api/session/'+encodeURIComponent(sessionId)+'/message?'+query);
      if(!Array.isArray(page?.data)||!page.cursor||!Object.hasOwn(page.cursor,'next')||!(page.cursor.next===null||typeof page.cursor.next==='string'&&page.cursor.next))throw Error('Histórico OpenCode incompleto: página ou cursor inválido.');
      for(const m of page.data){
        if(!m||typeof m.id!=='string'||!m.id||!Number.isFinite(m.time?.created)||typeof m.type!=='string')throw Error('Histórico OpenCode incompleto: mensagem inválida.');
        const prior=seen.get(m.id);if(prior){if(JSON.stringify(prior)!==JSON.stringify(m))throw Error('Histórico OpenCode mudou durante a paginação. Será consultado novamente.');continue;}
        seen.set(m.id,m);messages.push(m);
      }
      cursor=page.cursor.next;
      if(cursor){if(cursors.has(cursor))throw Error('Histórico OpenCode incompleto: cursor repetido.');cursors.add(cursor);}
    }while(cursor);
    return messages;
  }
  async terminalEnvironment(){return this.environment('catalog');}
  /** Admission only: the ACP runner owns execution; never wake a second runner here. */
  async sessionRequest(sessionId, suffix, {method='GET',body,beforeSend}={}) {
    if(!this.url||this.child?.exitCode!==null)throw Error('O servidor privado OpenCode não está disponível. Nada foi reenviado.');
    const url=new URL('/api/session/'+encodeURIComponent(sessionId)+suffix,this.url);
    if(beforeSend&&!beforeSend())throw Error('Esse turno já terminou. A orientação não iniciou outro pedido.');
    const response=await fetch(url,{method,headers:{authorization:'Basic '+Buffer.from('opencode:'+this.#password).toString('base64'),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(!response.ok){const error=Error(`OpenCode não confirmou a orientação (${response.status}). Nada foi reenviado.`);error.httpStatus=response.status;throw error;}
    return response.status===204?null:(await response.json()).data;
  }
  async admitSteer(sessionId,message,beforeSend) {
    const result=await this.sessionRequest(sessionId,'/prompt',{method:'POST',body:{id:message.nativeInputId,text:message.text,delivery:'steer',resume:false},beforeSend});
    if(result?.id!==message.nativeInputId||result.sessionID!==sessionId||result.type!=='user'||result.delivery!=='steer')throw Error('O recibo de orientação OpenCode não corresponde à mensagem. Nada foi reenviado.');
    return result;
  }
  async settleSteer(sessionId,message) {
    // Cancel is a no-op for projected messages. Checking afterwards distinguishes delivered from merely enqueued.
    await this.sessionRequest(sessionId,'/inbox/'+encodeURIComponent(message.nativeInputId),{method:'DELETE'});
    let result;
    try{result=await this.sessionRequest(sessionId,'/message/'+encodeURIComponent(message.nativeInputId));}
    catch(error){if(error.httpStatus===404)return false;throw error;}
    if(result?.id!==message.nativeInputId||result.type!=='user'||result.text!==message.text)throw Error('O histórico nativo não confirmou esta orientação.');
    return true;
  }
  async refresh(cwd,{force=false}={}) {
    cwd=await realpath(cwd);if(!(await stat(cwd)).isDirectory())throw Error('A pasta OpenCode não existe.');
    const old=this.cache.get(cwd);if(!force&&old?.checkedAt&&Date.now()-Date.parse(old.checkedAt)<OPEN_CODE_TTL&&!old.error&&!old.stale)return old;
    if(this.pending.has(cwd))return this.pending.get(cwd);
    const work=(async()=>{
      try {
        if(force)this.manifestAt=0;const manifest=await this.manifest();let models=[],entries,lastSignature,stable=false;const started=Date.now(),deadline=started+this.settleMs;
        do{entries=await this.request(cwd);models=parseOpenCodeModels(this.registryIds?entries.filter(m=>m.providerID==='opencode'&&this.registryIds.has(m.id)):entries);const signature=JSON.stringify(models);stable=models.length>0&&(!this.registryIds||models.every(m=>this.registryIds.has(m.nativeId)))&&signature===lastSignature&&Date.now()-started>=(old?0:this.minimumSettleMs);lastSignature=signature;if(stable)break;await new Promise(r=>setTimeout(r,350));}while(Date.now()<deadline);
        if(!stable)throw Error('O catálogo OpenCode ainda não estabilizou; a lista anterior foi conservada.');
        // Empty initial/plugin snapshots must not erase a previously usable catalogue.
        if(!models.length)throw Error('OpenCode ainda não disponibilizou modelos gratuitos nesta pasta.');
        const record={cwd,models,checkedAt:new Date().toISOString(),error:null,source:'OpenCode privado · apenas gratuitos'};this.cache.set(cwd,record);await this.saveCache();return record;
      }catch(e){const record={...(old||{cwd,models:[]}),error:e.message,attemptedAt:new Date().toISOString()};this.cache.set(cwd,record);throw e;}
    })().finally(()=>this.pending.delete(cwd));this.pending.set(cwd,work);return work;
  }
  kill(child){if(child?.pid)try{process.kill(-child.pid,'SIGTERM')}catch{}}
  reopen() { this.closing = false; }
  async close() {
    this.closing = true;
    await Promise.all([...this.children].map(child => new Promise((resolve, reject) => {
      const closed = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
      const deadline = setTimeout(() => {
        child.off('close', closed);
        reject(Error('O processo privado do OpenCode não confirmou o encerramento.'));
      }, 3500);
      child.once('close', closed);
      this.kill(child);
    })));
  }
}
