import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GroqDictation, inspectAudio, MAX_AUDIO_BYTES } from '../lib/dictation.mjs';
import { createHttpServer } from '../lib/http.mjs';
const audio = Buffer.from('RIFF0000WAVEfixture');

test('ditado envia Whisper V3 em português uma vez sem persistir áudio ou expor a chave', async () => {
  let calls = 0;
  const service = new GroqDictation({env:{GROQ_API_KEY:'private-test'},fetchImpl:async (url, options) => {
    calls++; assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization,'Bearer private-test');
    assert.equal(options.body.get('model'),'whisper-large-v3'); assert.equal(options.body.get('language'),'pt');
    assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()),audio);
    return Response.json({text:'  Olá HYDRAQ.  '});
  }});
  assert.deepEqual(await service.transcribe(audio,'audio/wav'),{text:'Olá HYDRAQ.',model:'whisper-large-v3'});
  assert.equal(calls,1); assert.ok(!JSON.stringify(service.status()).includes('private-test'));
});

test('erros upstream são saneados, quota não repete e falha liberta exclusão', async () => {
  for (const [status,expected] of [[429,429],[401,503],[500,502]]) {
    let calls=0;
    const service=new GroqDictation({env:{GROQ_API_KEY:'secret'},fetchImpl:async()=>{calls++;return new Response('secret upstream',{status});}});
    await assert.rejects(service.transcribe(audio,'audio/wav'),e=>e.status===expected&&!e.message.includes('secret'));
    assert.equal(calls,1); assert.equal(service.busy,false);
  }
  const service=new GroqDictation({env:{},fetchImpl:()=>assert.fail('não deve contactar Groq')});
  await assert.rejects(service.transcribe(audio,'audio/wav'),e=>e.status===503);
});

test('rejeita áudio falso, vazio, grande e transcrição vazia; impede concorrência', async () => {
  assert.throws(()=>inspectAudio(Buffer.from('text'),'audio/webm'),e=>e.status===415);
  assert.throws(()=>inspectAudio(Buffer.alloc(0),'audio/wav'),/vazia/);
  assert.throws(()=>inspectAudio(Buffer.alloc(MAX_AUDIO_BYTES+1),'audio/wav'),e=>e.status===413);
  let release; const gate=new Promise(r=>release=r);
  const service=new GroqDictation({env:{GROQ_API_KEY:'test'},fetchImpl:async()=>{await gate;return Response.json({text:''});}});
  const first=service.transcribe(audio,'audio/wav');
  await assert.rejects(service.transcribe(audio,'audio/wav'),e=>e.status===409);
  release(); await assert.rejects(first,e=>e.status===422); assert.equal(service.busy,false);
});

test('HTTP exige token e origem, serve módulo e envia áudio sem criar conversa', async t => {
  const hub=new EventEmitter(); hub.snapshot=()=>({}); let calls=0;
  const service=new GroqDictation({env:{GROQ_API_KEY:'secret'},fetchImpl:async()=>{calls++;return Response.json({text:'Ditado.'});}});
  const server=createHttpServer({hydraq:hub,publicDir:new URL('../public',import.meta.url).pathname,dictation:service});
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/dictation')).status,403);
  const {token}=await(await fetch(base+'/api/bootstrap',{headers:{'X-HYDRAQ-Bootstrap':'1'}})).json();
  const headers={'x-hydraq-token':token,'content-type':'audio/wav'};
  assert.equal((await fetch(base+'/api/dictation',{method:'POST',headers:{...headers,origin:'https://other.example'},body:audio})).status,403);
  const status=await(await fetch(base+'/api/dictation',{headers})).json();assert.equal(status.available,true);assert.ok(!JSON.stringify(status).includes('secret'));
  const result=await fetch(base+'/api/dictation',{method:'POST',headers,body:audio});assert.equal(result.status,200);assert.equal((await result.json()).text,'Ditado.');assert.equal(calls,1);
  assert.equal((await fetch(base+'/dictation.js')).status,200);
});
