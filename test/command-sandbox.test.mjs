import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link,access,chmod} from 'node:fs/promises';
import {createServer} from 'node:http';
import net from 'node:net';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {confinedCommand,writablePath,commandSandboxProblem,shellQuote,toolFolders} from '../lib/command-sandbox.mjs';
import {decide,hydraPolicy,readOnlyPolicy,guardCommand,openGuard} from '../lib/antigravity-guard.mjs';
import {ClaudeCode} from '../lib/claude.mjs';
import {noBwrap} from './fixtures/sandbox.mjs';
import {Antigravity} from '../lib/antigravity.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exists=file=>access(file).then(()=>true,()=>false);
async function project(t){
 // Under the home folder's parent is not an option in tests: /tmp is hidden in the sandbox and the project is bound back.
 const base=await mkdtemp(path.join(os.tmpdir(),'hydraq-confine-')),cwd=path.join(base,'project'),outside=path.join(base,'outside');
 const closing=[];t.after(async()=>{for(const close of closing)await close();await rm(base,{recursive:true,force:true});});
 await mkdir(path.join(cwd,'.git','hooks'),{recursive:true});await mkdir(path.join(cwd,'.hydraq'));await mkdir(path.join(cwd,'sub'));await mkdir(outside);
 return {base,cwd,outside,closing};
}
const run=(command,cwd,{inDir=cwd,env=process.env}={})=>spawnSync('/usr/bin/bash',['-c',confinedCommand(command,cwd)],{cwd:inDir,encoding:'utf8',env});

test('com origem, os comandos veem a cópia também no caminho original, com as mesmas proteções',{skip:noBwrap},async t=>{
 const {cwd:copy,base,outside}=await project(t),origin=path.join(base,'original');
 await mkdir(origin+'/pk',{recursive:true});await writeFile(origin+'/a.txt','original');await writeFile(copy+'/a.txt','copia');await writeFile(copy+'/.git/config','antes');await mkdir(copy+'/pk');await symlink(origin+'/pk',copy+'/abs');
 const server=net.createServer(s=>s.end());await new Promise(r=>server.listen(origin+'/servico.sock',r));t.after(()=>new Promise(r=>server.close(r)));
 const confined=(command,write=true)=>spawnSync('/usr/bin/bash',['-c',confinedCommand(command,copy,write,[],origin)],{cwd:copy,encoding:'utf8'});
 let r=confined(`cat ${shellQuote(origin+'/a.txt')}; printf novo > ${shellQuote(origin+'/b.txt')}; printf link > abs/f.txt`);assert.equal(r.stdout,'copia',r.stderr);assert.equal(r.status,0,r.stderr);
 assert.equal(await readFile(copy+'/b.txt','utf8'),'novo');assert.equal(await readFile(copy+'/pk/f.txt','utf8'),'link');assert.equal(await exists(origin+'/b.txt'),false);assert.equal(await exists(origin+'/pk/f.txt'),false);assert.equal(await readFile(origin+'/a.txt','utf8'),'original');
 for(const target of [origin+'/.git/config',origin+'/.git/hooks/h',origin+'/.hydraq/s']){r=confined(`touch ${shellQuote(target)}`);assert.notEqual(r.status,0,target);}
 assert.equal(await readFile(copy+'/.git/config','utf8'),'antes');assert.equal(await exists(copy+'/.git/hooks/h'),false);
 r=confined(`node -e "require('net').connect('${origin}/servico.sock',()=>{console.log('LIGOU');process.exit()}).on('error',e=>console.log(e.code))"`);assert.match(r.stdout,/ENOENT/,r.stdout+r.stderr);
 r=confined(`touch ${shellQuote(origin+'/ler.txt')}`,false);assert.notEqual(r.status,0,'em leitura, nenhum dos dois caminhos escreve');assert.equal(await exists(copy+'/ler.txt'),false);
});

test('comando confinado escreve no projeto e em mais lado nenhum',{skip:noBwrap},async t=>{
 const {cwd,base}=await project(t);
 const home=await mkdtemp(path.join(os.homedir(),'.hydraq-confine-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const ok=run('touch dentro.txt',cwd);assert.equal(ok.status,0,ok.stderr);assert.ok(await exists(cwd+'/dentro.txt'));
 for(const [target,label] of [[home+'/fora.txt','home'],[cwd+'/.git/hooks/pre-commit','.git/hooks'],[cwd+'/.git/config','.git'],[cwd+'/.hydraq/state','.hydraq'],['/usr/fora.txt','sistema']]){
  const r=run(`touch ${shellQuote(target)}`,cwd);assert.notEqual(r.status,0,label);assert.equal(await exists(target),false,label);
 }
 // /tmp is private: the file is created inside and never reaches the real /tmp.
 const shared=path.join(base,'partilhado');assert.equal(run(`touch ${shellQuote(shared)}; true`,cwd).status,0);assert.equal(await exists(shared),false);
 const tmp=run('touch /tmp/hydraq-confine-privado && test -f /tmp/hydraq-confine-privado',cwd);assert.equal(tmp.status,0,tmp.stderr);assert.equal(await exists('/tmp/hydraq-confine-privado'),false);
});

test('comando confinado não tem rede nem os sockets da sessão',{skip:noBwrap},async t=>{
 const {cwd}=await project(t),server=createServer((q,s)=>s.end('ok'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const connect=`require('net').connect(${server.address().port},'127.0.0.1').on('connect',()=>{console.log('LIGOU');process.exit(0)}).on('error',e=>{console.log('ERRO',e.code);process.exit(1)})`;
 const free=await new Promise(resolve=>{let out='';const child=spawn(process.execPath,['-e',connect]);child.stdout.on('data',d=>out+=d);child.on('close',()=>resolve(out));});assert.match(free,/LIGOU/,'fora do isolamento o mesmo comando liga');
 const closed=run(`${shellQuote(process.execPath)} -e ${shellQuote(connect)}`,cwd);assert.notEqual(closed.status,0);assert.match(closed.stdout,/ERRO E[A-Z]+/);assert.doesNotMatch(closed.stdout,/LIGOU/);
 assert.equal(run('test -z "$(ls -A /run)"',cwd).status,0,'/run vazio');
 assert.equal(run('test "$TMPDIR" = /tmp',cwd,{env:{...process.env,TMPDIR:'/var/tmp/elsewhere'}}).status,0);
 if(spawnSync('sh',['-c','command -v systemd-run']).status===0){
  const marker=path.join(cwd,'..','fora-systemd');
  run(`systemd-run --user --collect --wait --quiet touch ${shellQuote(marker)}`,cwd);assert.equal(await exists(marker),false);
 }
});

test('comando confinado preserva o texto e a subpasta escolhida',{skip:noBwrap},async t=>{
 const {cwd}=await project(t);
 const text=`a'b "c" $HOME \`d\`\nlinha2`;
 const r=run(`printf '%s' ${shellQuote(text)} > saida.txt`,cwd);assert.equal(r.status,0,r.stderr);assert.equal(await readFile(cwd+'/saida.txt','utf8'),text);
 assert.equal(run('pwd > aqui.txt',cwd,{inDir:cwd+'/sub'}).status,0);assert.equal((await readFile(cwd+'/sub/aqui.txt','utf8')).trim(),cwd+'/sub');
 assert.equal(run('exit 7',cwd).status,7,'código de saída do comando');
});

test('uma pasta sem .git nem .hydraq também funciona',{skip:noBwrap},async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'hydraq-confine-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const r=run('touch ok.txt',base);assert.equal(r.status,0,r.stderr);assert.ok(await exists(base+'/ok.txt'));
 assert.equal(await commandSandboxProblem(base),null);
});

test('verificação prévia explica porque não dá para confinar',{skip:noBwrap},async t=>{
 const {cwd}=await project(t),missing=path.join(cwd,'não-existe');
 const problem=await commandSandboxProblem(cwd).then(()=>commandSandboxProblem(missing).catch(e=>e.message));
 assert.equal(typeof problem,'string');assert.ok(problem.length>0);
});

test('caminhos de escrita: dentro do projeto, com ligações resolvidas e fora de .git e .hydraq',async t=>{
 const {cwd,outside}=await project(t);
 await symlink(outside,cwd+'/saida');await symlink(outside+'/ainda-nao-existe',cwd+'/pendente');await symlink(cwd+'/sub',cwd+'/atalho');await symlink(cwd+'/.git',cwd+'/git-escondido');await writeFile(outside+'/real.txt','x');await symlink(outside+'/real.txt',cwd+'/ficheiro');
 for(const inside of ['a.txt',cwd+'/a.txt',cwd+'/sub/novo/a.txt','sub/b.txt',cwd+'/atalho/c.txt','.gitignore','.github/x.yml','.env'])assert.equal(writablePath(inside,cwd),true,inside);
 for(const out of [outside+'/a.txt',cwd+'/saida/a.txt',cwd+'/saida/novo/a.txt','saida/a.txt',cwd+'/pendente',cwd+'/ficheiro','../fora.txt',cwd+'/sub/../../fora.txt','/etc/passwd',cwd,cwd+'/.git/hooks/pre-commit',cwd+'/.git/config','.git/config',cwd+'/sub/.git/config',cwd+'/.hydraq/state',cwd+'/git-escondido/config','',null,undefined,42])assert.equal(writablePath(out,cwd),false,String(out));
 assert.equal(writablePath('a.txt',''),false);assert.equal(writablePath('a.txt',null),false);
});

test('hook do principal: comandos confinados, ferramentas de ficheiros só dentro do projeto',async t=>{
 const {cwd,outside}=await project(t),policy=hydraPolicy(['read_dialogue'],{write:true,cwd}),call=(name,args)=>decide({toolCall:{name,args},artifactDirectoryPath:outside+'/artefactos'},policy);
 const command=call('run_command',{CommandLine:'touch a.txt',Cwd:cwd});
 assert.equal(command.decision,'allow');assert.match(command.overwrite.CommandLine,/^'\/usr\/bin\/bwrap'/);assert.deepEqual(Object.keys(command.overwrite),['CommandLine']);
 assert.equal(call('run_command',{}).decision,'deny');
 for(const name of ['write_file','write_to_file','replace_file_content','multi_replace_file_content','edit_file'])for(const key of ['Path','TargetFile']){
  assert.equal(call(name,{[key]:cwd+'/a.txt'}).decision,'ask',name);
  assert.equal(call(name,{[key]:cwd+'/.git/hooks/pre-commit'}).decision,'deny',name);
  assert.equal(call(name,{[key]:outside+'/a.txt'}).decision,'deny',name);
 }
 assert.equal(call('edit_file',{Path:outside+'/artefactos/plano.md'}).decision,'ask','notas do próprio agy');
 assert.equal(call('invoke_subagent',{}).decision,'deny');
 // A reviewer stays read-only, also for the file tool the hook did not know.
 const reader=(name,args)=>decide({toolCall:{name,args}},hydraPolicy(['read_dialogue'])).decision;
 assert.equal(reader('edit_file',{Path:cwd+'/a.txt'}),'deny');assert.equal(reader('run_command',{CommandLine:'touch a.txt'}),'deny');assert.equal(reader('run_command',{CommandLine:'ls'}),'allow');
 assert.equal(decide({toolCall:{name:'edit_file',args:{Path:cwd+'/a.txt'}}},readOnlyPolicy()).decision,'deny');
});

test('programa real do hook confina um comando e resolve ligações',{skip:noBwrap},async t=>{
 const {base,cwd,outside}=await project(t),directory=path.join(base,'guard');await mkdir(directory);
 await openGuard(directory,'conv-1234',hydraPolicy(['read_dialogue'],{write:true,cwd}));await symlink(outside,cwd+'/saida');
 const hook=(name,args)=>JSON.parse(execFileSync('sh',['-c',guardCommand({directory})],{input:JSON.stringify({conversationId:'conv-1234',stepIdx:1,toolCall:{name,args}})}).toString());
 const answer=hook('run_command',{CommandLine:`touch dentro.txt ${shellQuote(outside+'/fora.txt')}; true`});
 assert.equal(answer.decision,'allow');
 spawnSync('/usr/bin/bash',['-c',answer.overwrite.CommandLine],{cwd});
 assert.ok(await exists(cwd+'/dentro.txt'));assert.equal(await exists(outside+'/fora.txt'),false);
 assert.equal(hook('edit_file',{Path:cwd+'/saida/x.txt'}).decision,'deny');assert.equal(hook('write_to_file',{TargetFile:cwd+'/x.txt'}).decision,'ask');
});

async function claude(t){
 const {cwd,outside,base,closing}=await project(t),log=path.join(base,'tools.log'),args=path.join(base,'args.json');
 const client=new ClaudeCode({dataDir:path.join(base,'state'),defaultCwd:cwd,executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-claude.mjs')],env:{...process.env,FAKE_CLAUDE_TOOL_LOG:log,FAKE_CLAUDE_ARGS_LOG:args}});
 closing.push(()=>client.close());await client.load();await client.connect();const c=await client.create({model:'haiku',effort:'low',sandbox:'workspace-write',cwd});
 const tool=async(name,input,settings={internal:'claudex',hydraWrite:true,sandbox:'workspace-write'})=>{
  await client.send(c.id,'hydra-tool:'+JSON.stringify({name,input}),'req-'+Math.random(),settings);
  const end=Date.now()+5000;while(['starting','running','waiting'].includes(client.conversation(c.id).status)){if(Date.now()>end)throw Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}
  return JSON.parse((await readFile(log,'utf8')).trim().split('\n').at(-1));
 };
 return {client,c,cwd,outside,tool,args};
}

test('Claude principal: Bash passa pelo isolamento e a escrita fica no projeto',async t=>{
 const {cwd,outside,tool,args}=await claude(t);
 const bash=await tool('Bash',{command:'touch a.txt',description:'Criar'});
 assert.equal(bash.behavior,'allow');assert.match(bash.updatedInput.command,/^'\/usr\/bin\/bwrap'/);assert.match(bash.updatedInput.command,/touch a\.txt/);assert.equal(bash.updatedInput.description,'Criar');
 assert.deepEqual(JSON.parse(JSON.parse(await readFile(args,'utf8')).filter((v,i,all)=>all[i-1]==='--settings').at(-1)).permissions.ask,['Bash','Edit','Write']);
 const inside=await tool('Write',{file_path:cwd+'/a.txt',content:'x'});assert.equal(inside.behavior,'allow');assert.deepEqual(inside.updatedInput,{file_path:cwd+'/a.txt',content:'x'});
 assert.equal((await tool('Edit',{file_path:'sub/b.txt',old_string:'a',new_string:'b'})).behavior,'allow','relativo à pasta da conversa');
 for(const file_path of [outside+'/a.txt',cwd+'/.git/hooks/pre-commit',cwd+'/../fora.txt']){
  const denied=await tool('Write',{file_path,content:'x'});assert.equal(denied.behavior,'deny',file_path);assert.match(denied.message,/dentro do projeto/);
 }
});

test('Claude revisor continua sem Bash nem escrita',async t=>{
 const {cwd,tool}=await claude(t),review={internal:'claudex',hydraWrite:false,sandbox:'plan',planOnly:true};
 for(const [name,input] of [['Bash',{command:'ls'}],['Write',{file_path:cwd+'/a.txt',content:'x'}]])assert.equal((await tool(name,input,review)).behavior,'deny',name);
});

test('agy principal: o comando confinado não é tomado por violação da proteção',async t=>{
 const {base,cwd,closing}=await project(t),config=path.join(base,'agy-config');
 const client=new Antigravity({dataDir:path.join(base,'state'),defaultCwd:cwd,settingsFile:path.join(base,'settings.json'),executable:process.execPath,prefixArgs:[path.join(root,'test/fixtures/fake-agy.mjs')],env:{...process.env,FAKE_AGY_HOOKS:path.join(config,'hooks.json')},hooksFile:path.join(config,'hooks.json'),guardDirectory:path.join(base,'guard'),mcpFile:path.join(config,'mcp_config.json'),routeDirectory:path.join(base,'route')});
 closing.push(()=>client.close());await client.load();await client.connect();
 const c=await client.create({cwd,model:'gemini-4-argon',effort:'low',sandbox:'plan'});
 await client.send(c.id,'guard-principal','p1',{internal:'claudex',hydraWrite:true,sandbox:'workspace-write',contextMcp:{name:'hydraq',names:[],route:{url:'http://127.0.0.1:1/api/claudex/tools',token:'a'.repeat(64),tools:[]}}});
 const end=Date.now()+5000;while(['starting','running','waiting'].includes(c.status)){if(Date.now()>end)throw Error('Tempo excedido.');await new Promise(r=>setTimeout(r,10));}
 assert.equal(c.status,'completed',c.error);assert.match(c.turns.at(-1).finalAnswer,/run_command:ok edit_file:ok edit_file:recusada/);
 assert.ok(c.items.some(i=>i.command==='touch x.txt'),'a página mostra o comando original');
});

test('um hard link não dá escrita para fora: o principal não o cria e as ferramentas de ficheiros recusam-no',{skip:noBwrap},async t=>{
 const {base,cwd,outside}=await project(t),home=await mkdtemp(path.join(os.homedir(),'.hydraq-confine-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await writeFile(home+'/fora.txt','ORIGINAL');
 const made=run(`ln ${shellQuote(home+'/fora.txt')} ligacao.txt`,cwd);assert.notEqual(made.status,0,'de dentro do isolamento não dá para criar');assert.equal(await exists(cwd+'/ligacao.txt'),false);
 await writeFile(outside+'/real.txt','x');await link(outside+'/real.txt',cwd+'/alias.txt');
 assert.equal(writablePath(cwd+'/alias.txt',cwd),false);assert.equal(writablePath(cwd+'/novo.txt',cwd),true);
});

test('revisor do agy: cada comando corre só de leitura, e um programa configurado no repositório não escreve',{skip:noBwrap},async t=>{
 const home=await mkdtemp(path.join(os.homedir(),'.hydraq-confine-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const cwd=home+'/project',marker=home+'/marcador',directory=home+'/guard';await mkdir(cwd);await mkdir(directory);
 execFileSync('git',['init','-q'],{cwd});await writeFile(cwd+'/a.txt','1');execFileSync('git',['add','a.txt'],{cwd});
 await writeFile(cwd+'/monitor.sh',`#!/bin/sh\necho EXECUTADO > '${marker}'\nexit 0\n`);await chmod(cwd+'/monitor.sh',0o700);execFileSync('git',['config','core.fsmonitor',cwd+'/monitor.sh'],{cwd});
 execFileSync('git',['status','--short'],{cwd});assert.equal(await exists(marker),true,'controlo: fora do isolamento o programa corre e escreve');await rm(marker);
 for(const policy of [hydraPolicy(['read_dialogue'],{cwd}),readOnlyPolicy(cwd)]){
  await openGuard(directory,'conv-1234',policy);
  const hook=(name,args)=>JSON.parse(execFileSync('sh',['-c',guardCommand({directory})],{input:JSON.stringify({conversationId:'conv-1234',stepIdx:1,toolCall:{name,args}})}).toString());
  const answer=hook('run_command',{CommandLine:'git status --short',Cwd:cwd});assert.equal(answer.decision,'allow');assert.match(answer.overwrite.CommandLine,/^'\/usr\/bin\/bwrap'/);
  const seen=spawnSync('/usr/bin/bash',['-c',answer.overwrite.CommandLine],{cwd,encoding:'utf8'});assert.equal(seen.status,0,seen.stderr);assert.match(seen.stdout,/a\.txt/,'o git status continua a funcionar');assert.equal(await exists(marker),false);
  assert.equal(hook('run_command',{CommandLine:'touch x',Cwd:cwd}).decision,'deny','o filtro continua');
  const write=spawnSync('/usr/bin/bash',['-c',confinedCommand('touch escrito.txt',cwd,false)],{cwd});assert.notEqual(write.status,0);assert.equal(await exists(cwd+'/escrito.txt'),false);
 }
});

test('revisor do agy num projeto em /tmp continua a ver o projeto, e sem pasta conhecida também funciona',{skip:noBwrap},async t=>{
 const {cwd}=await project(t);await writeFile(cwd+'/a.txt','1');
 for(const inner of [confinedCommand('cat a.txt',cwd,false),confinedCommand('pwd',null,false)]){const r=spawnSync('/usr/bin/bash',['-c',inner],{cwd:inner.includes('pwd')?os.homedir():cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 assert.match(decide({toolCall:{name:'run_command',args:{CommandLine:'ls',Cwd:cwd}}},readOnlyPolicy()).overwrite.CommandLine,/--ro-bind-try/);
});

test('sockets Unix da home não são alcançáveis, nem em leitura; a home fica escondida e as ferramentas visíveis',{skip:noBwrap},async t=>{
 const home=await mkdtemp(path.join(os.homedir(),'.hydraq-confine-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const cwd=home+'/project',socket=home+'/s',got=[];await mkdir(cwd);await mkdir(cwd+'/.hydraq');await writeFile(cwd+'/.hydraq/state','SEGREDO');await writeFile(home+'/segredo','SEGREDO');
 const server=net.createServer(c=>c.on('data',d=>got.push(String(d)))).listen(socket);await new Promise(r=>server.on('listening',r));t.after(()=>server.close());
 const script=`const c=require('net').connect(${JSON.stringify(socket)});c.on('connect',()=>{c.write('FORA');console.log('LIGOU');setTimeout(()=>process.exit(0),50)});c.on('error',e=>{console.log('ERRO',e.code);process.exit(1)})`,line=`${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
 const free=await new Promise(resolve=>{let out='';const child=spawn(process.execPath,['-e',script]);child.stdout.on('data',d=>out+=d);child.on('close',()=>resolve(out));});assert.match(free,/LIGOU/,'controlo: fora do isolamento liga');got.length=0;
 for(const write of [true,false]){
  const inner=(command,folder=cwd)=>spawnSync('/usr/bin/bash',['-c',confinedCommand(command,folder,write)],{cwd:folder,encoding:'utf8'});
  const r=inner(line);assert.notEqual(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/LIGOU/);
  assert.notEqual(inner(`cat ${shellQuote(home+'/segredo')}`).status,0,'home escondida');
  assert.doesNotMatch(inner('cat .hydraq/state 2>&1; true').stdout,/SEGREDO/,'.hydraq escondida');assert.notEqual(inner('touch .hydraq/x').status,0,'e só de leitura');
  assert.equal(inner(`${shellQuote(process.execPath)} -e 'process.exit(0)'`).status,0,'o Node em uso continua disponível');
  assert.equal(inner('test -d "$HOME" && test -w /tmp').status,0,'a home existe, vazia');
 }
 await new Promise(r=>setTimeout(r,100));assert.deepEqual(got,[],'nada chegou ao socket');
});

test('um worktree numa pasta da home continua a ver os dados do Git, e só para leitura',{skip:noBwrap},async t=>{
 const home=await mkdtemp(path.join(os.homedir(),'.hydraq-confine-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const main=home+'/main',tree=home+'/tree',git=(...args)=>execFileSync('git',args,{cwd:main,stdio:'ignore'});await mkdir(main);git('init','-q');await writeFile(main+'/a.txt','1');git('add','a.txt');git('-c','user.name=t','-c','user.email=t@t','commit','-qm','x');git('worktree','add','-q',tree);
 const r=spawnSync('/usr/bin/bash',['-c',confinedCommand('git log --oneline | wc -l; touch "$(git rev-parse --git-common-dir)/fora" 2>&1 && echo ESCREVEU',tree)],{cwd:tree,encoding:'utf8'});
 assert.equal(r.stdout.trim().split('\n')[0],'1',r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/ESCREVEU/);assert.equal(await exists(main+'/.git/fora'),false);
});

test('o agy continua a encontrar os parâmetros das ferramentas e as suas notas, só para leitura',{skip:noBwrap},async t=>{
 assert.ok(toolFolders().includes(path.join(os.homedir(),'.gemini/antigravity-cli/mcp')));
 const home=await mkdtemp(path.join(os.homedir(),'.hydraq-confine-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const cwd=home+'/project',notes=home+'/brain/conv-1234';await mkdir(cwd);await mkdir(notes,{recursive:true});await writeFile(notes+'/saida.txt','SAIDA LONGA');
 for(const policy of [hydraPolicy(['read_dialogue'],{cwd}),hydraPolicy(['read_dialogue'],{write:true,cwd})]){
  const answer=decide({toolCall:{name:'run_command',args:{CommandLine:'cat '+notes+'/saida.txt',Cwd:cwd}},artifactDirectoryPath:notes},policy);
  const seen=spawnSync('/usr/bin/bash',['-c',answer.overwrite.CommandLine],{cwd,encoding:'utf8'});assert.equal(seen.status,0,seen.stderr);assert.match(seen.stdout,/SAIDA LONGA/);
  const write=spawnSync('/usr/bin/bash',['-c',confinedCommand('touch '+notes+'/x',cwd,true,[notes])],{cwd});assert.notEqual(write.status,0);assert.equal(await exists(notes+'/x'),false);
 }
});

test('perfil comum conserva o temporário do turno e mata filhos ao terminar o comando',{skip:noBwrap},async t=>{
 const {cwd,base}=await project(t),tmp=base+'/turn-tmp';await mkdir(tmp);
 const policy={tmp,network:false,protectedPaths:['.git','.hydraq']};
 const confined=command=>spawnSync('/usr/bin/bash',['-c',confinedCommand(command,cwd,true,[],null,policy)],{cwd,encoding:'utf8',timeout:10000});
 const saved=confined('echo KEEP > /tmp/shared');
 assert.equal(saved.status,0,saved.stderr);
 const reused=confined('cat /tmp/shared');assert.equal(reused.stdout.trim(),'KEEP');
 const child=confined("python3 -c \"import subprocess;subprocess.Popen(['python3','-c',\\\"import time;from pathlib import Path;time.sleep(1);Path('late').write_text('LATE')\\\"],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\"");
 assert.equal(child.status,0,child.stderr);
 await new Promise(resolve=>setTimeout(resolve,1500));
 assert.equal(await exists(cwd+'/late'),false);
});
