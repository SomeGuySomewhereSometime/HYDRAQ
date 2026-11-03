import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link,access,chmod,stat,statfs,readdir,truncate,utimes} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {certifiedEntries,validationSnapshot,runValidation,sourceFingerprint,environmentRecord,removePrivate,testStatus,testCommandProblem,validationProblem,overlaps,currentVersion,sameVersion,hardLinkedFiles,reservedState,reservedChanges} from '../lib/hydra-validation.mjs';
import {noBwrap} from './fixtures/sandbox.mjs';

const exists=file=>access(file).then(()=>true,()=>false);
const has=tool=>spawnSync('sh',['-c','command -v '+tool]).status===0;
async function project(t,{git=false,home=false}={}){
 const base=await mkdtemp(home?path.join(os.homedir(),'.hydraq-tests-'):path.join(os.tmpdir(),'hydraq-validation-')),cwd=path.join(base,'project'),directory=path.join(base,'private');
 t.after(()=>removePrivate(base));await mkdir(cwd);
 if(git){execFileSync('git',['init','-q'],{cwd});await writeFile(cwd+'/.gitignore','node_modules\nignorado.txt\n');}
 return {base,cwd,directory};
}
const commit=cwd=>{execFileSync('git',['add','-A'],{cwd});execFileSync('git',['-c','user.name=t','-c','user.email=t@t','commit','-qm','x'],{cwd});};
const freeze=async x=>validationSnapshot(x.cwd,x.directory);
const options={skip:noBwrap};

test('num repositório, certifica o que o Git segue ou seguiria e nada do que ignora',async t=>{
 const x=await project(t,{git:true});
 await mkdir(x.cwd+'/dist');await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await mkdir(x.cwd+'/__pycache__');
 await writeFile(x.cwd+'/dist/seguido.js','1');commit(x.cwd);
 await writeFile(x.cwd+'/novo.txt','1');await writeFile(x.cwd+'/ignorado.txt','1');await writeFile(x.cwd+'/node_modules/dep/index.js','1');await writeFile(x.cwd+'/__pycache__/a.pyc','1');await mkdir(x.cwd+'/build');await writeFile(x.cwd+'/build/b.js','1');await writeFile(x.cwd+'/.env','K=1');
 const before=await sourceFingerprint(x.cwd);
 for(const generated of ['ignorado.txt','node_modules/dep/index.js','__pycache__/a.pyc','build/b.js','.env']){await writeFile(path.join(x.cwd,generated),'2');assert.equal(await sourceFingerprint(x.cwd),before,generated);}
 for(const [source,content] of [['novo.txt','2'],['dist/seguido.js','2'],['.gitignore','node_modules\n']]){await writeFile(path.join(x.cwd,source),content);assert.notEqual(await sourceFingerprint(x.cwd),before,source);await sourceFingerprint(x.cwd);}
});

test('sem Git, exclui dependências e artefactos conhecidos e deteta permissões e ligações',async t=>{
 const x=await project(t);await mkdir(x.cwd+'/src');await mkdir(x.cwd+'/node_modules');await writeFile(x.cwd+'/src/a.js','1');await writeFile(x.cwd+'/node_modules/d.js','1');await symlink('a.js',x.cwd+'/src/l');
 let hash=await sourceFingerprint(x.cwd);
 await writeFile(x.cwd+'/node_modules/d.js','2');assert.equal(await sourceFingerprint(x.cwd),hash);
 await chmod(x.cwd+'/src/a.js',0o755);const executable=await sourceFingerprint(x.cwd);assert.notEqual(executable,hash);
 await rm(x.cwd+'/src/l');await symlink('b.js',x.cwd+'/src/l');assert.notEqual(await sourceFingerprint(x.cwd),executable);
});

test('um ficheiro enorme que não é código certificado não impede a validação',options,async t=>{
 const x=await project(t);await mkdir(x.cwd+'/node_modules');await writeFile(x.cwd+'/a.txt','1');
 await writeFile(x.cwd+'/node_modules/enorme.bin','');await truncate(x.cwd+'/node_modules/enorme.bin',700*1024*1024);
 const frozen=await freeze(x);assert.equal(frozen.files,1);
 const r=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'test -s node_modules/enorme.bin'});assert.equal(r.exitCode,0,r.output);
 await writeFile(x.cwd+'/grande.bin','');await truncate(x.cwd+'/grande.bin',600*1024*1024);
 assert.equal(typeof await sourceFingerprint(x.cwd),'string','o tamanho do código, por si só, não recusa nada');
});

test('Python correto não falha: caches e artefactos do teste não contam como alterar o código',{skip:noBwrap||(has('python3')?false:'sem python3')},async t=>{
 const x=await project(t);await writeFile(x.cwd+'/mod.py','VALUE=1\n');await writeFile(x.cwd+'/test_mod.py','import mod\ndef test_value():\n    assert mod.VALUE==1\n');
 execFileSync('python3',['-c','import mod'],{cwd:x.cwd});assert.ok(await exists(x.cwd+'/__pycache__'));
 if(spawnSync('python3',['-m','pytest','--version']).status===0)execFileSync('python3',['-m','pytest','-q'],{cwd:x.cwd,stdio:'ignore'});
 const frozen=await freeze(x);
 for(const command of ['python3 -c "import mod; print(mod.VALUE)"','mkdir -p dist; echo 1 > dist/a.js; python3 -m compileall -q .'].concat(spawnSync('python3',['-m','pytest','--version']).status===0?['python3 -m pytest -q']:[])){
  const r=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
  assert.equal(r.exitCode,0,r.output);assert.equal(r.sourceChanged,false,command+' '+r.changedFiles);assert.equal(testStatus(r),'passed');
 }
 assert.equal(await exists(x.cwd+'/novo.txt'),false,'nada chega ao projeto');
});

test('alterar, apagar ou recriar código certificado invalida o teste e nomeia os ficheiros',options,async t=>{
 const x=await project(t);await mkdir(x.cwd+'/sub');await writeFile(x.cwd+'/a.txt','v1');await writeFile(x.cwd+'/sub/b.txt','v1');await writeFile(x.cwd+'/sub/c.txt','v1');await writeFile(x.cwd+'/x.sh','v1');await symlink('a.txt',x.cwd+'/l');
 const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
 for(const [command,changed] of [['echo fake > a.txt',['a.txt']],['rm a.txt',['a.txt']],['rm -rf sub; mkdir sub; echo v1 > sub/c.txt',['sub/b.txt','sub/c.txt']],['chmod +x x.sh',['x.sh']],['rm l; ln -s x.sh l',['l']]]){
  const r=await run(command);assert.equal(r.exitCode,0,r.output);assert.equal(r.sourceChanged,true,command);assert.deepEqual(r.changedFiles.filter(f=>changed.includes(f)),changed,command);assert.equal(testStatus(r),'failed');assert.match(r.error,new RegExp(changed[0].replace('.','\\.')));
 }
 assert.equal(await readFile(x.cwd+'/a.txt','utf8'),'v1','o projeto fica intacto');assert.equal((await run('true')).sourceChanged,false,'um teste não contamina o seguinte');
});

test('a versão fica congelada: uma alteração externa não chega ao teste',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','v1');const frozen=await freeze(x);await mkdir(x.base+'/sinal');
 const running=runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'cat a.txt; sleep 1; cat a.txt; echo; test ! -e removido'});
 await new Promise(r=>setTimeout(r,300));await writeFile(x.cwd+'/a.txt','v2');
 const r=await running;assert.equal(r.output.trim(),'v1v1');assert.equal(r.sourceChanged,false);
 assert.notEqual(await sourceFingerprint(x.cwd),frozen.hash,'o fim da ronda deteta a alteração');
});

test('o teste vê .git e dependências; não vê .env, .hydraq, a home nem a rede',options,async t=>{
 const x=await project(t,{git:true,home:true});await mkdir(x.cwd+'/.hydraq');await writeFile(x.cwd+'/.hydraq/state','segredo');await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await writeFile(x.cwd+'/node_modules/dep/i.js','dep');
 await writeFile(x.cwd+'/a.txt','v1');commit(x.cwd);await writeFile(x.cwd+'/.env','K=segredo');await writeFile(x.cwd+'/.env.local','K=segredo');await writeFile(x.cwd+'/.env.example','K=exemplo');await mkdir(x.cwd+'/sub');await writeFile(x.cwd+'/sub/.env','K=segredo');
 const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
 const r=await run('cat .env .env.local sub/.env; cat .env.example; cat node_modules/dep/i.js; git log --oneline | wc -l; git status --short | wc -l; ls -A .hydraq | wc -l; echo "HOME=$HOME"; ls -A "'+os.homedir()+'" | grep -c hydraq-tests');
 assert.equal(r.exitCode,0,r.output);assert.doesNotMatch(r.output,/segredo/);assert.match(r.output,/K=exemplo/);assert.match(r.output,/dep/);assert.match(r.output,/\n1\n/);assert.match(r.output,/HOME=\/tmp/);assert.equal(r.sourceChanged,false);
  assert.equal((await run('test ! -e "'+os.homedir()+'/.ssh"')).exitCode,0,'home escondida');
 const add=await run('git add a.txt; git -c user.name=t -c user.email=t@t commit -qm y --allow-empty; git log --oneline | wc -l');assert.equal(add.exitCode,0,add.output);assert.match(add.output,/2/);assert.equal(execFileSync('git',['log','--oneline'],{cwd:x.cwd,encoding:'utf8'}).trim().split('\n').length,1,'o commit fica na vista descartável');
});

test('ferramentas do utilizador disponíveis, incluindo o npm do Node em uso',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/package.json',JSON.stringify({name:'x',private:true,scripts:{test:'node --test'}}));await writeFile(x.cwd+'/a.test.mjs',"import t from 'node:test';t('ok',()=>{});\n");
 const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
 const npm=await run('npm test');assert.equal(npm.exitCode,0,npm.output);assert.equal(testStatus(npm),'passed');
 assert.equal(testStatus(await run('ferramenta-que-nao-existe')),'environment');
 assert.equal(testStatus(await run('exit 1')),'failed');assert.equal(testStatus(await run('grep -q nada package.json')),'failed');
});

test('saída longa guarda o início e o resumo final',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','1');const frozen=await freeze(x);
 const r=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'echo INICIO; for i in $(seq 1 9000); do echo "linha $i ........"; done; echo RESUMO_FINAL; exit 1'});
 assert.equal(r.truncated,true);assert.match(r.output,/^INICIO/);assert.match(r.output,/RESUMO_FINAL/);assert.match(r.output,/caracteres omitidos/);assert.ok(r.output.length<33000);
 const short=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'echo curto'});assert.equal(short.truncated,false);assert.equal(short.output,'curto\n');
});

test('tempo esgotado e cancelamento param o teste de imediato',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','1');const frozen=await freeze(x);
 const slow=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'sleep 30',timeoutMs:300});assert.equal(slow.timedOut,true);assert.equal(testStatus(slow),'timedOut');
 const controller=new AbortController(),start=Date.now(),running=runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'sleep 30',signal:controller.signal});
 setTimeout(()=>controller.abort(),100);const stopped=await running;assert.equal(stopped.aborted,true);assert.ok(Date.now()-start<5000);assert.equal(testStatus(stopped),'interrupted');
 const early=new AbortController();early.abort();await assert.rejects(runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'sleep 30',signal:early.signal}));
 assert.deepEqual((await readdir(path.dirname(frozen.directory))).filter(name=>name.startsWith('check-')),[],'sem restos');
});

test('FIFO, socket ou ficheiro especial no projeto não impedem a validação',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','1');execFileSync('mkfifo',[x.cwd+'/canal']);
 const frozen=await freeze(x);assert.equal(frozen.files,1);assert.equal((await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'test -p canal'})).exitCode,0);
});

test('registo do ambiente separa dependências de restantes ficheiros',async t=>{
 const x=await project(t);await mkdir(x.cwd+'/node_modules/.cache',{recursive:true});await writeFile(x.cwd+'/a.txt','1');await writeFile(x.cwd+'/node_modules/d.js','1');await writeFile(x.cwd+'/node_modules/.cache/c','1');await writeFile(x.cwd+'/log.txt','1');await writeFile(x.cwd+'/.env','K');
 const entries={'a.txt':'x'},first=await environmentRecord(x.cwd,entries);assert.deepEqual(Object.keys(first).sort(),['dependencies','other']);
 await writeFile(x.cwd+'/node_modules/.cache/c','22');const cached=await environmentRecord(x.cwd,entries);assert.equal(cached.dependencies,first.dependencies,'a cache não conta como dependência');assert.equal(cached.other,first.other,'nem como outro ficheiro');
 await writeFile(x.cwd+'/log.txt','22');const log=await environmentRecord(x.cwd,entries);assert.equal(log.dependencies,first.dependencies);assert.notEqual(log.other,first.other);
 await writeFile(x.cwd+'/node_modules/d.js','22');assert.notEqual((await environmentRecord(x.cwd,entries)).dependencies,first.dependencies);
});

test('verificação prévia ensaia a sério e explica o que falta',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','1');
 assert.equal(await validationProblem(x.cwd,x.directory),null);assert.equal(await exists(x.directory+'/preflight'),false);
 assert.match(await validationProblem(x.cwd,x.cwd+'/.hydraq/validation'),/fora do projeto/);
 await mkdir(x.directory,{recursive:true});const room=await statfs(x.directory);await writeFile(x.cwd+'/grande.bin','');await truncate(x.cwd+'/grande.bin',Number(room.bavail)*Number(room.bsize)+2e9);assert.match(await validationProblem(x.cwd,x.directory),/espaço em disco/);
});

test('sobreposição de pastas e limpeza de pastas privadas com overlay',async t=>{
 assert.equal(overlaps('/a/b','/a'),true);assert.equal(overlaps('/a','/a/b'),true);assert.equal(overlaps('/a','/a'),true);assert.equal(overlaps('/a/b','/a/bc'),false);
 const x=await project(t);await mkdir(x.base+'/w/work',{recursive:true});await writeFile(x.base+'/w/f','1');await chmod(x.base+'/w/work',0);await removePrivate(x.base+'/w');assert.equal(await exists(x.base+'/w'),false);
});

// Reported by the independent review of batches 1.1 to 4.
const reachable=async(run,port)=>run(`node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('LIGOU');process.exit(0)}).on('error',e=>{console.log('ERRO',e.code);process.exit(1)})"`);
test('sem rede nos testes, com um controlo que prova que o comando chega ao servidor fora da vista',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','1');const frozen=await freeze(x),server=createServer((q,s)=>s.end('ok'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const port=server.address().port,command=`require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('LIGOU');process.exit(0)}).on('error',e=>{console.log('ERRO',e.code);process.exit(1)})`;
 const control=spawnSync(process.execPath,['-e',command],{encoding:'utf8'});assert.match(control.stdout,/LIGOU/,'fora da vista liga');
 const r=await reachable(c=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command:c}),port);assert.notEqual(r.exitCode,0,r.output);assert.match(r.output,/ERRO E[A-Z]+/);assert.doesNotMatch(r.output,/LIGOU/);
});

test('um teste que altera dependências, cria código ou apaga ficheiros usados não certifica',options,async t=>{
 const x=await project(t,{git:true});await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await writeFile(x.cwd+'/node_modules/dep/index.js','module.exports=2;');await writeFile(x.cwd+'/node_modules/dep/outro.js','1');await mkdir(x.cwd+'/node_modules/.pnpm/dep@1/node_modules/dep',{recursive:true});await writeFile(x.cwd+'/node_modules/.pnpm/dep@1/node_modules/dep/index.js','1');await mkdir(x.cwd+'/node_modules/.bin');await writeFile(x.cwd+'/node_modules/.bin/tool','1');
 await writeFile(x.cwd+'/main.cjs',"const assert=require('assert'),fs=require('fs');assert.equal(fs.existsSync('./override.cjs')?require('./override.cjs'):require('dep'),3);\n");
 const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
 assert.equal(testStatus(await run('node main.cjs')),'failed','o código tem o defeito');
 for(const [command,file] of [["echo 'module.exports=3;' > node_modules/dep/index.js; node main.cjs",'node_modules/dep/index.js'],["echo 'module.exports=3;' > override.cjs; node main.cjs",'override.cjs'],['echo novo > node_modules/dep/novo.js','node_modules/dep/novo.js'],['rm node_modules/dep/outro.js','node_modules/dep/outro.js'],['echo 2 > node_modules/.pnpm/dep@1/node_modules/dep/index.js','node_modules/.pnpm/dep@1/node_modules/dep/index.js'],['echo 2 > node_modules/.bin/tool','node_modules/.bin/tool'],['mkdir -p src/out; echo x > src/out/override.cjs','src/out/override.cjs'],['mkdir -p src/build; echo x > src/build/conftest.py','src/build/conftest.py'],['rm -rf node_modules/dep; mkdir node_modules/dep; echo x > node_modules/dep/index.js','node_modules/dep/outro.js']]){
  const r=await run(command);assert.equal(r.exitCode,0,command+' '+r.output);assert.equal(r.sourceChanged,true,command);assert.ok(r.changedFiles.includes(file),command+' '+r.changedFiles);assert.equal(testStatus(r),'failed',command);assert.match(r.error,new RegExp(file.replaceAll('.','\\.')));
 }
 assert.equal(await readFile(x.cwd+'/node_modules/dep/index.js','utf8'),'module.exports=2;','o projeto fica intacto');
});

test('caches, builds do próprio teste e ficheiros ignorados continuam permitidos',options,async t=>{
 for(const git of [true,false]){
  const x=await project(t,{git});await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await mkdir(x.cwd+'/dist');await writeFile(x.cwd+'/node_modules/dep/index.js','1');await writeFile(x.cwd+'/dist/velho.js','1');await writeFile(x.cwd+'/a.txt','1');
  const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
  const allowed=['mkdir -p __pycache__ node_modules/.cache node_modules/.vite target/debug coverage; echo 1 > __pycache__/a.pyc; echo 1 > node_modules/.cache/c; echo 1 > node_modules/.vite/v; echo 1 > dist/velho.js; echo 1 > dist/novo.js; rm dist/velho.js; echo 1 > target/debug/x; echo 1 > coverage/l; echo 1 > .coverage; echo 1 > .env; mkdir -p .hydraq; echo 1 > /tmp/fora','cp node_modules/dep/index.js /tmp/c; cp /tmp/c node_modules/dep/index.js'];
  if(git)allowed.push('echo 1 > ignorado.txt; git status --short; git add -A; git -c user.name=t -c user.email=t@t commit -qm y');
  for(const command of allowed){const r=await run(command);assert.equal(r.exitCode,0,command+' '+r.output);assert.equal(r.sourceChanged,false,command+' '+r.changedFiles);assert.equal(testStatus(r),'passed',command);}
 }
});

test('o que o projeto gera e ignora pode ser reescrito por um teste, e fica registado',options,async t=>{
 const x=await project(t,{git:true});await writeFile(x.cwd+'/.gitignore','node_modules\nlog/\ntmp/\n*.sqlite3\nbin/\ngenerated/\njunit.xml\n');
 for(const file of ['log/test.log','tmp/cache/x','db/test.sqlite3','bin/Debug/app.dll','generated/client.js','junit.xml']){await mkdir(path.dirname(path.join(x.cwd,file)),{recursive:true});await writeFile(path.join(x.cwd,file),'1');}
 const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
 for(const [command,file] of [['echo mais >> log/test.log','log/test.log'],['rm -rf tmp/cache','tmp/cache'],['echo mais >> db/test.sqlite3','db/test.sqlite3'],['echo novo > bin/Debug/app.dll','bin/Debug/app.dll'],['echo novo > generated/client.js','generated/client.js'],['echo novo > junit.xml','junit.xml'],['mkdir -p tmp; echo novo > tmp/novo.js','tmp/novo.js']]){
  const r=await run(command);assert.equal(r.exitCode,0,command+' '+r.output);assert.equal(r.sourceChanged,false,command+' '+r.changedFiles);assert.equal(testStatus(r),'passed',command);assert.ok(r.outputFiles.includes(file),command+' '+r.outputFiles);
 }
 assert.equal(await readFile(x.cwd+'/log/test.log','utf8'),'1','nada chega ao projeto');
});

test('resultados comuns são permitidos num projeto que ainda não os ignora; código e configuração novos não',options,async t=>{
 for(const git of [true,false]){
  const x=await project(t,{git});await writeFile(x.cwd+'/a.txt','1');const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
  for(const command of ['echo x > coverage.xml','echo x > junit.xml','echo x > tsconfig.tsbuildinfo','mkdir -p bin/Debug; echo x > bin/Debug/a.json','mkdir -p logs; echo x > logs/a.log','mkdir -p src/test-results; echo x > src/test-results/r.json','echo x > CMakeCache.txt']){const r=await run(command);assert.equal(r.sourceChanged,false,command+' '+r.changedFiles);assert.equal(testStatus(r),'passed',command);}
  for(const [command,file] of [['echo x > override.cjs','override.cjs'],['echo x > conftest.py','conftest.py'],['echo x > tsconfig.json','tsconfig.json'],['echo x > .npmrc','.npmrc']]){const r=await run(command);assert.equal(r.sourceChanged,true,command);assert.ok(r.changedFiles.includes(file));assert.match(r.error,/\.gitignore/);}
 }
});

test('código em pastas com nomes comuns faz parte da versão; só na raiz esses nomes são caches ou builds',async t=>{
 const code=['src/Logs/logger.js','Assets/Scripts/Library/Foo.cs','src/coverage/report.js','app/obj/model.py','Assets/Temp/x.cs','src/build/gen.js','src/out/a.js','lib/target/b.js','src/vendor/c.js','src/venv/d.js','logs/logger.js','src/logs/x.js','src/tmp/y.js'];
 for(const git of [true,false]){
  const x=await project(t,{git});await writeFile(x.cwd+'/a.txt','1');
  for(const file of code){
   await mkdir(path.dirname(path.join(x.cwd,file)),{recursive:true});const before=await sourceFingerprint(x.cwd);await writeFile(path.join(x.cwd,file),'v1');const added=await sourceFingerprint(x.cwd);assert.notEqual(added,before,file);
   await writeFile(path.join(x.cwd,file),'v2');assert.notEqual(await sourceFingerprint(x.cwd),added,file);
  }
  const before=await sourceFingerprint(x.cwd);
  for(const file of ['Logs/a.log','Library/a','Temp/a','obj/a','coverage/a','build/a','dist/a','target/a','out/a','output/a','vendor/a','venv/a','src/__pycache__/a.pyc','src/node_modules/d/a','src/.venv/a','src/.cache/a']){await mkdir(path.dirname(path.join(x.cwd,file)),{recursive:true});await writeFile(path.join(x.cwd,file),'1');assert.equal(await sourceFingerprint(x.cwd),before,file);}
 }
});

test('uma ligação certificada traz o destino para a versão',options,async t=>{
 const x=await project(t,{git:true});await mkdir(x.cwd+'/build');await writeFile(x.cwd+'/build/value.txt','OLD');await symlink('build/value.txt',x.cwd+'/source.txt');await symlink('b',x.cwd+'/a');await symlink('a',x.cwd+'/b');await symlink('.',x.cwd+'/raiz');
 const frozen=await freeze(x),before=await currentVersion(x.cwd),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
 await writeFile(x.cwd+'/build/value.txt','NEW');
 const seen=await run('cat source.txt');assert.equal(seen.output,'OLD','o teste vê o valor congelado');assert.equal(seen.sourceChanged,false);
 assert.notEqual(await sourceFingerprint(x.cwd),frozen.hash);assert.equal(sameVersion(before,await currentVersion(x.cwd)),false);
 assert.equal((await run('echo fake > build/value.txt')).sourceChanged,true,'o destino passa a ser certificado');
});

test('uma ligação para fora do projeto conta para a versão',async t=>{
 const x=await project(t);await writeFile(x.base+'/fora.txt','1');await writeFile(x.cwd+'/a.txt','1');await symlink(x.base+'/fora.txt',x.cwd+'/fora');
 const before=await currentVersion(x.cwd);await writeFile(x.base+'/fora.txt','22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),false);
});

test('ficheiros privados ficam escondidos a qualquer profundidade e sem limite de quantidade',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','1');await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await mkdir(x.cwd+'/sub/.hydraq',{recursive:true});await writeFile(x.cwd+'/node_modules/dep/.env','SEGREDO');await writeFile(x.cwd+'/sub/.hydraq/state','SEGREDO');await writeFile(x.cwd+'/node_modules/dep/.env.example','K=exemplo');
 for(let i=0;i<250;i++){await mkdir(x.cwd+'/muitos/'+i,{recursive:true});await writeFile(x.cwd+'/muitos/'+i+'/.env','SEGREDO');}
 const frozen=await freeze(x),run=command=>runValidation({snapshot:frozen.directory,cwd:x.cwd,command});
 await writeFile(x.cwd+'/.env','SEGREDO');
 const r=await run('cat node_modules/dep/.env sub/.hydraq/state .env muitos/*/.env 2>&1 || :; cat node_modules/dep/.env.example');assert.doesNotMatch(r.output,/SEGREDO/,'nem o que apareceu depois de congelar');assert.match(r.output,/K=exemplo/);assert.equal(r.sourceChanged,false);
 assert.equal(await readFile(x.cwd+'/node_modules/dep/.env','utf8'),'SEGREDO','o original fica intacto');
});

test('.envrc e semelhantes ficam escondidos; modelos de .env continuam visíveis',options,async t=>{
 const x=await project(t);await writeFile(x.cwd+'/a.txt','1');for(const name of ['.envrc','.env_prod','.env-local','.env.production'])await writeFile(x.cwd+'/'+name,'SEGREDO');for(const name of ['.env.example','.env.sample','.env.template','.environment'])await writeFile(x.cwd+'/'+name,'K=modelo '+name);
 const frozen=await freeze(x),r=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:'cat .envrc .env_prod .env-local .env.production; cat .env.example .env.sample .env.template .environment'});
 assert.doesNotMatch(r.output,/SEGREDO/);for(const name of ['.env.example','.env.sample','.env.template','.environment'])assert.match(r.output,new RegExp('modelo '+name.replace('.','\\.')));
});

test('o que os programas correm conta para a versão, mesmo sendo gerado; os testes podem reescrevê-lo',options,async t=>{
 const files=['node_modules/.prisma/client/index.js','node_modules/.vite/deps/x.js','.tox/env/lib/plugin.cjs','.nox/env/plugin.cjs','.next/server/x.js','.dart_tool/package_config.json'];
 for(const git of [true,false]){
  const x=await project(t,{git});await writeFile(x.cwd+'/a.txt','1');
  for(const file of files){await mkdir(path.dirname(path.join(x.cwd,file)),{recursive:true});await writeFile(path.join(x.cwd,file),'1');}
  if(git){await writeFile(x.cwd+'/.gitignore','node_modules\n.tox\n.nox\n.next\n.dart_tool\n');commit(x.cwd);}
  for(const file of files){const before=await currentVersion(x.cwd);await writeFile(path.join(x.cwd,file),'22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),false,file+(git?' com Git':' sem Git'));}
  const frozen=await freeze(x),r=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:files.map(file=>`echo 3 > ${file}`).join(';')});
  assert.equal(r.exitCode,0);assert.equal(r.sourceChanged,false,'um teste pode gerar o cliente ou recriar o ambiente: '+r.changedFiles);assert.equal(await readFile(x.cwd+'/'+files[0],'utf8'),'22','o original fica intacto');
 }
});

test('os testes de Python não correm caches deixadas no projeto, que nenhuma revisão vê',{skip:noBwrap||!has('python3')},async t=>{
 const x=await project(t),moment=new Date('2020-01-01T00:00:00Z');
 await writeFile(x.cwd+'/m.py','v=2\n');await utimes(x.cwd+'/m.py',moment,moment);execFileSync('python3',['-m','compileall','-q','m.py'],{cwd:x.cwd});
 await writeFile(x.cwd+'/m.py','v=1\n');await utimes(x.cwd+'/m.py',moment,moment);
 const program='import m;print("v="+str(m.v))';
 assert.match(execFileSync('python3',['-c',program],{cwd:x.cwd,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}),/v=2/,'fora do executor, o Python confia na cache');
 const frozen=await freeze(x),r=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:`python3 -c '${program}'`});assert.match(r.output,/v=1/);assert.equal(testStatus(r),'passed');
});

test('um teste não alcança um serviço com socket no projeto ou nas dependências',options,async t=>{
 const x=await project(t),hits=[];await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await writeFile(x.cwd+'/a.txt','1');
 const servers=[];for(const file of ['servico.sock','node_modules/dep/s.sock']){const server=createNetServer(s=>s.on('data',()=>{hits.push(file);s.end();}));await new Promise(r=>server.listen(path.join(x.cwd,file),r));servers.push(server);}
 t.after(()=>Promise.all(servers.map(server=>new Promise(r=>server.close(r)))));
 const frozen=await freeze(x),connect=file=>`node -e "const s=require('net').connect('${file}',()=>{s.end('x');console.log('LIGOU')});s.on('error',e=>console.log('ERRO',e.code))"`;
 const r=await runValidation({snapshot:frozen.directory,cwd:x.cwd,command:connect('servico.sock')+';'+connect('node_modules/dep/s.sock')});
 assert.doesNotMatch(r.output,/LIGOU/);assert.equal((r.output.match(/ERRO/g)||[]).length,2,r.output);await new Promise(r=>setTimeout(r,100));assert.deepEqual(hits,[]);
});

test('uma dependência alterada conta mesmo com o tamanho e a data repostos',async t=>{
 const x=await project(t),moment=new Date('2020-01-01T00:00:00Z');await mkdir(x.cwd+'/node_modules/dep',{recursive:true});await writeFile(x.cwd+'/node_modules/dep/i.cjs','module.exports=1;');await utimes(x.cwd+'/node_modules/dep/i.cjs',moment,moment);
 const before=await currentVersion(x.cwd);await new Promise(r=>setTimeout(r,5));await writeFile(x.cwd+'/node_modules/dep/i.cjs','module.exports=2;');await utimes(x.cwd+'/node_modules/dep/i.cjs',moment,moment);assert.equal(sameVersion(before,await currentVersion(x.cwd)),false);
});

test('uma pasta exterior ligada conta pelos ficheiros que tem, por mais ligações que atravesse',async t=>{
 const x=await project(t),outside=x.base+'/partilhada',further=x.base+'/mais-longe';await mkdir(outside+'/lib/__pycache__',{recursive:true});await mkdir(further);await writeFile(outside+'/lib/index.cjs','1');await writeFile(outside+'/lib/__pycache__/i.pyc','1');await writeFile(outside+'/lib/app.log','1');await writeFile(further+'/f.cjs','1');
 await symlink(further,outside+'/lib/mais');await symlink(outside,outside+'/lib/ciclo');await writeFile(x.cwd+'/a.txt','1');await symlink(outside,x.cwd+'/lib');
 const before=await currentVersion(x.cwd);
 for(const file of [outside+'/lib/__pycache__/i.pyc',outside+'/lib/app.log']){await writeFile(file,'22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),true,'cache e registos: '+file);}
 for(const file of [outside+'/lib/index.cjs',further+'/f.cjs',outside+'/lib/novo.cjs']){const was=await readFile(file,'utf8').catch(()=>null);await writeFile(file,'22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),false,file);if(was===null)await rm(file);else{await writeFile(file,was);}}
 await assert.rejects(environmentRecord(x.cwd,{},1),/demasiados para validar/,'grande demais recusa, em vez de ver só uma parte');
});

test('um editor aberto ou um programa a correr não mudam a versão',async t=>{
 for(const file of ['.idea/workspace.xml','.vs/x/v17/.suo','.vscode/x.json','UserSettings/Layouts/d.dwlt','logs/app.log','logs/app.log.1','tmp/cache/x','src/tmp/pids/s.pid','server.log','db/dev.sqlite3','db/dev.sqlite3-wal','.foo.py.swp','nohup.out','node_modules/.cache/x.js','Assets/x.blend1'])for(const mode of ['ignorado','por ignorar','sem Git']){
  const x=await project(t,{git:mode!=='sem Git'});if(mode==='ignorado')await writeFile(x.cwd+'/.gitignore',file.split('/')[0]+'\n'+path.basename(file)+'\n');else if(mode==='por ignorar')await writeFile(x.cwd+'/.gitignore','');await writeFile(x.cwd+'/a.txt','1');await mkdir(path.dirname(path.join(x.cwd,file)),{recursive:true});await writeFile(path.join(x.cwd,file),'1');
  const before=await currentVersion(x.cwd);await new Promise(r=>setTimeout(r,5));await writeFile(path.join(x.cwd,file),'22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),true,file+' '+mode);
 }
 // What tests may read still counts.
 for(const file of ['build/b.js','output/r.json','config.local.js','generated/client.js','.tox/env/plugin.js','.next/server/x.js','legado.pyc']){
  const x=await project(t,{git:true});await writeFile(x.cwd+'/.gitignore',file.split('/')[0]+'\n');await writeFile(x.cwd+'/a.txt','1');await mkdir(path.dirname(path.join(x.cwd,file)),{recursive:true});await writeFile(path.join(x.cwd,file),'1');
  const before=await currentVersion(x.cwd);await writeFile(path.join(x.cwd,file),'22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),false,file);
 }
});

test('a versão inclui dependências e ficheiros ignorados que contam, não as caches',async t=>{
 const x=await project(t);for(const folder of ['node_modules/.cache','__pycache__','Library','build'])await mkdir(x.cwd+'/'+folder,{recursive:true});
 for(const file of ['a.txt','node_modules/d.js','node_modules/.cache/c','__pycache__/a.pyc','Library/l','build/b.js'])await writeFile(x.cwd+'/'+file,'1');
 const before=await currentVersion(x.cwd);assert.equal(sameVersion(before,before),true);assert.equal('partial' in before,false);
 for(const cache of ['node_modules/.cache/c','__pycache__/a.pyc','Library/l']){await writeFile(x.cwd+'/'+cache,'22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),true,cache);}
 assert.equal(sameVersion(before,{...before,runtime:'outro'}),false);assert.equal(sameVersion(before,{...before,other:'outro'}),false);assert.equal(sameVersion(before,{...before,dependencies:'outro'}),false);
 await writeFile(x.cwd+'/build/b.js','22');assert.equal(sameVersion(before,await currentVersion(x.cwd)),false,'build');
});

test('os comandos Git do coordenador não executam programas configurados no repositório',async t=>{
 const x=await project(t,{git:true}),marker=x.base+'/marcador';await writeFile(x.cwd+'/a.txt','1');await writeFile(x.base+'/monitor.sh',`#!/bin/sh\necho x > '${marker}'\n`);await chmod(x.base+'/monitor.sh',0o700);
 execFileSync('git',['config','core.fsmonitor',x.base+'/monitor.sh'],{cwd:x.cwd});execFileSync('git',['config','core.untrackedCache','true'],{cwd:x.cwd});commit(x.cwd);await rm(marker,{force:true});
 await sourceFingerprint(x.cwd);assert.equal(await exists(marker),false);
});

test('identifica ficheiros ligados a outros fora do projeto; pares internos e dependências não contam',async t=>{
 const x=await project(t);await writeFile(x.base+'/fora.txt','1');await link(x.base+'/fora.txt',x.cwd+'/alias.txt');await writeFile(x.cwd+'/a.txt','1');await link(x.cwd+'/a.txt',x.cwd+'/b.txt');await mkdir(x.cwd+'/node_modules');await writeFile(x.base+'/loja.js','1');await link(x.base+'/loja.js',x.cwd+'/node_modules/d.js');
 assert.deepEqual(await hardLinkedFiles(x.cwd),['alias.txt']);assert.deepEqual(await hardLinkedFiles(x.cwd+'/nao-existe'),[]);
});

test('alterações a .git e .hydraq são detetadas a qualquer profundidade, mesmo quando não existiam',async t=>{
 const x=await project(t);await mkdir(x.cwd+'/.git/hooks',{recursive:true});await mkdir(x.cwd+'/.git/objects',{recursive:true});await writeFile(x.cwd+'/.git/config','1');await writeFile(x.cwd+'/.git/HEAD','1');await mkdir(x.cwd+'/sub/.git',{recursive:true});await writeFile(x.cwd+'/sub/.git/config','1');await mkdir(x.cwd+'/dados/.hydraq',{recursive:true});await writeFile(x.cwd+'/dados/.hydraq/a','1');
 const before=await reservedState(x.cwd,x.cwd+'/dados/.hydraq');const same=async()=>reservedChanges(before,await reservedState(x.cwd,x.cwd+'/dados/.hydraq'));
 await writeFile(x.cwd+'/.git/HEAD','2');await writeFile(x.cwd+'/.git/objects/o','1');await writeFile(x.cwd+'/dados/.hydraq/a','2');assert.deepEqual(await same(),[],'histórico e dados da própria HYDRAQ não contam');
 await writeFile(x.cwd+'/.git/hooks/pre-commit','x');assert.ok((await same()).includes('.git/hooks/pre-commit'));await rm(x.cwd+'/.git/hooks/pre-commit');
 await writeFile(x.cwd+'/sub/.git/config','2');assert.ok((await same()).includes('sub/.git/config'));await writeFile(x.cwd+'/sub/.git/config','1');
 await mkdir(x.cwd+'/novo/.git',{recursive:true});await writeFile(x.cwd+'/novo/.git/config','x');assert.ok((await same()).includes('novo/.git/config'));await rm(x.cwd+'/novo',{recursive:true});
 await mkdir(x.cwd+'/novo/.hydraq',{recursive:true});await writeFile(x.cwd+'/novo/.hydraq/x','x');assert.ok((await same()).includes('novo/.hydraq/x'));await rm(x.cwd+'/novo',{recursive:true});
 assert.deepEqual(await same(),[]);
});

test('a configuração efetiva do Git é vigiada: ligações, includes, hooks ligados e programas configurados',async t=>{
 const changes=async(x,before)=>reservedChanges(before,await reservedState(x.cwd));
 // .git/config is a link to a file of the project.
 let x=await project(t,{git:true});await writeFile(x.cwd+'/git-config',await readFile(x.cwd+'/.git/config'));await rm(x.cwd+'/.git/config');await symlink('../git-config',x.cwd+'/.git/config');
 let before=await reservedState(x.cwd);assert.deepEqual(await changes(x,before),[]);await writeFile(x.cwd+'/git-config','[audit]\nvalue=NEW\n',{flag:'a'});let found=await changes(x,before);assert.ok(found.includes('git config'),found.join());assert.ok(found.includes('git-config'),found.join());
 // Through an include, also with an equal value in another form.
 x=await project(t,{git:true});execFileSync('git',['config','include.path','../incluido.cfg'],{cwd:x.cwd});await writeFile(x.cwd+'/incluido.cfg','[audit]\nvalue=OLD\n');
 before=await reservedState(x.cwd);await writeFile(x.cwd+'/incluido.cfg','[audit]\nvalue=NEW\n');found=await changes(x,before);assert.ok(found.includes('git config')&&found.includes('incluido.cfg'),found.join());
 await writeFile(x.cwd+'/incluido.cfg','[audit]\n\tvalue = OLD\n');found=await changes(x,before);assert.deepEqual(found,['incluido.cfg'],'o ficheiro mudou mesmo com o valor igual');
 // A hook that is a link, and a hooks folder that is a link: the content is what runs.
 x=await project(t,{git:true});await mkdir(x.cwd+'/scripts');await writeFile(x.cwd+'/scripts/h.sh','1');await symlink('../../scripts/h.sh',x.cwd+'/.git/hooks/pre-commit');
 before=await reservedState(x.cwd);await writeFile(x.cwd+'/scripts/h.sh','2');assert.ok((await changes(x,before)).includes('scripts/h.sh'));
 x=await project(t,{git:true});await rm(x.cwd+'/.git/hooks',{recursive:true});await mkdir(x.cwd+'/ganchos');await writeFile(x.cwd+'/ganchos/pre-commit','1');await symlink('../ganchos',x.cwd+'/.git/hooks');
 before=await reservedState(x.cwd);await writeFile(x.cwd+'/ganchos/pre-commit','2');assert.ok((await changes(x,before)).includes('ganchos/pre-commit'));await writeFile(x.cwd+'/ganchos/novo','1');assert.ok((await changes(x,before)).includes('ganchos/novo'));
 // core.hooksPath outside the project.
 x=await project(t,{git:true});await mkdir(x.base+'/ganchos');await writeFile(x.base+'/ganchos/pre-commit','1');execFileSync('git',['config','core.hooksPath',x.base+'/ganchos'],{cwd:x.cwd});
 before=await reservedState(x.cwd);await writeFile(x.base+'/ganchos/pre-commit','2');assert.ok((await changes(x,before)).includes(x.base+'/ganchos/pre-commit'));
 // A program named in the settings, even one Git ignores, and an alias.
 x=await project(t,{git:true});await writeFile(x.cwd+'/.gitignore','monitor.sh\n');await writeFile(x.cwd+'/monitor.sh','1');await writeFile(x.cwd+'/alias.sh','1');await writeFile(x.cwd+'/a.txt','1');execFileSync('git',['config','core.fsmonitor','./monitor.sh'],{cwd:x.cwd});execFileSync('git',['config','alias.st','!sh alias.sh --x'],{cwd:x.cwd});execFileSync('git',['config','core.editor','node'],{cwd:x.cwd});await mkdir(x.cwd+'/src');await writeFile(x.cwd+'/src/f.js','1');execFileSync('git',['config','alias.lista','!ls src'],{cwd:x.cwd});
 before=await reservedState(x.cwd);await writeFile(x.cwd+'/a.txt','2');await writeFile(x.cwd+'/src/f.js','2');assert.deepEqual(await changes(x,before),[],'o resto do projeto não conta, nem uma pasta que um alias refira');
 await writeFile(x.cwd+'/monitor.sh','2');assert.ok((await changes(x,before)).includes('monitor.sh'));await writeFile(x.cwd+'/alias.sh','2');assert.ok((await changes(x,before)).includes('alias.sh'));
 // A nested repository is read the same way, and a broken configuration is itself a change.
 x=await project(t,{git:true});await mkdir(x.cwd+'/sub');execFileSync('git',['init','-q'],{cwd:x.cwd+'/sub'});execFileSync('git',['config','include.path','../inc.cfg'],{cwd:x.cwd+'/sub'});await writeFile(x.cwd+'/sub/inc.cfg','[a]\nb=1\n');
 before=await reservedState(x.cwd);await writeFile(x.cwd+'/sub/inc.cfg','[a]\nb=2\n');found=await changes(x,before);assert.ok(found.includes('sub/git config')&&found.includes('sub/inc.cfg'),found.join());
 x=await project(t,{git:true});before=await reservedState(x.cwd);await writeFile(x.cwd+'/.git/config','[quebrado');assert.ok((await changes(x,before)).includes('git config'));
 // A loop of links ends.
 x=await project(t,{git:true});await symlink('..',x.cwd+'/.git/hooks/volta');await reservedState(x.cwd);
});

test('alterações reservadas também em core.hooksPath, submódulos e worktrees; o histórico deles não conta',async t=>{
 const x=await project(t,{git:true});execFileSync('git',['config','core.hooksPath','.husky/_'],{cwd:x.cwd});await mkdir(x.cwd+'/.husky/_',{recursive:true});await writeFile(x.cwd+'/.husky/_/pre-commit','1');
 for(const file of ['sub/.git/config','sub/.git/config.worktree','sub/.git/modules/m/config','sub/.git/modules/m/hooks/post-checkout','sub/.git/modules/grupo/n/hooks/post-checkout','sub/.git/worktrees/w/config.worktree','sub/.git/worktrees/w/gitdir','sub/.git/modules/m/objects/o','sub/.git/modules/m/HEAD']){await mkdir(path.dirname(path.join(x.cwd,file)),{recursive:true});await writeFile(path.join(x.cwd,file),'1');}
 const before=await reservedState(x.cwd);
 for(const file of ['.husky/_/pre-commit','sub/.git/config.worktree','sub/.git/modules/m/config','sub/.git/modules/m/hooks/post-checkout','sub/.git/modules/grupo/n/hooks/post-checkout','sub/.git/worktrees/w/config.worktree','sub/.git/worktrees/w/gitdir']){await writeFile(path.join(x.cwd,file),'2');assert.ok(reservedChanges(before,await reservedState(x.cwd)).includes(file),file);await writeFile(path.join(x.cwd,file),'1');}
 for(const file of ['sub/.git/modules/m/objects/o','sub/.git/modules/m/HEAD']){await writeFile(path.join(x.cwd,file),'2');}assert.deepEqual(reservedChanges(before,await reservedState(x.cwd)),[]);
});

test('pasta seguida pelo Git trocada por ligação: nada de fora entra na versão nem no diff',options,async t=>{
 const x=await project(t);await mkdir(x.cwd+'/src');await mkdir(x.base+'/fora');await writeFile(x.base+'/fora/config','SEGREDO-DE-FORA\n');await writeFile(x.cwd+'/src/config','normal\n');
 execFileSync('git',['init','-q'],{cwd:x.cwd});execFileSync('git',['add','.'],{cwd:x.cwd});
 await rm(x.cwd+'/src',{recursive:true});await symlink(x.base+'/fora',x.cwd+'/src');
 const entries=await certifiedEntries(x.cwd);assert.equal(entries['src/config'],undefined);assert.match(entries.src,/:link:/);
 const frozen=await freeze(x);assert.doesNotMatch(await readFile(frozen.directory+'.json','utf8'),/src\/config/);
});

test('listas AND seguidas de outros comandos não podem mascarar uma falha',()=>{
 for(const command of [
  'test "$(cat value.txt)" = ERRADO && echo confirmado; echo terminou',
  'npm test && echo passou\necho terminou',
  'npm test && # resultado\necho passou; echo terminou',
  'false && echo passou || echo terminou',
  'npm test && echo passou &',
  '(false; echo passou) && test -f value.txt',
  'cd .; if npm test; then echo ok; else echo falhou; fi',
 ])assert.ok(testCommandProblem(command),command);
 for(const command of [
  'npm test && pytest',
  'cd app && npm test && pytest',
  'cd app; npm test && pytest',
  'npm test; pytest',
  'test -f value.txt 2>&1 | cat; echo terminou',
  'echo "a && b; c"; test -f value.txt',
  'npm test # && echo ok; echo terminou',
  'if ! npm test; then exit 1; fi',
 ])assert.equal(testCommandProblem(command),null,command);
});

test('shells dentro do comando, wait, trap e ! a meio não escondem falhas',async()=>{
 const {testCommandProblem}=await import('../lib/hydra-validation.mjs');
 for(const command of ["bash -lc 'test 1 = 2; echo terminou'","bash -c 'npm test | tail -5'","bash -c 'set -e; npm test | tail -5'","bash -lc 'test 1 = 2 && echo a; echo terminou'","sh -c 'npm test'","/bin/dash -c 'npm test'","eval 'npm test || :'","npm test & wait","trap 'exit 0' EXIT; npm test","! test 1 = 1; echo terminou","timeout 60 bash -c 'npm test || true'","env CI=1 bash -c \"set +e; npm test\"","bash -c \"bash -c 'npm test || :'\""])
  assert.ok(testCommandProblem(command),command);
 // The project's own scripts and plain nested chains keep working.
 for(const command of ["bash -lc 'set -eo pipefail; npm test | tail; echo fim'","bash -lc 'set -e; npm test; echo fim'","timeout 120 bash -lc \"cd app && npm test\"","npm run build & sleep 1; curl -sf localhost:1 >/dev/null; wait $!","! grep -q ERRO saida.log","bash scripts/test.sh","sh scripts/test.sh","eval \"$(echo npm test)\""])
  assert.equal(testCommandProblem(command),null,command);
});

test('opções longas e separadas do shell não dispensam a verificação do script',()=>{
 for(const command of [
  "bash --noprofile --norc -c 'test 1 = 2; echo terminou'",
  "bash -l -c 'test 1 = 2; echo terminou'",
  "bash -c -l 'test 1 = 2; echo terminou'",
  "bash -lc -- 'test 1 = 2; echo terminou'",
  "bash --noprofile -c -l 'test 1 = 2; echo terminou'",
  "bash --posix -l -c 'false; echo terminou'",
  "'/bin/bash' --norc -c 'false; echo terminou'",
  "bash --rcfile /dev/null -c 'false; echo terminou'",
  "bash -e +e -c 'false; echo terminou'",
  "bash -e -o pipefail +o pipefail -c 'false | cat'",
  "bash --opcao-desconhecida -c 'false; echo terminou'",
  'bash -c "$SCRIPT"',
  "sh -e -c 'test -f value.txt'",
  "bash -l -c 'set -e; false | cat'",
  "bash --norc -c 'bash -l -c \"false; echo terminou\"'",
 ])assert.ok(testCommandProblem(command),command);
 for(const command of [
  "bash --noprofile --norc -c 'test -f value.txt'",
  "bash -l -c 'test -f value.txt && test -d .'",
  "bash -e -o pipefail -c 'test -f value.txt; test -d .'",
  "bash -c -e -o pipefail -- 'test -f value.txt; test -d .'",
  "bash -o pipefail -ec 'test -f value.txt | cat'",
  "bash --norc -c 'set -eo pipefail; test -f value.txt | cat'",
  "bash -- scripts/test.sh",
  "bash -e scripts/test.sh",
  "sh scripts/test.sh",
 ])assert.equal(testCommandProblem(command),null,command);
});

test('um shell que lê o script da entrada não esconde falhas; um ficheiro de script continua aceite',async()=>{
 const {testCommandProblem}=await import('../lib/hydra-validation.mjs');
 for(const command of ["bash <<'EOF'\ntest 1 = 2\necho terminou\nEOF","printf 'test 1 = 2\\necho t\\n' | bash","echo 'npm test' | sh","bash -s <<< 'test 1 = 2; echo terminou'","bash < script.sh","curl -s x | bash -s -- --flag","timeout 60 bash <<'EOF'\nnpm test\nEOF"])
  assert.match(testCommandProblem(command)||'',/lê o script da entrada/,command);
 for(const command of ["bash scripts/test.sh","bash -x scripts/test.sh arg","bash scripts/test.sh < input.txt","bash scripts/test.sh > out.log 2>&1","bash -- scripts/test.sh","sh scripts/test.sh","bash -c 'npm test' < /dev/null","bash --version"])
  assert.equal(testCommandProblem(command),null,command);
});

test('o separador -- só identifica um script quando existe um argumento de ficheiro',()=>{
 for(const shell of ['bash','sh','/bin/bash']){
  for(const suffix of [''," <<'EOF'\ntest 1 = 2\necho terminou\nEOF"," <<< 'test 1 = 2; echo terminou'",' < script.sh',' 3< input.txt > out.log',' <input.txt >out.log'])
   assert.match(testCommandProblem(shell+' --'+suffix)||'',/lê o script da entrada/,shell+' --'+suffix);
  assert.match(testCommandProblem("printf 'test 1 = 2\\necho terminou\\n' | "+shell+' --')||'',/lê o script da entrada/);
  for(const suffix of [' scripts/test.sh',' < input.txt scripts/test.sh',' >out.log scripts/test.sh',' --version'])
   assert.equal(testCommandProblem(shell+' --'+suffix),null,shell+' --'+suffix);
 }
});
