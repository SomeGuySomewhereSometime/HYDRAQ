// Read/associate only: no model turn. Stop native-live.mjs first to release its writer.
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Hydraq} from '../lib/hydraq.mjs';
import {Providers} from '../lib/providers.mjs';
const source=(await readFile('/tmp/hydraq-native-live-current','utf8')).trim();
const info=JSON.parse(await readFile(source+'/info.json'));
const previous=JSON.parse(await readFile(source+'/state/state.json')).conversations.find(c=>c.threadId===info.threadId);
const directory=await mkdtemp('/tmp/hydraq-native-import-');
let savedId;const results=[];
for (let run=0;run<2;run++) {
 const codex=new Hydraq({dataDir:directory,defaultCwd:source});
 const hub=new Providers({dataDir:directory,defaultCwd:source,clients:{codex},git:async()=>null});
 try {
  await hub.load();await hub.connect('codex');
  const list=await hub.nativeSessions.list({cwd:source});assert.ok(list.data.some(t=>t.id===info.threadId));
  const imported=await hub.nativeSessions.import({threadId:info.threadId,cwd:source});
  const c=codex.conversation(imported.conversationId);
  assert.equal(c.threadId,info.threadId);assert.equal(c.turns.length,previous.turns.length);
  assert.equal(c.messages.filter(m=>m.role==='user').length,previous.messages.filter(m=>m.role==='user').length);
  if (run) {assert.equal(c.id,savedId);assert.equal(imported.existing,true);}
  savedId=c.id;
  await hub.nativeSessions.open(c.id,{launch:false});await hub.nativeSessions.release(c.id);
  assert.equal(c.turns.length,previous.turns.length);
  results.push({run,threadId:c.threadId,turns:c.turns.length,messages:c.messages.length,status:c.status,existing:!!imported.existing});
 } finally {await hub.close();}
}
await writeFile(source+'/import-restart-result.json',JSON.stringify({directory,results},null,2));
console.log(JSON.stringify({directory,results}));
