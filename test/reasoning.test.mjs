import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readReasoningCapabilities, turnUsage, ZERO_USAGE } from '../lib/reasoning.mjs';

test('metadados antigos, de outra versão ou em falta não são apresentados como suporte confirmado',async t=> {
  const directory=await mkdtemp(path.join(os.tmpdir(),'hydraq-capabilities-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'models.json');
  const cache={client_version:'0.159.0',fetched_at:'2026-10-20T12:00:00Z',models:[{slug:'gpt-test',supports_reasoning_effort_updates:true}]};
  await writeFile(file,JSON.stringify(cache));
  assert.equal((await readReasoningCapabilities(file,'0.159.0',Date.parse('2026-10-20T13:00:00Z'))).models.get('gpt-test'),true);
  assert.equal((await readReasoningCapabilities(file,'0.160.0',Date.parse('2026-10-20T13:00:00Z'))).verified,false);
  assert.equal((await readReasoningCapabilities(file,'0.159.0',Date.parse('2026-10-22T13:00:00Z'))).verified,false);
  assert.equal((await readReasoningCapabilities(file,null)).verified,false);
  assert.equal((await readReasoningCapabilities(path.join(directory,'missing'),'0.159.0')).verified,false);
});

test('contadores reiniciados, ausentes ou inconsistentes não originam valores de cache inventados',()=> {
  const total={...ZERO_USAGE,inputTokens:1000,cachedInputTokens:600,outputTokens:100,totalTokens:1100};
  assert.equal(turnUsage(total,null),null);
  assert.equal(turnUsage(total,{...total,inputTokens:2000}),null);
  assert.equal(turnUsage({...total,cachedInputTokens:1001},ZERO_USAGE),null);
  assert.equal(turnUsage({inputTokens:1000},ZERO_USAGE),null);
  assert.equal(turnUsage(total,ZERO_USAGE).cachePercent,60);
  assert.equal(turnUsage(total,total).inputTokens,0);
});
