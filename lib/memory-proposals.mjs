import { mkdir,lstat,readFile,writeFile,rename,unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Durable jobs, separate from curated memory. Reloading never starts another inference.
export class MemoryProposals {
  constructor(directory){this.directory=directory;this.cache=new Map();this.queues=new Map();}
  async read(projectId){
    if(!/^[a-f0-9-]{36}$/.test(projectId))throw Error('Projeto inválido.');
    if(this.cache.has(projectId))return this.cache.get(projectId);
    const file=path.join(this.directory,projectId+'.json');let raw=null,data={version:1,projectId,records:[]};
    try{
      const dir=await lstat(this.directory),info=await lstat(file);if(dir.isSymbolicLink()||!dir.isDirectory()||info.isSymbolicLink()||!info.isFile()||info.size>2_000_000)throw Error('Arquivo inválido.');
      raw=await readFile(file,'utf8');data=JSON.parse(raw);
      if(data.version!==1||data.projectId!==projectId||!Array.isArray(data.records)||data.records.some(r=>!r.id||!['running','ready','failed','uncertain'].includes(r.status)||typeof r.requestId!=='string'||typeof r.conversationId!=='string'||typeof r.text!=='string'||r.text.length>2500||!Array.isArray(r.sources)||!Array.isArray(r.warnings)))throw Error('Formato inválido.');
    }catch(e){if(e.code!=='ENOENT')throw Error('As propostas guardadas estão inválidas; o original foi preservado. '+e.message);}
    const state={data,raw};this.cache.set(projectId,state);return state;
  }
  async change(projectId,operation){
    const job=(this.queues.get(projectId)||Promise.resolve()).then(async()=>{
      const previous=await this.read(projectId),data=structuredClone(previous.data),value=await operation(data.records);
      const raw=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(raw)>2_000_000)throw Error('O arquivo de propostas atingiu o limite; nada foi substituído.');
      await mkdir(this.directory,{recursive:true,mode:0o700});const dir=await lstat(this.directory);if(dir.isSymbolicLink()||!dir.isDirectory())throw Error('Pasta de propostas inválida.');
      const file=path.join(this.directory,projectId+'.json'),temp=file+'.'+randomUUID()+'.tmp';let disk=null;
      try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile())throw Error('Arquivo de propostas inválido.');disk=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(disk!==previous.raw)throw Error('As propostas mudaram no disco; reinicia o HYDRAQ para as reler.');
      try{if(disk!==null){await writeFile(temp+'.previous',disk,{flag:'wx',mode:0o600});await rename(temp+'.previous',file+'.previous');}await writeFile(temp,raw,{flag:'wx',mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});await unlink(temp+'.previous').catch(()=>{});}
      this.cache.set(projectId,{data,raw});return structuredClone(value);
    });this.queues.set(projectId,job.catch(()=>{}));return job;
  }
  async create(projectId,record){return this.change(projectId,records=>{if(records.some(r=>r.status==='running'))throw Error('Já existe uma proposta em curso neste projeto.');if(records.length>=100)throw Error('O arquivo de propostas atingiu o limite de 100; nenhuma inferência foi iniciada.');records.push(record);return record;});}
  async update(projectId,id,changes){return this.change(projectId,records=>{const record=records.find(r=>r.id===id);if(!record)throw Error('Proposta não encontrada.');Object.assign(record,changes);return record;});}
  async list(projectId,cursor=0){if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('Cursor inválido.');const {data}=await this.read(projectId),sorted=[...data.records].reverse();return {records:structuredClone(sorted.slice(cursor,cursor+10)),total:sorted.length,nextCursor:cursor+10<sorted.length?cursor+10:null};}
  async recover(projectId,conversations,answer){
    const {data}=await this.read(projectId);if(!data.records.some(r=>r.status==='running'))return;
    await this.change(projectId,records=>{for(const record of records.filter(r=>r.status==='running')){
      const c=conversations.find(c=>c.id===record.conversationId),turn=c?.turns.find(t=>t.requestId===record.requestId),text=turn?answer(c,record.requestId).trim():'';
      const complete=turn?.status==='completed'&&text&&text.length<=2500;
      Object.assign(record,{status:complete?'ready':'uncertain',text:text.length<=2500?text:'',finishedAt:new Date().toISOString(),error:complete?null:'O HYDRAQ reiniciou sem confirmar a proposta. Nada foi reenviado.',warnings:[...record.warnings,'A verificação após a proposta não foi concluída antes do reinício. Revê o projeto antes de usar o texto.']});
    }});
  }
  async close(){await Promise.all([...this.queues.values()]);}
}
