import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {decodeArtifacts} from '../lib/hydra-test-artifacts.mjs';
import {validationSnapshot,runValidation,testStatus,removePrivate} from '../lib/hydra-validation.mjs';
import {noBwrap} from './fixtures/sandbox.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5j8AAAAASUVORK5CYII=';
const writeImage=`node -e 'require("fs").writeFileSync(process.env.HYDRAQ_TEST_ARTIFACTS+"/frame.png",Buffer.from("${png}","base64"))'`;
async function setup(t){const root=await mkdtemp('/tmp/hydra-artifacts-'),cwd=root+'/project';t.after(()=>removePrivate(root));await mkdir(cwd);await writeFile(cwd+'/index.html','<body><h1>Render real</h1><script>document.body.dataset.ran="yes"</script>');return {cwd,snapshot:(await validationSnapshot(cwd,root+'/private')).directory};}

test('transporte aceita imagens reais e recusa nomes, conteúdo e quantidades inválidos',()=>{
 const raw=files=>JSON.stringify({files});
 const image=decodeArtifacts(raw([{name:'frame.png',data:png}]))[0];assert.equal(image.width,1);assert.equal(image.mimeType,'image/png');
 for(const files of [[{name:'../escape.png',data:png}],[{name:'arquivo.svg',data:Buffer.from('<svg/>').toString('base64')}],Array.from({length:17},(_,i)=>({name:i+'.png',data:png})),[{name:'same.png',data:png},{name:'same.png',data:png}]])assert.throws(()=>decodeArtifacts(raw(files)));
});
test('capturas saem do tmpfs antes da limpeza sem alterar o código; falhas conservam a imagem',{skip:noBwrap},async t=>{
 const x=await setup(t);const r=await runValidation({...x,capture:true,command:writeImage+'; test 1 = 2'});
 assert.equal(testStatus(r),'failed');assert.equal(r.exitCode,1);assert.equal(r.artifacts[0].name,'frame.png');assert.deepEqual(r.artifacts[0].bytes,Buffer.from(png,'base64'));assert.equal(r.sourceChanged,false);
 assert.match(await readFile(x.cwd+'/index.html','utf8'),/Render real/);
 const empty=await runValidation({...x,capture:true,command:'test -f index.html'});assert.equal(testStatus(empty),'failed');assert.match(empty.error,/não produziu imagens/);
});
test('capturas recusam links, hard links, pastas, texto e ficheiros grandes',{skip:noBwrap},async t=>{
 const x=await setup(t);
 for(const command of [
  'ln -s "$PWD/index.html" "$HYDRAQ_TEST_ARTIFACTS/link.png"',
  writeImage+'; ln "$HYDRAQ_TEST_ARTIFACTS/frame.png" "$HYDRAQ_TEST_ARTIFACTS/link.png"',
  'mkdir "$HYDRAQ_TEST_ARTIFACTS/dir"',
  'printf texto > "$HYDRAQ_TEST_ARTIFACTS/falso.png"',
  'truncate -s 6000000 "$HYDRAQ_TEST_ARTIFACTS/grande.png"',
 ]){const r=await runValidation({...x,capture:true,command});assert.equal(testStatus(r),'failed',command);assert.match(r.error,/Capturas indisponíveis/);assert.ok(!r.artifacts?.length);}
});
test('quota é imposta durante a escrita; timeout e cancelamento não certificam capturas',{skip:noBwrap},async t=>{
 const x=await setup(t);
 const r=await runValidation({...x,capture:true,command:'dd if=/dev/zero of="$HYDRAQ_TEST_ARTIFACTS/grande.png" bs=1048576 count=40'});assert.notEqual(r.exitCode,0);assert.match(r.output,/No space left/);assert.equal(testStatus(r),'failed');
 const timed=await runValidation({...x,capture:true,command:writeImage+'; sleep 20',timeoutMs:250});assert.equal(testStatus(timed),'timedOut');assert.equal(timed.artifacts,undefined);
 const controller=new AbortController();const pending=runValidation({...x,capture:true,command:'sleep 20',signal:controller.signal});setTimeout(()=>controller.abort(),250);assert.equal(testStatus(await pending),'interrupted');
});
test('Chrome renderiza e captura dentro do isolamento; só localhost é acessível',{skip:noBwrap||(!existsSync('/usr/bin/google-chrome')&&'Chrome indisponível')},async t=>{
 const x=await setup(t);const r=await runValidation({...x,capture:true,command:'google-chrome --headless=new --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/chrome --screenshot="$HYDRAQ_TEST_ARTIFACTS/browser.png" --window-size=640,480 "file://$PWD/index.html"'});
 assert.equal(testStatus(r),'passed',r.output+' '+r.error);assert.equal(r.artifacts[0].width,640);assert.equal(r.artifacts[0].height,480);
 const net=await runValidation({...x,command:`python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); socket.create_connection(s.getsockname(),1); blocked=False\ntry: socket.create_connection(("1.1.1.1",443),1)\nexcept OSError: blocked=True\nassert blocked'`});assert.equal(testStatus(net),'passed',net.output);
});
