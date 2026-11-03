import test from 'node:test';
import assert from 'node:assert/strict';
import fsp,{access,chmod,link,lstat,mkdir,mkdtemp,open,readFile,readlink,rename,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyWorkspace,createWorkspace,integrateWorkspace,prepareVersion,removeWorkspace,undoApplication,workspaceFolder} from '../lib/hydra-workspace.mjs';
import {confinedCommand,externalGitFolder} from '../lib/command-sandbox.mjs';
import {isReservedPath,removePrivate,reservedChanges,reservedState,runValidation,settingWords,testStatus,validationSnapshot} from '../lib/hydra-validation.mjs';
import {noBwrap} from './fixtures/sandbox.mjs';
import {resolveNamedPath} from '../lib/path-resolution.mjs';

const exists=file=>access(file).then(()=>true,()=>false),read=file=>readFile(file,'utf8');
const options={skip:noBwrap};
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'});
const commit=cwd=>{git(cwd,'add','-A');git(cwd,'-c','user.name=t','-c','user.email=t@t','commit','-qm','x');};
async function setup(t,prepare=async()=>{}){
 const root=await mkdtemp(path.join(os.tmpdir(),'hydra-workspace-')),project=root+'/projeto';t.after(()=>removePrivate(root));
 await mkdir(project+'/src',{recursive:true});await mkdir(project+'/node_modules/dep',{recursive:true});
 await writeFile(project+'/.gitignore','node_modules\n*.log\n.idea\n.env\n');await writeFile(project+'/src/a.js','1\n');await writeFile(project+'/src/b.js','1\n');await writeFile(project+'/src/apagar.js','1\n');await writeFile(project+'/run.sh','#!/bin/sh\n');await writeFile(project+'/node_modules/dep/i.js','1\n');
 git(project,'init','-q');commit(project);
 // A user's project is rarely clean.
 await writeFile(project+'/src/b.js','1\ntrabalho teu por guardar\n');
 await prepare({root,project});
 const workspace=await createWorkspace({project,folder:root+'/privado'});
 const x={root,project,workspace,copy:workspace.copy,journal:root+'/privado/aplicacao'};
 x.freeze=(name='v')=>validationSnapshot(x.copy,root+'/testes-'+name);
 x.apply=(validated,extra={})=>applyWorkspace({workspace,validated,...extra});
 return x;
}
const work=async x=>{await writeFile(x.copy+'/src/a.js','2\n');await writeFile(x.copy+'/src/novo.js','novo\n');await mkdir(x.copy+'/src/fundo/mais',{recursive:true});await writeFile(x.copy+'/src/fundo/mais/n.js','n\n');await rm(x.copy+'/src/apagar.js');await chmod(x.copy+'/run.sh',0o755);await symlink('a.js',x.copy+'/src/atalho');};
const expectWork=async x=>{assert.equal(await read(x.project+'/src/a.js'),'2\n');assert.equal(await read(x.project+'/src/novo.js'),'novo\n');assert.equal(await read(x.project+'/src/fundo/mais/n.js'),'n\n');assert.equal(await exists(x.project+'/src/apagar.js'),false);assert.equal((await stat(x.project+'/run.sh')).mode&0o777,0o755);assert.equal(await readlink(x.project+'/src/atalho'),'a.js');assert.equal(await read(x.project+'/src/b.js'),'1\ntrabalho teu por guardar\n','o que era teu fica');};

test('a cópia não leva sockets nem hard links, e tem dados do Git próprios, sem hooks nem programas',options,async t=>{
 const hits=[];let server;
 const x=await setup(t,async({root,project})=>{
  server=createServer(s=>s.on('data',()=>{hits.push(1);s.end();}));await new Promise(r=>server.listen(project+'/servico.sock',r));t.after(()=>new Promise(r=>server.close(r)));
  await writeFile(root+'/fora.txt','ORIGINAL');await link(root+'/fora.txt',project+'/alias.txt');
  await writeFile(project+'/.git/hooks/pre-commit','#!/bin/sh\n');await writeFile(project+'/monitor.sh',`#!/bin/sh\necho x > '${root}/marca'\n`);await chmod(project+'/monitor.sh',0o755);git(project,'config','core.fsmonitor','./monitor.sh');
  await mkdir(project+'/.hydraq');await writeFile(project+'/.hydraq/estado','x');await mkdir(project+'/Library');await writeFile(project+'/Library/grande','x');
 });
 assert.equal(await exists(x.copy+'/servico.sock'),false);assert.equal((await lstat(x.copy+'/alias.txt')).nlink,1);assert.equal(await exists(x.copy+'/.hydraq'),false);assert.equal(await exists(x.copy+'/Library'),false);
 assert.equal(await exists(x.copy+'/.git/hooks'),false);assert.doesNotMatch(await read(x.copy+'/.git/config'),/fsmonitor/);
 await rm(x.root+'/marca',{force:true});
 assert.equal(git(x.copy,'status','--short'),git(x.project,'-c','core.fsmonitor=false','status','--short').replace(/\?\? (\.hydraq|Library)\/\n/g,''),'o Git vê o mesmo');assert.equal(await exists(x.root+'/marca'),false,'e não corre o programa');
 git(x.copy,'log','--oneline');
});

test('num worktree a cópia não aponta para os dados reais: um socket lá dentro fica fora de alcance',options,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hydra-workspace-wt-')),main=root+'/principal',tree=root+'/ramo',hits=[];t.after(()=>removePrivate(root));
 await mkdir(main);await writeFile(main+'/a.txt','1');git(main,'init','-q');commit(main);git(main,'worktree','add','-q',tree,'-b','ramo');
 const socket=main+'/.git/servico.sock',server=createServer(s=>s.on('data',()=>{hits.push(1);s.end();}));await new Promise(r=>server.listen(socket,r));t.after(()=>new Promise(r=>server.close(r)));
 assert.ok(externalGitFolder(tree),'o projeto real é mesmo um worktree');
 const workspace=await createWorkspace({project:tree,folder:root+'/privado'}),copy=workspace.copy;
 assert.ok((await lstat(copy+'/.git')).isDirectory());assert.equal(externalGitFolder(copy),null);assert.equal(git(copy,'status','--short'),'');assert.equal(git(copy,'rev-parse','--abbrev-ref','HEAD').trim(),'ramo');
 const r=execFileSync('/usr/bin/bash',['-c',confinedCommand(`node -e "require('net').connect('${socket}',()=>{console.log('LIGOU');process.exit()}).on('error',e=>console.log(e.code))"`,copy,true,[],tree)],{cwd:copy,encoding:'utf8'});
 assert.doesNotMatch(r,/LIGOU/);assert.deepEqual(hits,[]);
 // Even a pointer left in a copy does not bring the real folder back.
 await rm(copy+'/.git',{recursive:true});await writeFile(copy+'/.git','gitdir: '+main+'/.git/worktrees/ramo\n');
 const again=execFileSync('/usr/bin/bash',['-c',confinedCommand(`node -e "require('net').connect('${socket}',()=>{console.log('LIGOU');process.exit()}).on('error',e=>console.log(e.code))"`,copy,true,[],tree)],{cwd:copy,encoding:'utf8'});
 assert.doesNotMatch(again,/LIGOU/);assert.deepEqual(hits,[]);
});

test('sem conseguir fazer a cópia, recusa e não deixa nada',options,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hydra-workspace-'));t.after(()=>removePrivate(root));
 await assert.rejects(createWorkspace({project:root+'/nao-existe',folder:root+'/privado'}));assert.equal(await exists(root+'/privado'),false);
 await mkdir(root+'/p');await assert.rejects(createWorkspace({project:root+'/p',folder:root+'/p/.hydraq/privado'}),/dentro do projeto/);
 assert.equal(workspaceFolder('/dados','id','/outro'),'/dados/workspaces/id');assert.match(workspaceFolder('/p/.hydraq','id','/p'),/\.local\/state\/hydraq\/workspaces\/id$/);
});

test('leva ao projeto o que foi testado, e não o que a cópia passou a ter depois',options,async t=>{
 const x=await setup(t);await work(x);await writeFile(x.copy+'/saida.log','do principal');await mkdir(x.copy+'/.idea');await writeFile(x.copy+'/.idea/x','1');await writeFile(x.copy+'/.env','K=1');
 const tested=await x.freeze();await writeFile(x.copy+'/src/a.js','NUNCA TESTADO\n');
 const config=await read(x.project+'/.git/config'),result=await x.apply(tested);assert.equal(result.status,'applied',JSON.stringify(result));
 await expectWork(x);assert.equal(await exists(x.project+'/saida.log'),false,'um registo não é aplicado');assert.equal(await exists(x.project+'/.idea'),false);assert.equal(await exists(x.project+'/.env'),false,'um segredo também não');
 assert.equal(await read(x.project+'/.git/config'),config);assert.equal(await exists(x.journal),false);
 assert.deepEqual(await x.apply(tested).then(r=>r.status),'applied','aplicar outra vez não faz nada');
});

test('as dependências e os ficheiros ignorados testados chegam ao projeto: o mesmo comando passa lá',options,async t=>{
 const x=await setup(t);const command=`node -e "if(require('./node_modules/dep/i.js')!==2||require('./gerado/r.js')!==3)process.exit(1)"`;
 await writeFile(x.project+'/.gitignore','node_modules\n*.log\n.idea\n.env\ngerado\n');
 await rm(x.root+'/privado',{recursive:true});x.workspace=await createWorkspace({project:x.project,folder:x.root+'/privado'});
 const y={...x,copy:x.workspace.copy,apply:(validated,extra={})=>applyWorkspace({workspace:x.workspace,validated,...extra})};
 await writeFile(y.copy+'/node_modules/dep/i.js','module.exports=2;\n');await mkdir(y.copy+'/gerado');await writeFile(y.copy+'/gerado/r.js','module.exports=3;\n');
 const tested=await validationSnapshot(y.copy,x.root+'/testes');assert.equal(testStatus(await runValidation({snapshot:tested.directory,cwd:y.copy,origin:x.project,command})),'passed');
 const result=await y.apply(tested);assert.equal(result.status,'applied',JSON.stringify(result));
 execFileSync('/bin/sh',['-c',command],{cwd:x.project});assert.equal(await read(x.project+'/node_modules/dep/i.js'),'module.exports=2;\n');
});

test('os testes correm na cópia e os caminhos absolutos do projeto levam a ela',options,async t=>{
 const x=await setup(t,async({project})=>{await symlink(project+'/src',project+'/abs');});await writeFile(x.copy+'/src/a.js','da-copia\n');
 const tested=await x.freeze(),r=await runValidation({snapshot:tested.directory,cwd:x.copy,origin:x.project,command:`pwd; cat abs/a.js; cat ${x.project}/src/a.js; printf x > ${x.project}/novo.txt 2>&1; printf x > escrito.txt; git status --short | head -2`});
 assert.equal(r.exitCode,0,r.output);assert.match(r.output,new RegExp('^'+x.copy));assert.equal((r.output.match(/da-copia/g)||[]).length,2,r.output);
 assert.equal(await read(x.project+'/src/a.js'),'1\n');assert.equal(await exists(x.project+'/novo.txt'),false);assert.equal(await exists(x.copy+'/escrito.txt'),false);
});

test('uma edição tua noutro ficheiro obriga a integrar e a validar de novo; nada é escrito antes',options,async t=>{
 const x=await setup(t);await work(x);const first=await x.freeze();await writeFile(x.project+'/src/b.js','1\nmudei mais uma coisa\n');await writeFile(x.project+'/teu.js','novo\n');
 let result=await x.apply(first);assert.equal(result.status,'integrate');assert.deepEqual(result.files.sort(),['src/b.js','teu.js']);assert.equal(await read(x.project+'/src/a.js'),'1\n','nada foi escrito');
 await integrateWorkspace({workspace:x.workspace});assert.equal(await read(x.copy+'/src/b.js'),'1\nmudei mais uma coisa\n');assert.equal(await read(x.copy+'/src/a.js'),'2\n','o trabalho do principal fica');
 const second=await x.freeze('2');assert.equal(testStatus(await runValidation({snapshot:second.directory,cwd:x.copy,origin:x.project,command:'grep -q "mudei mais" src/b.js && grep -q 2 src/a.js && test -f teu.js'})),'passed');
 result=await x.apply(second);assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await read(x.project+'/src/a.js'),'2\n');assert.equal(await read(x.project+'/src/b.js'),'1\nmudei mais uma coisa\n');assert.equal(await read(x.project+'/teu.js'),'novo\n');
});

test('os dois no mesmo ficheiro: nada é escrito; com o mesmo resultado não há conflito',options,async t=>{
 const x=await setup(t);await work(x);const tested=await x.freeze();await writeFile(x.project+'/src/a.js','outra coisa\n');
 let result=await x.apply(tested);assert.equal(result.status,'conflict');assert.deepEqual(result.files,['src/a.js']);assert.equal(await read(x.project+'/src/a.js'),'outra coisa\n');assert.equal(await exists(x.project+'/src/novo.js'),false);
 await writeFile(x.project+'/src/a.js','2\n');result=await x.apply(tested);assert.equal(result.status,'applied',JSON.stringify(result));await expectWork(x);
});

test('um editor ou um registo a mudar no original não contam; uma dependência sim, e é integrada',options,async t=>{
 const x=await setup(t);await work(x);const tested=await x.freeze();await mkdir(x.project+'/.idea');await writeFile(x.project+'/.idea/w.xml','1');await writeFile(x.project+'/app.log','1');
 assert.equal((await x.apply(tested)).status,'applied');
 const y=await setup(t);await work(y);const again=await y.freeze();await writeFile(y.project+'/node_modules/dep/i.js','outra versão\n');
 const result=await y.apply(again);assert.equal(result.status,'integrate');assert.equal(result.environment,true);assert.deepEqual(result.files,['node_modules/dep/i.js']);assert.equal(await exists(y.project+'/src/novo.js'),false);
 await integrateWorkspace({workspace:y.workspace});assert.equal(await read(y.copy+'/node_modules/dep/i.js'),'outra versão\n');
 const final=await y.apply(await y.freeze('2'));assert.equal(final.status,'applied',JSON.stringify(final));assert.equal(await read(y.project+'/node_modules/dep/i.js'),'outra versão\n');
});

test('um hard link no original não leva a escrita para fora; ficheiro e pasta podem trocar de lugar',options,async t=>{
 const x=await setup(t,async({root,project})=>{await rm(project+'/src/a.js');await writeFile(root+'/fora.txt','1\n');await link(root+'/fora.txt',project+'/src/a.js');await writeFile(project+'/era-ficheiro','1');await mkdir(project+'/era-pasta');await writeFile(project+'/era-pasta/f','1');});
 await writeFile(x.copy+'/src/a.js','2\n');await rm(x.copy+'/era-ficheiro');await mkdir(x.copy+'/era-ficheiro');await writeFile(x.copy+'/era-ficheiro/g','2');await rm(x.copy+'/era-pasta',{recursive:true});await writeFile(x.copy+'/era-pasta','2');
 const result=await x.apply(await x.freeze());assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await read(x.project+'/src/a.js'),'2\n');assert.equal(await read(x.root+'/fora.txt'),'1\n');
 assert.equal(await read(x.project+'/era-ficheiro/g'),'2');assert.equal(await read(x.project+'/era-pasta'),'2');
 // And it can all be undone, in any state.
 for(const stopAfter of [1,2,3,4]){
  const y=await setup(t,async({project})=>{await writeFile(project+'/era-ficheiro','1');await mkdir(project+'/era-pasta');await writeFile(project+'/era-pasta/f','1');});
  await rm(y.copy+'/era-ficheiro');await mkdir(y.copy+'/era-ficheiro');await writeFile(y.copy+'/era-ficheiro/g','2');await rm(y.copy+'/era-pasta',{recursive:true});await writeFile(y.copy+'/era-pasta','2');const again=await y.freeze();
  assert.equal((await y.apply(again,{environment:{HYDRAQ_APPLY_STOP_AFTER:stopAfter}})).status,stopAfter<4?'failed':'applied');if(stopAfter===4)continue;
  await writeFile(y.project+'/src/b.js','editado\n');const undone=await y.apply(again);assert.equal(undone.status,'integrate',JSON.stringify(undone));
  assert.equal(await read(y.project+'/era-ficheiro'),'1');assert.equal(await read(y.project+'/era-pasta/f'),'1');
 }
});

test('o resultado não muda o que o Git corre sem o utilizador ver; confirmado, passa',options,async t=>{
 for(const [prepare,file] of [
  [async({project})=>{await writeFile(project+'/inc.cfg','[a]\nb=1\n');git(project,'config','include.path','../inc.cfg');},'inc.cfg'],
  [async({project})=>{await mkdir(project+'/scripts');await writeFile(project+'/scripts/h.sh','1');await symlink('../../scripts/h.sh',project+'/.git/hooks/pre-commit');},'scripts/h.sh'],
  [async({project})=>{await writeFile(project+'/monitor tool.sh','1');git(project,'config','core.fsmonitor',"'./monitor tool.sh'");},'monitor tool.sh'],
  [async({project})=>{await mkdir(project+'/.husky');await writeFile(project+'/.husky/pre-commit','1');git(project,'config','core.hooksPath','.husky');},'.husky/pre-commit'],
 ]){
  const x=await setup(t,prepare);await writeFile(path.join(x.copy,file),'MUDADO');const tested=await x.freeze();
  let result=await x.apply(tested);assert.equal(result.status,'reserved',file+' '+JSON.stringify(result));assert.ok(result.files.includes(file));assert.notEqual(await read(path.join(x.project,file)),'MUDADO');
  result=await x.apply(tested,{accepted:result.confirm});assert.equal(result.status,'applied',file+' '+JSON.stringify(result));assert.equal(await read(path.join(x.project,file)),'MUDADO');
 }
 // Changing the real configuration meanwhile also needs the user.
 const y=await setup(t);await work(y);const tested=await y.freeze();git(y.project,'config','core.fsmonitor','/tmp/x');assert.equal((await y.apply(tested)).status,'reserved');
 // The copy's own Git data never reaches the project.
 const z=await setup(t);await writeFile(z.copy+'/.git/config','[core]\n\tfsmonitor=/tmp/x\n');await mkdir(z.copy+'/.git/hooks');await writeFile(z.copy+'/.git/hooks/pre-commit','x');await mkdir(z.copy+'/.hydraq');await writeFile(z.copy+'/.hydraq/s','x');await mkdir(z.copy+'/sub/.git',{recursive:true});await writeFile(z.copy+'/sub/.git/config','x');await writeFile(z.copy+'/src/a.js','2\n');
 const before=await read(z.project+'/.git/config'),done=await z.apply(await z.freeze());assert.equal(done.status,'applied',JSON.stringify(done));assert.equal(await read(z.project+'/.git/config'),before);assert.equal(await exists(z.project+'/.git/hooks/pre-commit'),false);assert.equal(await exists(z.project+'/.hydraq'),false);assert.equal(await exists(z.project+'/sub/.git'),false);
});

test('sockets e pipes não bloqueiam a aplicação nem são copiados',options,async t=>{
 const x=await setup(t);await work(x);execFileSync('mkfifo',[x.copy+'/gerado.log.pipe']);await writeFile(x.copy+'/.gitignore','node_modules\n*.log\n.idea\n.env\n*.pipe\n');
 const result=await x.apply(await x.freeze());assert.equal(result.status,'applied',JSON.stringify(result));await expectWork(x);assert.equal(await exists(x.project+'/gerado.log.pipe'),false);
 // A pipe in the project where the task wants a file stops before opening it.
 const y=await setup(t);await writeFile(y.copy+'/ali.js','1\n');const tested=await y.freeze();execFileSync('mkfifo',[y.project+'/ali.js']);
 const stopped=await y.apply(tested);assert.equal(stopped.status,'conflict',JSON.stringify(stopped));assert.equal(await exists(y.project+'/src/novo.js'),false);
});

test('um ficheiro teu com um nome parecido com o temporário não é apagado',options,async t=>{
 const x=await setup(t,async({project})=>{await writeFile(project+'/src/a.js.hydraq-aplicar','meu');await writeFile(project+'/src/.hydraq-aplicar','meu');});await writeFile(x.copy+'/src/a.js','2\n');
 const result=await x.apply(await x.freeze());assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await read(x.project+'/src/a.js'),'2\n');assert.equal(await read(x.project+'/src/a.js.hydraq-aplicar'),'meu');assert.equal(await read(x.project+'/src/.hydraq-aplicar'),'meu');
});

test('um encerramento em qualquer ponto recupera até ao resultado testado, sem restos',options,async t=>{
 const seen=[];
 for(const environment of [...Array(8).keys()].map(n=>({HYDRAQ_APPLY_STOP_AFTER:n})).concat(['temporary','aside','linked'].flatMap(at=>[0,2,4].map(n=>({HYDRAQ_APPLY_STOP_AT:at,HYDRAQ_APPLY_STOP_AFTER:n}))))){
  const x=await setup(t);await work(x);const tested=await x.freeze(),stopped=await x.apply(tested,{environment});seen.push(stopped.status);
  if(stopped.status!=='applied'){assert.equal(stopped.status,'failed',JSON.stringify(stopped));assert.equal(await exists(x.journal+'/plano.json'),true,'o diário sobrevive');}
  const result=await x.apply(tested);assert.equal(result.status,'applied',JSON.stringify(result));await expectWork(x);assert.equal(await exists(x.journal),false);
  assert.doesNotMatch(execFileSync('find',[x.project,'-name','.hydraq-aplicar-*'],{encoding:'utf8'}),/hydraq-aplicar/,'nem temporários');
 }
 assert.ok(seen.filter(s=>s==='failed').length>=5,'parou mesmo a meio: '+seen);assert.ok(seen.includes('applied'),'e passou o fim: '+seen);
});

test('recuperar não confia no diário: uma pasta que passou a ser ligação pára tudo e nada é escrito lá',options,async t=>{
 const x=await setup(t);await writeFile(x.copy+'/src/a.js','2\n');const tested=await x.freeze();
 assert.equal((await x.apply(tested,{environment:{HYDRAQ_APPLY_STOP_AFTER:0}})).status,'failed');
 // src is replaced by a link to a folder holding what the journal expects to find.
 const away=x.root+'/longe';await mkdir(away);await writeFile(away+'/a.js','1\n');await writeFile(away+'/b.js','1\ntrabalho teu por guardar\n');await writeFile(away+'/apagar.js','1\n');await rm(x.project+'/src',{recursive:true});await symlink(away,x.project+'/src');
 const result=await x.apply(tested);assert.equal(result.status,'conflict',JSON.stringify(result));assert.deepEqual(result.files,['src/a.js']);assert.equal(await read(away+'/a.js'),'1\n','a pasta exterior fica intacta');assert.equal(await exists(x.journal+'/plano.json'),true);
});

test('o escritor confinado não consegue sair do projeto, mesmo com um caminho que passe as verificações',options,async t=>{
 const x=await setup(t),journal=x.root+'/diario',away=x.root+'/longe';await mkdir(journal);await mkdir(away);await writeFile(away+'/x.txt','ORIGINAL');await writeFile(journal+'/fonte','MUDADO');
 const plan=journal+'/plano.json',worker=fileURLToPath(new URL('../lib/hydra-workspace-worker.mjs',import.meta.url));
 await writeFile(plan,JSON.stringify({root:x.project,token:'t',created:[],changes:[{file:'../longe/x.txt',before:await (await import('../lib/hydra-workspace.mjs')).sign(away+'/x.txt'),after:'qualquer',source:journal+'/fonte',keep:null}]}));
 const output=await new Promise(resolve=>{const child=spawn('bwrap',['--unshare-all','--die-with-parent','--new-session','--ro-bind','/','/','--dev','/dev','--proc','/proc','--bind',x.project,x.project,'--bind',journal,journal,'--clearenv','--',process.execPath,worker,plan,'forward'],{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);child.on('close',()=>resolve(out));});
 assert.match(output,/"ok":false/,output);assert.equal(await read(away+'/x.txt'),'ORIGINAL');
});

test('recuperar não aplica uma versão nunca testada: outra edição durante a interrupção desfaz o que foi escrito',options,async t=>{
 const x=await setup(t);await work(x);const tested=await x.freeze();
 assert.equal((await x.apply(tested,{environment:{HYDRAQ_APPLY_STOP_AFTER:3}})).status,'failed');assert.equal(await read(x.project+'/src/a.js').then(v=>v==='2\n'||v==='1\n'),true);
 await writeFile(x.project+'/src/b.js','editado durante a interrupção\n');
 let result=await x.apply(tested);assert.equal(result.status,'integrate',JSON.stringify(result));assert.deepEqual(result.files,['src/b.js']);assert.equal(await exists(x.journal+'/plano.json'),false);
 // Back to the state of the project, with the user's edit.
 assert.equal(await read(x.project+'/src/a.js'),'1\n');assert.equal(await read(x.project+'/src/apagar.js'),'1\n');assert.equal(await exists(x.project+'/src/novo.js'),false);assert.equal(await exists(x.project+'/src/fundo'),false);assert.notEqual((await stat(x.project+'/run.sh')).mode&0o777,0o755);assert.equal(await read(x.project+'/src/b.js'),'editado durante a interrupção\n');
 await integrateWorkspace({workspace:x.workspace});result=await x.apply(await x.freeze('2'));assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await read(x.project+'/src/a.js'),'2\n');assert.equal(await read(x.project+'/src/b.js'),'editado durante a interrupção\n');
 // Also when what moved is Git's configuration.
 const y=await setup(t);await work(y);const again=await y.freeze();assert.equal((await y.apply(again,{environment:{HYDRAQ_APPLY_STOP_AFTER:2}})).status,'failed');git(y.project,'config','core.fsmonitor','/tmp/x');
 const undone=await y.apply(again);assert.equal(undone.status,'reserved',JSON.stringify(undone));assert.equal(await read(y.project+'/src/a.js'),'1\n');
});

test('um ficheiro da aplicação alterado durante a interrupção pára, e continua depois de reposto',options,async t=>{
 const x=await setup(t);await work(x);const tested=await x.freeze();assert.equal((await x.apply(tested,{environment:{HYDRAQ_APPLY_STOP_AFTER:0}})).status,'failed');
 await writeFile(x.project+'/src/a.js','outra coisa\n');
 let result=await x.apply(tested);assert.equal(result.status,'conflict');assert.equal(result.partial,true);assert.deepEqual(result.files,['src/a.js']);assert.equal(await read(x.project+'/src/a.js'),'outra coisa\n');
 await writeFile(x.project+'/src/a.js','1\n');result=await x.apply(tested);assert.equal(result.status,'applied',JSON.stringify(result));await expectWork(x);
});

test('programas do Git: caminho com espaços ou aspas, e definições globais',async t=>{
 assert.deepEqual(settingWords("'./scripts/monitor tool.sh'").includes('./scripts/monitor tool.sh'),true);assert.ok(settingWords('!sh "a b.sh" --x').includes('a b.sh'));assert.ok(settingWords('!sh -c "./x.sh arg; ./y.sh"').includes('./y.sh'));assert.ok(settingWords('./sem aspas.sh').includes('./sem aspas.sh'));assert.ok(settingWords('--exec=./z.sh').includes('./z.sh'));
 const root=await mkdtemp(path.join(os.tmpdir(),'hydra-workspace-git-')),cwd=root+'/p';t.after(()=>{delete process.env.GIT_CONFIG_GLOBAL;return removePrivate(root);});await mkdir(cwd);git(cwd,'init','-q');await mkdir(cwd+'/scripts');await writeFile(cwd+'/scripts/monitor tool.sh','1');await writeFile(cwd+'/scripts/global.sh','1');await writeFile(cwd+'/a.txt','1');await mkdir(cwd+'/pasta');await writeFile(cwd+'/main','1');
 await writeFile(root+'/global.cfg','[core]\n\tfsmonitor=./scripts/global.sh\n[init]\n\tdefaultBranch=main\n[alias]\n\tlista=!ls pasta\n');process.env.GIT_CONFIG_GLOBAL=root+'/global.cfg';
 git(cwd,'config','core.fsmonitor',"'./scripts/monitor tool.sh'");
 const before=await reservedState(cwd),changes=async()=>reservedChanges(before,await reservedState(cwd));
 for(const [file,value] of [['a.txt','2'],['main','2'],['pasta/f','2']]){await writeFile(path.join(cwd,file),value);}assert.deepEqual(await changes(),[],'o resto não conta');
 await writeFile(cwd+'/scripts/monitor tool.sh','2');assert.deepEqual(await changes(),['scripts/monitor tool.sh']);await writeFile(cwd+'/scripts/monitor tool.sh','1');
 await writeFile(cwd+'/scripts/global.sh','2');assert.deepEqual(await changes(),['scripts/global.sh']);await writeFile(cwd+'/scripts/global.sh','1');
 // A change to the user's own settings is not a change of the project; a project file included by them is.
 await writeFile(root+'/global.cfg','[core]\n\tfsmonitor=./scripts/global.sh\n[init]\n\tdefaultBranch=main\n[alias]\n\tlista=!ls pasta\n[user]\n\tname=outro\n');assert.deepEqual(await changes(),[]);
 await writeFile(cwd+'/inc.cfg','[a]\n\tb=1\n');await writeFile(root+'/global.cfg',`[include]\n\tpath=${cwd}/inc.cfg\n`);const moved=await reservedState(cwd);await writeFile(cwd+'/inc.cfg','[a]\n\tb=2\n');const late=reservedChanges(moved,await reservedState(cwd));assert.ok(late.includes('inc.cfg')&&late.includes('git config'),late.join());
});

// What the second independent review found, as tests of the right behaviour.
const hold=async(x,at,during,extra={})=>{
 const journal=x.root+'/privado/aplicacao',running=x.apply(x.tested,{environment:{HYDRAQ_APPLY_HOLD_AT:at,...extra}});
 for(const end=Date.now()+20000;!await exists(journal+'/parado');await new Promise(r=>setTimeout(r,10)))if(Date.now()>end)throw Error('O escritor não chegou a '+at);
 await during();await writeFile(journal+'/continua','');return running;
};

test('uma edição tua enquanto o ficheiro novo é preparado nunca é substituída, e continua depois de resolvida',options,async t=>{
 const x=await setup(t);await writeFile(x.copy+'/src/a.js','2\n');x.tested=await x.freeze();
 let result=await hold(x,'temporary',()=>writeFile(x.project+'/src/a.js','EDIÇÃO TUA\n'));
 assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(result.partial,true);assert.deepEqual(result.files,['src/a.js']);assert.equal(await read(x.project+'/src/a.js'),'EDIÇÃO TUA\n');assert.equal(await exists(x.journal+'/plano.json'),true);
 assert.equal((await x.apply(x.tested)).status,'conflict','enquanto não for resolvido, não passa');assert.equal(await read(x.project+'/src/a.js'),'EDIÇÃO TUA\n');
 await writeFile(x.project+'/src/a.js','1\n');result=await x.apply(x.tested);assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await read(x.project+'/src/a.js'),'2\n');
});

test('um ficheiro criado por ti enquanto a aplicação decorre nunca é substituído, e o antigo fica guardado',options,async t=>{
 // Where the task creates a file.
 const x=await setup(t);await writeFile(x.copy+'/novo.js','da tarefa\n');x.tested=await x.freeze();
 let result=await hold(x,'temporary',()=>writeFile(x.project+'/novo.js','TEU\n'));assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(await read(x.project+'/novo.js'),'TEU\n');
 // In the instant the old one is set aside, an editor saves over the same name.
 const y=await setup(t);await writeFile(y.copy+'/src/a.js','2\n');y.tested=await y.freeze();
 result=await hold(y,'aside',()=>writeFile(y.project+'/src/a.js','TEU\n'));assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(await read(y.project+'/src/a.js'),'TEU\n');
 // A program still writing to the old file through an open handle shows up before the end.
 const z=await setup(t);await writeFile(z.copy+'/src/a.js','2\n');z.tested=await z.freeze();const handle=await open(z.project+'/src/a.js','r+');t.after(()=>handle.close().catch(()=>{}));
 result=await hold(z,'linked',async()=>{await handle.write('X',0);await handle.sync();});assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(result.partial,true);assert.ok(result.kept,'o que foi escrito fica guardado');assert.equal(await read(result.kept),'X\n');
});

test('o que sobrou de uma preparação interrompida antes do plano não atrapalha',options,async t=>{
 const x=await setup(t);await work(x);await mkdir(x.journal+'/copia',{recursive:true});await mkdir(x.journal+'/novo');await writeFile(x.journal+'/novo/0','lixo');
 const result=await x.apply(await x.freeze());assert.equal(result.status,'applied',JSON.stringify(result));await expectWork(x);assert.equal(await exists(x.journal),false);
});

test('desfazer também não substitui o que mudou, e pode ser interrompido e recomeçado',options,async t=>{
 const x=await setup(t);await work(x);x.tested=await x.freeze();
 assert.equal((await x.apply(x.tested,{environment:{HYDRAQ_APPLY_STOP_AFTER:5}})).status,'failed');
 // Stopped at each point of the way back, and then taken to the end.
 for(const environment of [{HYDRAQ_APPLY_STOP_MODE:'rollback',HYDRAQ_APPLY_STOP_AFTER:1},{HYDRAQ_APPLY_STOP_MODE:'rollback',HYDRAQ_APPLY_STOP_AT:'temporary',HYDRAQ_APPLY_STOP_AFTER:1},{HYDRAQ_APPLY_STOP_MODE:'rollback',HYDRAQ_APPLY_STOP_AT:'aside',HYDRAQ_APPLY_STOP_AFTER:1},{HYDRAQ_APPLY_STOP_MODE:'rollback',HYDRAQ_APPLY_STOP_AT:'linked',HYDRAQ_APPLY_STOP_AFTER:1}]){
  const stopped=await undoApplication({workspace:x.workspace,environment});assert.equal(stopped.status,'failed',JSON.stringify(stopped));assert.equal(await exists(x.journal+'/plano.json'),true);
 }
 const undone=await undoApplication({workspace:x.workspace});assert.equal(undone.status,'undone',JSON.stringify(undone));
 assert.equal(await read(x.project+'/src/a.js'),'1\n');assert.equal(await read(x.project+'/src/apagar.js'),'1\n');assert.equal(await exists(x.project+'/src/novo.js'),false);assert.equal(await exists(x.project+'/src/fundo'),false);assert.equal(await exists(x.project+'/src/atalho'),false);assert.equal(await exists(x.journal),false);
 assert.doesNotMatch(execFileSync('find',[x.project,'-name','.hydraq-aplicar-*'],{encoding:'utf8'}),/hydraq-aplicar/);
 // Nothing to undo says so, and an edit made since stops it.
 assert.equal((await undoApplication({workspace:x.workspace})).status,'none');
 assert.equal((await x.apply(x.tested,{environment:{HYDRAQ_APPLY_STOP_AFTER:2}})).status,'failed');const first=(await readFile(x.journal+'/plano.json','utf8'));const {changes}=JSON.parse(first),touched=changes[0].file;
 await writeFile(path.join(x.project,touched),'EDIÇÃO TUA\n');const blocked=await undoApplication({workspace:x.workspace});assert.equal(blocked.status,'conflict',JSON.stringify(blocked));assert.equal(await read(path.join(x.project,touched)),'EDIÇÃO TUA\n');assert.equal(await exists(x.journal+'/plano.json'),true);
 // An edit while the way back is running.
 const y=await setup(t);await writeFile(y.copy+'/src/a.js','2\n');y.tested=await y.freeze();assert.equal((await y.apply(y.tested)).status,'applied');
});

test('um diário só acaba a versão para que foi feito: uma aprovação nova desfaz o antigo e aplica a nova',options,async t=>{
 const x=await setup(t);await writeFile(x.copy+'/src/a.js','2\n');await writeFile(x.copy+'/src/velho.js','velho\n');const first=await x.freeze('1');
 assert.equal((await x.apply(first,{environment:{HYDRAQ_APPLY_STOP_AFTER:1}})).status,'failed');assert.equal(await exists(x.journal+'/plano.json'),true);
 await rm(x.copy+'/src/velho.js');await writeFile(x.copy+'/src/candidato.js','aprovado depois\n');const second=await x.freeze('2');
 const result=await x.apply(second);assert.equal(result.status,'applied',JSON.stringify(result));
 assert.equal(await read(x.project+'/src/candidato.js'),'aprovado depois\n');assert.equal(await exists(x.project+'/src/velho.js'),false);assert.equal(await read(x.project+'/src/a.js'),'2\n');
 // Also a version that differs only in its dependencies.
 const y=await setup(t);await writeFile(y.copy+'/src/a.js','2\n');const one=await y.freeze('1');assert.equal((await y.apply(one,{environment:{HYDRAQ_APPLY_STOP_AFTER:0}})).status,'failed');
 await writeFile(y.copy+'/node_modules/dep/i.js','2\n');const two=await y.freeze('2');assert.notEqual(two.dependencies,one.dependencies);assert.equal(two.hash,one.hash);
 const done=await y.apply(two);assert.equal(done.status,'applied',JSON.stringify(done));assert.equal(await read(y.project+'/node_modules/dep/i.js'),'2\n');
});

test('criar um programa que o Git já nomeia, ou um hook novo, pede a tua confirmação; confirmar não vale para outra alteração',options,async t=>{
 const x=await setup(t,async({project})=>{git(project,'config','core.fsmonitor','./monitor.sh');});
 await writeFile(x.copy+'/monitor.sh','#!/bin/sh\n');await chmod(x.copy+'/monitor.sh',0o755);const tested=await x.freeze();
 let result=await x.apply(tested);assert.equal(result.status,'reserved',JSON.stringify(result));assert.deepEqual(result.files,['monitor.sh']);assert.equal(await exists(x.project+'/monitor.sh'),false);
 const confirmed=result.confirm;result=await x.apply(tested,{accepted:confirmed});assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await exists(x.project+'/monitor.sh'),true);
 // What was confirmed was that content.
 const y=await setup(t,async({project})=>{git(project,'config','core.fsmonitor','./monitor.sh');});await writeFile(y.copy+'/monitor.sh','1');let one=await y.freeze('1');const asked=await y.apply(one);assert.equal(asked.status,'reserved');
 await writeFile(y.copy+'/monitor.sh','2');one=await y.freeze('2');const again=await y.apply(one,{accepted:asked.confirm});assert.equal(again.status,'reserved','outro conteúdo volta a perguntar');assert.equal(await exists(y.project+'/monitor.sh'),false);
 // A new file in a folder of hooks, there or not yet.
 for(const prepare of [async({project})=>{await mkdir(project+'/.husky');await writeFile(project+'/.husky/pre-commit','1');git(project,'config','core.hooksPath','.husky');},async({project})=>{git(project,'config','core.hooksPath','.husky');},async({root,project})=>{await rm(project+'/.git/hooks',{recursive:true,force:true});await mkdir(project+'/ganchos');await symlink('../ganchos',project+'/.git/hooks');}]){
  const z=await setup(t,prepare),folder=await exists(z.project+'/ganchos')?'ganchos':'.husky';await mkdir(path.join(z.copy,folder),{recursive:true});await writeFile(path.join(z.copy,folder,'post-commit'),'#!/bin/sh\n');
  const r=await z.apply(await z.freeze());assert.equal(r.status,'reserved',folder+' '+JSON.stringify(r));assert.deepEqual(r.files,[folder+'/post-commit']);assert.equal(await exists(path.join(z.project,folder,'post-commit')),false);
 }
 // A bare word is looked up in PATH, and an unrelated file with its name stays free.
 const w=await setup(t,async({project})=>{git(project,'config','core.pager','less');git(project,'config','core.editor','vim -c x');});await writeFile(w.copy+'/less','1');await writeFile(w.copy+'/vim','1');assert.equal((await w.apply(await w.freeze())).status,'applied');
});

test('integrar olha de novo, e só dá por integrado o que copiou e confirmou',options,async t=>{
 const x=await setup(t);await work(x);const first=await x.freeze('1');await writeFile(x.project+'/src/b.js','primeira edição\n');
 const asked=await x.apply(first);assert.equal(asked.status,'integrate');assert.deepEqual(asked.files,['src/b.js']);
 // Between the question and the integration, another edit.
 await writeFile(x.project+'/run.txt','segunda edição\n');
 let merged=await integrateWorkspace({workspace:x.workspace});assert.deepEqual(merged.files.sort(),['run.txt','src/b.js']);assert.equal(await read(x.copy+'/run.txt'),'segunda edição\n');
 // An edit in the middle of copying: what arrived is not what was looked at, so it stays pending.
 const y=await setup(t);await work(y);await writeFile(y.project+'/c.txt','primeira\n');const original=fsp.copyFile;let edited=false;
 fsp.copyFile=async function(from,...rest){const result=await original.call(this,from,...rest);if(!edited&&String(from)===y.project+'/c.txt'){edited=true;await writeFile(y.project+'/c.txt','mudou durante a cópia\n');}return result;};syncBuiltinESMExports();
 try{merged=await integrateWorkspace({workspace:y.workspace});}finally{fsp.copyFile=original;syncBuiltinESMExports();}
 assert.equal(edited,true);assert.deepEqual(merged.files,[]);assert.deepEqual(merged.pending,['c.txt']);assert.equal(await exists(y.copy+'/c.txt'),false);
 const later=await y.apply(await y.freeze('1'));assert.equal(later.status,'integrate','continua por integrar, e não desaparece da comparação');assert.deepEqual(later.files,['c.txt']);
 merged=await integrateWorkspace({workspace:y.workspace});assert.deepEqual(merged.files,['c.txt']);const final=await y.apply(await y.freeze('2'));assert.equal(final.status,'applied',JSON.stringify(final));assert.equal(await read(y.project+'/c.txt'),'mudou durante a cópia\n');
 // An edit after integrating is another round, never silently applied over.
 const z=await setup(t);await work(z);const a=await z.freeze('1');await writeFile(z.project+'/c.txt','1\n');await z.apply(a);await integrateWorkspace({workspace:z.workspace});const b=await z.freeze('2');await writeFile(z.project+'/d.txt','2\n');assert.equal((await z.apply(b)).status,'integrate');
 // What the principal also changed is a conflict, found here too.
 const v=await setup(t);await writeFile(v.copy+'/src/a.js','2\n');await writeFile(v.project+'/src/a.js','teu\n');const clash=await integrateWorkspace({workspace:v.workspace});assert.equal(clash.status,'conflict');assert.equal(await read(v.copy+'/src/a.js'),'2\n');
 // A change to Git's settings in that window is not swallowed by the integration.
 const u=await setup(t);await work(u);const c=await u.freeze('1');await writeFile(u.project+'/c.txt','1\n');await u.apply(c);git(u.project,'config','core.fsmonitor','/tmp/x');await integrateWorkspace({workspace:u.workspace});assert.equal((await u.apply(await u.freeze('2'))).status,'reserved');
});

test('o caminho da cópia nunca chega ao projeto: ligações e texto recebem o caminho final antes de testar; um binário é recusado',options,async t=>{
 const x=await setup(t);await symlink(x.copy+'/src/a.js',x.copy+'/alias.js');await writeFile(x.copy+'/gerado.cfg',`raiz=${x.copy}\nficheiro=${x.copy}/src/a.js\n`);await writeFile(x.copy+'/sem-caminho.bin',Buffer.from([0,1,2]));
 const command=`cat alias.js; grep -q "raiz=${x.project}" gerado.cfg; cat "$(sed -n 's/^ficheiro=//p' gerado.cfg)"`;
 const prepared=await prepareVersion({workspace:x.workspace});assert.deepEqual(prepared.rewritten.sort(),['alias.js','gerado.cfg']);assert.deepEqual(prepared.problems,[]);
 const tested=await x.freeze(),r=await runValidation({snapshot:tested.directory,cwd:x.copy,origin:x.project,command});assert.equal(testStatus(r),'passed',r.output);
 assert.equal((await x.apply(tested)).status,'applied');await removeWorkspace(x.root+'/privado');
 assert.equal(await readlink(x.project+'/alias.js'),x.project+'/src/a.js');assert.equal(execFileSync('/bin/sh',['-c',command],{cwd:x.project,encoding:'utf8'}),'1\n1\n','o mesmo comando passa no projeto');
 // A binary cannot be rewritten: it is reported, and so is one past the limit of a line split across reads.
 const y=await setup(t);await writeFile(y.copy+'/modulo.so',Buffer.concat([Buffer.from([0,1]),Buffer.from(y.copy+'/lib'),Buffer.from([0])]));await writeFile(y.copy+'/grande.txt',Buffer.concat([Buffer.alloc(65530,97),Buffer.from(y.copy+'/fim\n')]));
 const report=await prepareVersion({workspace:y.workspace});assert.deepEqual(report.problems,['modulo.so']);assert.deepEqual(report.rewritten,['grande.txt']);assert.ok((await read(y.copy+'/grande.txt')).endsWith(y.project+'/fim\n'),'também quando o caminho cai entre duas leituras');
 // Whoever skips that step is refused rather than given something that breaks later.
 const w=await setup(t);await symlink(w.copy+'/src/a.js',w.copy+'/alias.js');const direct=await w.apply(await w.freeze('d'));assert.equal(direct.status,'conflict',JSON.stringify(direct));assert.deepEqual(direct.files,['alias.js']);assert.equal(await exists(w.project+'/alias.js'),false);
 const v=await setup(t);await writeFile(v.copy+'/config.txt','raiz='+v.copy+'\n');assert.equal((await v.apply(await v.freeze('d'))).status,'conflict');assert.equal(await exists(v.project+'/config.txt'),false);
 // A file of the project that only changed nothing is left alone, and the private path cannot match anything else.
 const z=await setup(t);assert.deepEqual(await prepareVersion({workspace:z.workspace}),{rewritten:[],problems:[]});
});

test('um .venv criado na cópia funciona no projeto depois de a cópia desaparecer',{skip:noBwrap||spawnSync('python3',['-m','venv','--help']).status!==0},async t=>{
 const x=await setup(t);execFileSync('python3',['-m','venv',x.copy+'/.venv']);
 const prepared=await prepareVersion({workspace:x.workspace});assert.ok(prepared.rewritten.length>0);assert.deepEqual(prepared.problems,[]);
 const tested=await x.freeze();assert.equal(testStatus(await runValidation({snapshot:tested.directory,cwd:x.copy,origin:x.project,command:'.venv/bin/pip --version'})),'passed');
 assert.equal((await x.apply(tested)).status,'applied');await removeWorkspace(x.root+'/privado');
 assert.match(execFileSync(x.project+'/.venv/bin/pip',['--version'],{encoding:'utf8'}),new RegExp(x.project.replaceAll('/','\\/')+'\\/\\.venv'));
});

test('valores da configuração que não são caminhos não rebentam a verificação',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hydra-workspace-git-'));t.after(async()=>{delete process.env.GIT_CONFIG_GLOBAL;await chmod(root+'/p/fechada',0o755).catch(()=>{});await removePrivate(root);});await mkdir(root+'/p');const cwd=root+'/p';git(cwd,'init','-q');
 git(cwd,'config','alias.grande','!f() { echo '+'x'.repeat(400)+'; }; f');await reservedState(cwd);
 await writeFile(root+'/g.cfg','[alias]\n\tglobal = !f() { echo '+'y'.repeat(400)+'; }; f\n');process.env.GIT_CONFIG_GLOBAL=root+'/g.cfg';await reservedState(cwd);
 await writeFile(cwd+'/package.json','{}');git(cwd,'config','alias.atravessa','!cat package.json/scripts');await reservedState(cwd);
 await mkdir(cwd+'/fechada');await chmod(cwd+'/fechada',0);git(cwd,'config','alias.fechada','!sh fechada/s.sh');await reservedState(cwd);
});

test('um valor da configuração nunca fica gravado em claro, e o caminho ausente continua protegido',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hydra-workspace-git-'));t.after(()=>removePrivate(root));git(root,'init','-q');
 const secret='eyJhbGciOiJIUzI1NiJ9.SEGREDO.assinatura';git(root,'config','http.extraHeader','Authorization: Bearer '+secret);git(root,'config','core.fsmonitor','./ferramentas/monitor.sh');git(root,'config','core.hooksPath','ganchos');
 const before=await reservedState(root);assert.doesNotMatch(JSON.stringify(before),/SEGREDO/);assert.doesNotMatch(JSON.stringify(before),/ferramentas/);
 for(const file of ['ferramentas/monitor.sh','ferramentas','ganchos','ganchos/pre-commit'])assert.equal(isReservedPath(file,before),true,file);for(const file of ['outra/monitor.sh','ferramentas-2','src/a.js'])assert.equal(isReservedPath(file,before),false,file);
 // Rotating the token is not a change to report, and no message can show it.
 git(root,'config','http.extraHeader','Authorization: Bearer outro.TOKEN.novo');const changes=reservedChanges(before,await reservedState(root));assert.deepEqual(changes,['.git/config','git config'],'só nomes de ficheiros, nunca o valor');
});

test('uma ligação criada pela tarefa no caminho de um programa do Git pede confirmação, e nomeia o programa',options,async t=>{
 const named=async({project})=>{git(project,'config','core.fsmonitor','./ferramentas/monitor.sh');};
 const x=await setup(t,named),marker=x.root+'/CORREU';await mkdir(x.copy+'/outra');await writeFile(x.copy+'/outra/monitor.sh',`#!/bin/sh\necho sim > '${marker}'\nprintf 'x\\0'\n`);await chmod(x.copy+'/outra/monitor.sh',0o755);await symlink('outra',x.copy+'/ferramentas');await prepareVersion({workspace:x.workspace});
 const tested=await x.freeze();let result=await x.apply(tested);assert.equal(result.status,'reserved',JSON.stringify(result));assert.deepEqual(result.files.sort(),['ferramentas','outra/monitor.sh']);
 assert.equal(await exists(x.project+'/ferramentas'),false);git(x.project,'status','--short');assert.equal(await exists(marker),false,'sem confirmação, nada corre');
 result=await x.apply(tested,{accepted:result.confirm});assert.equal(result.status,'applied',JSON.stringify(result));
 // The named link and its target, both new; the target is what runs, and confirming covers that content only.
 const y=await setup(t,async({project})=>{git(project,'config','core.fsmonitor','./monitor.sh');});await writeFile(y.copy+'/real.sh','1');await symlink('real.sh',y.copy+'/monitor.sh');const one=await y.freeze('1'),asked=await y.apply(one);assert.deepEqual(asked.files.sort(),['monitor.sh','real.sh']);
 await writeFile(y.copy+'/real.sh','2');const again=await y.apply(await y.freeze('2'),{accepted:asked.confirm});assert.equal(again.status,'reserved','outro programa volta a perguntar');assert.deepEqual(again.files,['real.sh']);
 // An absolute link, already given the project's path, leads to the same place.
 const z=await setup(t,named);await mkdir(z.copy+'/outra');await writeFile(z.copy+'/outra/monitor.sh','1');await symlink(z.copy+'/outra',z.copy+'/ferramentas');await prepareVersion({workspace:z.workspace});const abs=await z.apply(await z.freeze());assert.deepEqual(abs.files.sort(),['ferramentas','outra/monitor.sh']);
});

test('a confirmação do Git segue as novas ligações do projeto entre os segmentos restantes do caminho',options,async t=>{
 for(const previous of [false,true]){
  const x=await setup(t,async({project})=>{git(project,'config','core.fsmonitor','./ferramentas/monitor.sh');if(previous){await mkdir(project+'/antiga');await symlink('antiga',project+'/alias');}});
  if(previous)await rm(x.copy+'/alias');
  await mkdir(x.copy+'/programas/sub',{recursive:true});await writeFile(x.copy+'/programas/sub/monitor.sh','1');await symlink('meio',x.copy+'/alias');await symlink('programas',x.copy+'/meio');
  await symlink(x.project+'/./alias/sub',x.copy+'/ferramentas');await prepareVersion({workspace:x.workspace});
  const first=await x.apply(await x.freeze('1'));assert.equal(first.status,'reserved',JSON.stringify(first));assert.deepEqual(first.files.sort(),['alias','ferramentas','meio','programas/sub/monitor.sh']);
  await writeFile(x.copy+'/programas/sub/monitor.sh','2');const tested=await x.freeze('2'),second=await x.apply(tested,{accepted:first.confirm});assert.equal(second.status,'reserved','a confirmação da ligação não confirma outro conteúdo do programa');assert.deepEqual(second.files,['programas/sub/monitor.sh']);
  assert.equal((await x.apply(tested,{accepted:{...first.confirm,...second.confirm}})).status,'applied');
 }
});

test('uma ligação relativa que sai do projeto fica como está, e nunca aponta para a pasta privada',options,async t=>{
 const x=await setup(t,async({root})=>{await mkdir(root+'/vizinho');await writeFile(root+'/vizinho/lib.js','vizinho');});await mkdir(x.copy+'/sub');await symlink('../vizinho/lib.js',x.copy+'/ext.js');await symlink('../../vizinho/lib.js',x.copy+'/sub/ext.js');await symlink('../projeto/src/a.js',x.copy+'/volta.js');await symlink('circular',x.copy+'/circular');
 const prepared=await prepareVersion({workspace:x.workspace});assert.deepEqual(prepared.rewritten,['volta.js'],'só a que sai e volta a entrar');assert.deepEqual(prepared.problems,[]);
 const result=await x.apply(await x.freeze());assert.equal(result.status,'applied',JSON.stringify(result));await removeWorkspace(x.root+'/privado');
 assert.equal(await readlink(x.project+'/ext.js'),'../vizinho/lib.js');assert.equal(await read(x.project+'/ext.js'),'vizinho');assert.equal(await read(x.project+'/sub/ext.js'),'vizinho');assert.equal(await read(x.project+'/volta.js'),'1\n');
});

test('o caminho da cópia escrito de outra forma num texto não chega ao projeto',options,async t=>{
 for(const spell of [x=>path.dirname(x.copy)+'/./'+path.basename(x.copy)+'/src',x=>path.dirname(x.copy)+'//'+path.basename(x.copy)]){
  const x=await setup(t);await writeFile(x.copy+'/config.txt','raiz='+spell(x)+'\n');const prepared=await prepareVersion({workspace:x.workspace});assert.deepEqual(prepared.problems,['config.txt']);
  const result=await x.apply(await x.freeze());assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(await exists(x.project+'/config.txt'),false);
 }
 // With .. nothing can tell by the path, but the task's identifier in the folder's name gives it away.
 const root=await mkdtemp(path.join(os.tmpdir(),'hydra-workspace-')),project=root+'/projeto',id='3f2a1b4c-0000-4000-8000-1234567890ab';t.after(()=>removePrivate(root));await mkdir(project);await writeFile(project+'/a.txt','1');
 const workspace=await createWorkspace({project,folder:root+'/'+id});await writeFile(workspace.copy+'/config.txt',`raiz=${root}/outra/../${id}/projeto\n`);assert.deepEqual((await prepareVersion({workspace})).problems,['config.txt']);
 // The exact path in the same file still gets rewritten, and the other spelling is reported.
 const y=await setup(t);await writeFile(y.copy+'/misto.txt',`a=${y.copy}\nb=${path.dirname(y.copy)}/./projeto\n`);const both=await prepareVersion({workspace:y.workspace});assert.deepEqual(both.problems,['misto.txt']);assert.ok((await read(y.copy+'/misto.txt')).startsWith('a='+y.project+'\n'));
});

test('remover a pasta privada não mexe no histórico do projeto real',options,async t=>{
 const x=await setup(t);const object=execFileSync('find',[x.project+'/.git/objects','-type','f'],{encoding:'utf8'}).split('\n')[0];assert.ok((await lstat(object)).nlink>=2,'o histórico é partilhado, não copiado');
 const mode=(await lstat(object)).mode;await removeWorkspace(x.root+'/privado');assert.equal(await exists(x.root+'/privado'),false);assert.equal((await lstat(object)).mode,mode);assert.equal((await lstat(object)).nlink,1);git(x.project,'log','--oneline');
});

test('apagar conserva uma edição pelo descritor antigo até ao fim da passagem',options,async t=>{
 const x=await setup(t);await rm(x.copy+'/src/apagar.js');await writeFile(x.copy+'/src/a.js','2\n');x.tested=await x.freeze();
 const handle=await open(x.project+'/src/apagar.js','r+');t.after(()=>handle.close());
 const result=await hold(x,'linked',async()=>{assert.equal(await exists(x.project+'/src/apagar.js'),false);await handle.write('EDIÇÃO TUA',0);await handle.sync();});
 assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(result.partial,true);assert.equal(await read(result.kept),'EDIÇÃO TUA');assert.equal(await exists(x.journal+'/plano.json'),true);
 const retry=await x.apply(x.tested);assert.equal(retry.status,'conflict');assert.equal(await read(result.kept),'EDIÇÃO TUA','retomar também conserva a edição');
});

test('desfazer conserva a edição num ficheiro novo que está a ser retirado',options,async t=>{
 const x=await setup(t);await writeFile(x.copy+'/src/a.js','2\n');await writeFile(x.copy+'/novo-com-nome-longo.js','novo\n');await writeFile(x.copy+'/outro-com-nome-mais-longo.js','outro\n');
 const tested=await x.freeze();assert.equal((await x.apply(tested,{environment:{HYDRAQ_APPLY_STOP_AFTER:2}})).status,'failed');
 const handle=await open(x.project+'/novo-com-nome-longo.js','r+');t.after(()=>handle.close());
 const running=undoApplication({workspace:x.workspace,environment:{HYDRAQ_APPLY_STOP_MODE:'rollback',HYDRAQ_APPLY_HOLD_AT:'linked'}});
 for(const end=Date.now()+20000;!await exists(x.journal+'/parado');await new Promise(r=>setTimeout(r,10)))if(Date.now()>end)throw Error('O escritor não chegou ao desfazer');
 assert.equal(await exists(x.project+'/novo-com-nome-longo.js'),false);await handle.write('EDIÇÃO TUA',0);await handle.sync();await writeFile(x.journal+'/continua','');
 const result=await running;assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(await read(result.kept),'EDIÇÃO TUA');assert.equal(await exists(x.journal+'/plano.json'),true);
});

test('a reserva de um apagamento não bloqueia trocar uma pasta por ficheiro nem recuperar essa troca',options,async t=>{
 const x=await setup(t,async({project})=>{await mkdir(project+'/pasta');await writeFile(project+'/pasta/f.js','antes\n');});
 const handle=await open(x.project+'/pasta/f.js','r+');t.after(()=>handle.close());await rm(x.copy+'/pasta',{recursive:true});await writeFile(x.copy+'/pasta','depois\n');x.tested=await x.freeze();
 const result=await hold(x,'linked',async()=>{assert.equal(await read(x.project+'/pasta'),'depois\n');await handle.write('EDIÇÃO TUA',0);await handle.sync();});
 assert.equal(result.status,'conflict',JSON.stringify(result));assert.equal(await read(result.kept),'EDIÇÃO TUA');
 // After the user has saved that edit and resolved the conflict, the old folder can still be recovered.
 await writeFile(result.kept,'antes\n');assert.equal((await undoApplication({workspace:x.workspace})).status,'undone');assert.equal(await read(x.project+'/pasta/f.js'),'antes\n');
});

test('Git protege o destino ausente e todos os elos de uma ligação, incluindo pastas de hooks',options,async t=>{
 const x=await setup(t,async({project})=>{await mkdir(project+'/scripts');await mkdir(project+'/elos');await symlink('elos/segundo',project+'/monitor.sh');await symlink('../scripts/real.sh',project+'/elos/segundo');git(project,'config','core.fsmonitor','./monitor.sh');});
 const before=await reservedState(x.project);assert.equal(isReservedPath('scripts/real.sh',before),true);assert.match(before['monitor.sh'],/:link:/);assert.match(before['elos/segundo'],/:link:/);
 await writeFile(x.copy+'/scripts/real.sh','#!/bin/sh\n');await chmod(x.copy+'/scripts/real.sh',0o755);const tested=await x.freeze();
 const result=await x.apply(tested);assert.equal(result.status,'reserved',JSON.stringify(result));assert.deepEqual(result.files,['scripts/real.sh']);assert.equal(await exists(x.project+'/scripts/real.sh'),false);
 assert.equal((await x.apply(tested,{accepted:result.confirm})).status,'applied');
 // An alias in the project remains protected even when its old target is outside: changing it enables a new program.
 const z=await setup(t,async({project})=>{await symlink('/usr/bin/true',project+'/monitor.sh');git(project,'config','core.fsmonitor','./monitor.sh');});
 await rm(z.copy+'/monitor.sh');await symlink('novo.sh',z.copy+'/monitor.sh');await writeFile(z.copy+'/novo.sh','#!/bin/sh\n');
 const retargeted=await z.apply(await z.freeze());assert.equal(retargeted.status,'reserved',JSON.stringify(retargeted));assert.ok(retargeted.files.includes('monitor.sh'));
 for(const useConfig of [false,true]){
  const y=await setup(t,async({project})=>{await symlink('hooks-ainda-a-criar',project+'/atalho-hooks');if(useConfig)git(project,'config','core.hooksPath','./atalho-hooks');else{await rm(project+'/.git/hooks',{recursive:true});await symlink('../atalho-hooks',project+'/.git/hooks');}});
  await mkdir(y.copy+'/hooks-ainda-a-criar');await writeFile(y.copy+'/hooks-ainda-a-criar/pre-commit','#!/bin/sh\n');
  const asked=await y.apply(await y.freeze());assert.equal(asked.status,'reserved',JSON.stringify(asked));assert.deepEqual(asked.files,['hooks-ainda-a-criar/pre-commit']);
 }
});

test('ligações equivalentes à cópia são preparadas antes dos testes e funcionam depois da limpeza',options,async t=>{
 const x=await setup(t);await symlink(x.copy,x.root+'/alias-exterior');
 const links={ponto:x.root+'/privado/./projeto/src/a.js',relativo:'../../privado/projeto/src/a.js',alias:x.root+'/alias-exterior/src/a.js',futuro:x.root+'/privado/./projeto/novo.js'};
 for(const [name,target] of Object.entries(links))await symlink(target,x.copy+'/'+name);
 await writeFile(x.copy+'/novo.js','novo\n');const prepared=await prepareVersion({workspace:x.workspace});assert.deepEqual(prepared.problems,[]);assert.deepEqual(prepared.rewritten.sort(),Object.keys(links).sort());
 const command='cat ponto relativo alias futuro',tested=await x.freeze(),validation=await runValidation({snapshot:tested.directory,cwd:x.copy,origin:x.project,command});assert.equal(testStatus(validation),'passed',validation.output);
 assert.equal((await x.apply(tested)).status,'applied');await removeWorkspace(x.workspace.folder);assert.equal(execFileSync('/bin/sh',['-c',command],{cwd:x.project,encoding:'utf8'}),'1\n1\n1\nnovo\n');
});

test('saltar a preparação não deixa aplicar uma ligação equivalente ao caminho privado',options,async t=>{
 for(const target of [x=>x.root+'/privado/./projeto/src/a.js',x=>'../../privado/projeto/src/a.js',x=>x.root+'/alias-exterior/src/a.js']){
  const x=await setup(t);await symlink(x.copy,x.root+'/alias-exterior');await symlink(target(x),x.copy+'/atalho');const result=await x.apply(await x.freeze());
  assert.equal(result.status,'conflict',JSON.stringify(result));assert.deepEqual(result.files,['atalho']);assert.equal(await exists(x.project+'/atalho'),false);
 }
});

test('resolver caminhos segue os elos antes de .., conserva destinos ausentes e recusa ciclos',async t=>{
 const root=await mkdtemp('/tmp/hydra-path-');t.after(()=>removePrivate(root));await mkdir(root+'/real/fundo',{recursive:true});await symlink('real/fundo',root+'/atalho');
 assert.equal(await resolveNamedPath('atalho/../novo.js',root),root+'/real/novo.js');await symlink('atalho/../ainda/falta.js',root+'/pendente');
 assert.equal(await resolveNamedPath(root+'/pendente'),root+'/real/ainda/falta.js');
 await symlink('ciclo-b',root+'/ciclo-a');await symlink('ciclo-a',root+'/ciclo-b');await assert.rejects(resolveNamedPath(root+'/ciclo-a'),{code:'ELOOP'});
 git(root,'init','-q');git(root,'config','core.fsmonitor','./ciclo-a');await assert.rejects(reservedState(root),{code:'ELOOP'});
});

test('um diário antigo recupera as reservas antigas e continua sem bloquear a troca de pasta por ficheiro',options,async t=>{
 for(const undo of [false,true]){
  const x=await setup(t,async({project})=>{await mkdir(project+'/pasta');await writeFile(project+'/pasta/f.js','antes\n');});await rm(x.copy+'/pasta',{recursive:true});await writeFile(x.copy+'/pasta','depois\n');const tested=await x.freeze();
  assert.equal((await x.apply(tested,{environment:{HYDRAQ_APPLY_STOP_AFTER:0}})).status,'failed');
  const file=x.journal+'/plano.json',plan=JSON.parse(await read(file));delete plan.rootAsides;await writeFile(file,JSON.stringify(plan));
  const index=plan.changes.findIndex(change=>change.file==='pasta/f.js');assert.notEqual(index,-1);const target=x.project+'/pasta/f.js',old=path.join(path.dirname(target),`.hydraq-aplicar-${plan.token}-${index}-antes`);await rename(target,old);
  if(undo){
   assert.equal((await x.apply(tested,{environment:{HYDRAQ_APPLY_STOP_AT:'linked'}})).status,'failed');assert.equal(JSON.parse(await read(file)).rootAsides,true);
   assert.equal((await undoApplication({workspace:x.workspace})).status,'undone');assert.equal(await read(x.project+'/pasta/f.js'),'antes\n');
  }else{assert.equal((await x.apply(tested)).status,'applied');assert.equal(await read(x.project+'/pasta'),'depois\n');}
 }
});

test('uma ligação que passa pela cópia antes de chegar ao exterior também funciona depois da limpeza',options,async t=>{
 const x=await setup(t);await symlink('/usr/bin/true',x.copy+'/comando-base');
 const links={absoluto:x.root+'/privado/./projeto/comando-base',parentes:x.copy+'/'+path.relative(x.copy,'/usr/bin/true')};
 for(const [name,target] of Object.entries(links))await symlink(target,x.copy+'/'+name);await symlink('comando-base',x.copy+'/relativo');
 const blocked=await x.apply(await x.freeze());assert.equal(blocked.status,'conflict');assert.deepEqual(blocked.files.sort(),Object.keys(links).sort());
 const prepared=await prepareVersion({workspace:x.workspace});assert.deepEqual(prepared.problems,[]);assert.deepEqual(prepared.rewritten.sort(),Object.keys(links).sort());assert.equal(await readlink(x.copy+'/relativo'),'comando-base','um link relativo dentro do projeto vale em qualquer sítio');
 const tested=await x.freeze(),command='./absoluto && ./relativo && ./parentes';assert.equal(testStatus(await runValidation({snapshot:tested.directory,cwd:x.copy,origin:x.project,command})),'passed');
 assert.equal((await x.apply(tested)).status,'applied');await removeWorkspace(x.workspace.folder);execFileSync('/bin/sh',['-c',command],{cwd:x.project});
});

test('uma ligação relativa que sai e volta à cópia antes de chegar ao exterior é preparada e vigiada',options,async t=>{
 const x=await setup(t);await symlink('/usr/bin/true',x.copy+'/comando-base');await symlink(x.copy,x.root+'/alias-exterior');await mkdir(x.copy+'/pasta');
 const links={relativo:'../../privado/projeto/comando-base',alias:'../../alias-exterior/comando-base',parentes:'pasta/../../../privado/projeto/comando-base'};
 for(const [name,target] of Object.entries(links))await symlink(target,x.copy+'/'+name);
 const blocked=await x.apply(await x.freeze('antes'));assert.equal(blocked.status,'conflict',JSON.stringify(blocked));assert.deepEqual(blocked.files.sort(),Object.keys(links).sort());
 const prepared=await prepareVersion({workspace:x.workspace});assert.deepEqual(prepared.problems,[]);assert.deepEqual(prepared.rewritten.sort(),Object.keys(links).sort());
 const tested=await x.freeze('depois'),command='./relativo && ./alias && ./parentes';assert.equal(testStatus(await runValidation({snapshot:tested.directory,cwd:x.copy,origin:x.project,command})),'passed');
 assert.equal((await x.apply(tested)).status,'applied');await removeWorkspace(x.workspace.folder);execFileSync('/bin/sh',['-c',command],{cwd:x.project});
});
