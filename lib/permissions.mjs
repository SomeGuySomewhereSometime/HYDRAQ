import {mkdir, mkdtemp, readFile, readdir, realpath, stat, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {inspectProject, compareProjects} from './project-state.mjs';
import {hardLinkedFiles, reservedState, reservedChanges} from './hydra-validation.mjs';
import {commandSandboxProblem} from './command-sandbox.mjs';

const policySources=['permissions','providers','http','command-sandbox','hydraq','codex','claude','antigravity','antigravity-guard','claudex','opinions','opinion-clients','followups','hydra-validation'];
export const permissionSource=createHash('sha256').update((await Promise.all(policySources.map(async name=>name+'\0'+await readFile(new URL('./'+name+'.mjs',import.meta.url),'utf8')))).join('\0')).digest('hex');
async function executableFingerprint(client){
 const executable=client.client?.executable||client.executable;
 if(!executable)return null;
 const names=path.isAbsolute(executable)?[executable]:(client.env?.PATH||process.env.PATH||'').split(path.delimiter).map(folder=>path.join(folder,executable));
 for(const file of names)try{
   const actual=await realpath(file),info=await stat(actual);
   return createHash('sha256').update(actual+'\0'+info.size+'\0'+info.mtimeMs).digest('hex');
 }catch{}
 return null;
}
export const PERMISSION_PROFILES = ['read-only', 'project', 'native'];
export const PERMISSION_ROUTES = ['normal', 'multi', 'hydra', 'delegation', 'resume', 'switch','restart'];
export const PROFILE_NAMES = {'read-only':'Só leitura', project:'Projeto confinado', native:'Nativo'};

export function permissionPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Escolhe um perfil de permissões.');
  if (Object.keys(value).some(key => !['profile','network','externalMcp','plan'].includes(key))) throw Error('Definições de permissões desconhecidas.');
  if (!PERMISSION_PROFILES.includes(value.profile)) throw Error('Perfil de permissões inválido.');
  for (const key of ['network','externalMcp','plan']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw Error('Definição de permissões inválida: '+key);
  return {profile:value.profile, network:value.network===true, externalMcp:value.externalMcp===true, plan:value.plan===true};
}
export function turnPermissions(settings) {
  if(!settings.permissionPolicy)return {};
  return {permissionPolicy:settings.permissionPolicy,permissionRequested:settings.permissionRequested||settings.permissionPolicy,
    permissionRoute:settings.permissionRoute||'normal',
    ...(settings.permissionPolicy.profile!=='native'?{permissionAudit:{status:'pending'}}:{})};
}
export function permissionSupport(provider, policy) {
  if (policy.profile === 'native') return null;
  if (!['codex','claude','antigravity'].includes(provider)) return 'O '+provider+' usa permissões nativas. Escolhe Nativo ou uma ronda mista.';
  return null;
}
export function permissionSandbox(provider, policy, fallback) {
  if (policy.profile === 'native') return policy.plan && provider !== 'codex' ? 'plan' : fallback;
  if (policy.profile === 'read-only') return provider === 'codex' ? 'read-only' : provider === 'claude' && !policy.plan ? 'workspace-write' : 'plan';
  return policy.plan && provider !== 'codex' ? 'plan' : 'workspace-write';
}
export function inheritedPermissions(parent, {allowWrite=false}={}) {
  if (!parent || parent.profile === 'native') return undefined;
  return {...permissionPolicy(parent), profile:allowWrite ? parent.profile : 'read-only', plan:true};
}
export function permissionLabel(policy) {
  return PROFILE_NAMES[policy.profile] + (policy.profile === 'native' ? '' : (policy.network?' + rede':' · sem rede')+(policy.externalMcp?' + MCP externos':' · sem MCP externos'));
}
export async function reservedFolders(cwd) {
  const found = [];
  const visit = async relative => {
    for (const entry of await readdir(path.join(cwd,relative),{withFileTypes:true})) {
      const file=path.join(relative,entry.name);
      if (['.git','.hydraq'].includes(entry.name)) {found.push(file);continue;}
      if (entry.isDirectory()) await visit(file);
    }
  };
  await visit('');
  return found;
}

/** Policy is attached to a request. Native session defaults and model text never grant a wider profile. */
export class Permissions {
  constructor(hub, directory) {
    this.hub=hub;
    this.directory=directory;
    this.running=new Map();
    this.auditing=new Map();
    this.validation={};
    this.binaries={};
  }
  async load() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    this.binaries=Object.fromEntries(await Promise.all(Object.entries(this.hub.clients).map(async([provider,client])=>[provider,await executableFingerprint(client)])));
    try {this.validation=JSON.parse(await readFile(path.join(this.directory,'validation.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')this.validationError='Não foi possível ler a validação das permissões.';}
    for (const c of this.hub.conversations()) {
      for (const turn of c.turns||[]) if (turn.permissionAudit?.status==='pending') {
        c.status=turn.status='uncertain';
        c.error='A auditoria do turno protegido foi interrompida. Revê o projeto antes de continuar.';
        turn.permissionAudit={status:'interrupted',reason:c.error};
        await this.owner(c).persist();
      }
    }
  }
  owner(c) {return [...Object.values(this.hub.clients),...[...(this.hub.opinions?.runtimes?.values()||[])].map(r=>r.client)].find(client=>client.conversations.includes(c));}
  snapshot() {
    return {profiles:PERMISSION_PROFILES.map(id=>({id,name:PROFILE_NAMES[id]})),routes:PERMISSION_ROUTES,
      clients:Object.fromEntries(Object.keys(this.hub.clients).map(id=>{
        const evidence=this.validation.source===permissionSource&&this.validation.binaries?.[id]===this.binaries[id]?this.validation.clients?.[id]:null;
        return [id,{profiles:['native',...(['codex','claude','antigravity'].includes(id)?['read-only','project']:[])],
          validation:PERMISSION_ROUTES.flatMap(route=>['read-only','project'].map(profile=>{
            const result=evidence?.results?.find(result=>result.route===route&&result.profile===profile&&result.status==='passed');
            return {route,profile,status:result?'tested':'unverified',...(result?{checks:result.checks}:{}),guaranteed:false};
          }))}];
      })),validationError:this.validationError||null};
  }
  async prepare(provider,c,settings,route='normal',{mixed=false}={}) {
    if (settings.permissionPolicy===undefined) return settings;
    const requested=permissionPolicy(settings.permissionRequested||settings.permissionPolicy);
    const problem=permissionSupport(provider,requested);
    if (problem && !mixed && settings.permissionPolicy.profile!=='native') throw Error(problem);
    const effective=problem&&mixed?{profile:'native',network:false,externalMcp:false,plan:requested.plan}:permissionPolicy(settings.permissionPolicy);
    const owner=this.owner(c);if(owner)this.observe(owner);
    if (this.auditing.has(c.id)||this.running.has(c.id)) throw Error('Aguarda a auditoria do turno protegido anterior.');
    if (effective.profile!=='native') {
      if (!this.hub.clients[provider]?.snapshot().capabilities?.permissionProfiles?.includes(effective.profile)) {
        throw Error('Este cliente ainda não aplica o perfil '+PROFILE_NAMES[effective.profile]+'.');
      }
      if (effective.profile==='project') {
        const links=await hardLinkedFiles(c.cwd,{includeGenerated:true});
        if(links.length)throw Error('O projeto tem hard links para fora da pasta: '+links.slice(0,8).join(', '));
      }
      if(provider!=='codex') {
        const problem=await commandSandboxProblem(c.cwd,{policy:{network:effective.network,protectedPaths:await reservedFolders(c.cwd)}});
        if(problem)throw Error('O isolamento necessário para este perfil está indisponível: '+problem);
      }
    }
    return {...settings,permissionPolicy:effective,permissionRequested:requested,permissionRoute:route,
      sandbox:permissionSandbox(provider,effective,settings.sandbox??c.sandbox),
      ...(effective.profile!=='native'?{planOnly:effective.profile==='read-only'||effective.plan}:{}),
      ...(problem?{permissionFallback:problem}:{})};
  }
  async begin(c,requestId,settings) {
    const policy=settings.permissionPolicy;
    const existing=this.running.get(c.id);
    if(existing){
      if(existing.requestId!==requestId)throw Error('Aguarda a auditoria do turno anterior.');
      return {tmp:existing.tmp,protectedPaths:existing.protectedPaths,network:existing.policy.network};
    }
    if(!policy||policy.profile==='native')return null;
    const directory=await mkdtemp(path.join(this.directory,'turn-'));
    try {
      const tmp=path.join(directory,'tmp');await mkdir(tmp,{mode:0o700});
      const reserved=await reservedState(c.cwd,this.hub.projects.directory);
      const before=policy.profile==='read-only'?await inspectProject(c.cwd):null;
      if(before&&!before.complete)throw Error('A inspeção de Só leitura ficou incompleta: '+before.warnings.join(' '));
      const protectedPaths=await reservedFolders(c.cwd);
      const record={id:randomUUID(),conversationId:c.id,requestId,cwd:c.cwd,policy,tmp,protectedPaths,reserved,before};
      await writeFile(path.join(directory,'audit.json'),JSON.stringify(record),{mode:0o600});
      this.running.set(c.id,{...record,directory,client:this.owner(c)});
      return {tmp,protectedPaths,network:policy.network};
    } catch(error) {await rm(directory,{recursive:true,force:true});throw error;}
  }
  observe(client) {
    for (const c of client.conversations) {
      const record=this.running.get(c.id),turn=c.turns.findLast(t=>t.requestId===record?.requestId);
      if(!record||!turn||['starting','running','waiting'].includes(turn.status)||this.auditing.has(c.id))continue;
      const job=this.finish(client,c,turn,record).catch(error=>{
        turn.permissionAudit={status:'failed',reason:error.message};
        c.status=turn.status='uncertain';c.error='A auditoria do perfil falhou: '+error.message;client.changed();
        return client.persist();
      }).finally(()=>{this.running.delete(c.id);this.auditing.delete(c.id);this.hub.emit('state',this.hub.snapshot());});
      this.auditing.set(c.id,job);
    }
  }
  async finish(client,c,turn,record) {
    const changed=reservedChanges(record.reserved,await reservedState(c.cwd,this.hub.projects.directory));
    const after=record.before?await inspectProject(c.cwd):null;
    const project=after?compareProjects(record.before,after):null;
    const links=record.policy.profile==='project'?await hardLinkedFiles(c.cwd,{includeGenerated:true}):[];
    const violations=[...new Set([...changed,...(project?.changed||[]),...links])];
    turn.permissionAudit={status:violations.length?'violation':after&&!after.complete?'incomplete':'passed',paths:violations,
      ...(after?.warnings.length?{warnings:after.warnings}:{})};
    if(turn.permissionAudit.status!=='passed') {
      c.status=turn.status='uncertain';
      c.error=violations.length?'O turno protegido alterou caminhos fora do perfil: '+violations.slice(0,10).join(', ')+'. Revê o estado do projeto.':'A auditoria de Só leitura ficou incompleta. Revê o projeto.';
    }
    await client.persist();
    await rm(record.directory,{recursive:true,force:true});
    client.changed();
  }
  async abandon(c) {
    const record=this.running.get(c.id);
    if(!record)return;
    const turn=c.turns.findLast(t=>t.requestId===record.requestId);
    if(turn){const client=this.owner(c);if(client)this.observe(client);return;}
    this.running.delete(c.id);
    await rm(record.directory,{recursive:true,force:true});
  }
  async close() {for(const record of this.running.values())if(record.client)this.observe(record.client);await Promise.allSettled([...this.auditing.values()]);}
}
