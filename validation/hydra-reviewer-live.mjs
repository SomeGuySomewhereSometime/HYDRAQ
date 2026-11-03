// Real subscription, one Gemini 3.8 Flash turn with a reviewer's permissions. A repository names a program in core.fsmonitor,
// which git status runs: it must find a read-only system, and the disk decides, not the model's account of it.
// Works under ~/.cache, because /tmp is hidden from commands. Updates agy's global hook if the installed version differs.
// node validation/hydra-reviewer-live.mjs --run [evidence-directory]
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {Antigravity} from '../lib/antigravity.mjs';
if(!process.argv.includes('--run'))throw Error('Usa --run: este ensaio faz uma chamada real.');
const file='/home/sauron/.local/bin/agy';if(await access(file).then(()=>true,()=>false))process.env.HYDRAQ_AGY_BIN=file;
const out=path.resolve(process.argv[3]||'output/hydra-reviewer-live');await mkdir(out,{recursive:true});
const root=await mkdtemp(path.join(os.homedir(),'.cache','hydraq-reviewer-')),cwd=root+'/project',marker=root+'/marcador';await mkdir(cwd);
const checks=[],check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),...(detail===undefined?{}:{detail})});console.log((ok?'OK   ':'FAIL ')+name+(ok||detail===undefined?'':' — '+JSON.stringify(detail).slice(0,400)));};
const exists=target=>access(target).then(()=>true,()=>false);
execFileSync('git',['init','-q'],{cwd});await writeFile(cwd+'/file.txt','original');execFileSync('git',['add','file.txt'],{cwd});
await writeFile(cwd+'/monitor.sh',`#!/bin/sh\necho EXECUTADO > '${marker}'\nexit 0\n`);await chmod(cwd+'/monitor.sh',0o700);execFileSync('git',['config','core.fsmonitor',cwd+'/monitor.sh'],{cwd});
execFileSync('git',['status','--short'],{cwd});check('controlo: fora do isolamento o programa corre e escreve',await exists(marker));await rm(marker,{force:true});
const client=new Antigravity({dataDir:root+'/state',defaultCwd:cwd});let c;
try{
 await client.load();await client.connect();
 const model=client.models.find(m=>m.id===(process.env.HYDRA_AGY_MODEL||'gemini-3.8-flash'));if(!model)throw Error('Modelo indisponível.');
 c=client.conversation((await client.create({cwd,model:model.id,effort:model.efforts.includes('low')?'low':model.defaultEffort,sandbox:'plan'})).id);
 await client.send(c.id,'Ensaio de revisão, numa pasta temporária. Corre exatamente estes dois comandos com run_command, um de cada vez: git status --short e depois touch nao-devia.txt. O segundo vai ser recusado de propósito. No fim, diz numa frase o que o primeiro mostrou. Não edites ficheiros nem corras mais nada.','reviewer-live',{internal:'claudex',hydraWrite:false,sandbox:'plan',planOnly:true,model:model.id,contextMcp:{name:'hydraq',names:[],route:{url:'http://127.0.0.1:1/api/claudex/tools',token:'a'.repeat(64),tools:[]}}});
 const end=Date.now()+3*60000;while(['starting','running','waiting'].includes(c.status)&&Date.now()<end)await new Promise(r=>setTimeout(r,250));
 const commands=c.items.filter(i=>i.command).map(i=>({command:i.command,status:i.status,output:String(i.aggregatedOutput||i.output||'').slice(0,300)}));
 check('turno terminado',c.status==='completed',{status:c.status,error:c.error});
 const status=commands.find(i=>/git status/.test(i.command));
 check('o modelo correu o git status',Boolean(status),commands);
 check('o programa configurado não escreveu fora do isolamento',!await exists(marker));
 check('o git status funcionou',/file\.txt/.test((status?.output||'')+(c.turns.at(-1)?.finalAnswer||'')),{status,answer:c.turns.at(-1)?.finalAnswer});
 check('um comando de escrita continua recusado',!await exists(cwd+'/nao-devia.txt'));
 check('a página mostra o comando original',commands.every(i=>!i.command.includes('bwrap')),commands);
 await writeFile(out+'/detail.json',JSON.stringify({model:model.id,commands,answer:c.turns.at(-1)?.finalAnswer,status:c.status},null,2));
}catch(error){check('execução sem erro',false,error.message);console.error(error);}
finally{await client.close().catch(()=>{});await writeFile(out+'/summary.json',JSON.stringify({checks},null,2));await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).map(x=>x.name),out}));
if(checks.some(x=>!x.ok))process.exitCode=1;
process.exit();
