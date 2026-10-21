import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, truncate, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { inspectProject, compareProjects } from '../lib/project-state.mjs';
import { gitStatus } from '../lib/handoff.mjs';

async function temporary(t){const folder=await mkdtemp(path.join(os.tmpdir(),'hydraq-project-check-'));t.after(()=>rm(folder,{recursive:true,force:true}));return folder;}

test('hashes detetam mudanças em ficheiros sujos e não rastreados com git status idêntico',async t=> {
  const folder=await temporary(t);
  execFileSync('git',['init','-q',folder]);
  await writeFile(path.join(folder,'tracked.txt'),'base');execFileSync('git',['-C',folder,'add','tracked.txt']);
  await writeFile(path.join(folder,'tracked.txt'),'dirty-before');await writeFile(path.join(folder,'untracked.txt'),'before');
  const status=await gitStatus(folder), before=await inspectProject(folder);
  await writeFile(path.join(folder,'tracked.txt'),'dirty-after');await writeFile(path.join(folder,'untracked.txt'),'after');
  const after=await inspectProject(folder);
  assert.deepEqual(await gitStatus(folder),status);assert.equal(before.complete,true);assert.equal(after.complete,true);
  assert.deepEqual(compareProjects(before,after).changed,['tracked.txt','untracked.txt']);
});

test('inspeção sem git deteta criação e remoção e não segue links fora do projeto',async t=> {
  const folder=await temporary(t), outside=await temporary(t);
  await writeFile(path.join(folder,'old.txt'),'old');await writeFile(path.join(outside,'secret.txt'),'secret');
  await symlink(outside,path.join(folder,'link'));
  await mkdir(path.join(folder,'.hydraq'));await writeFile(path.join(folder,'.hydraq','state.json'),'private');
  const before=await inspectProject(folder);
  await rm(path.join(folder,'old.txt'));await writeFile(path.join(folder,'new.txt'),'new');await writeFile(path.join(outside,'secret.txt'),'changed');
  const after=await inspectProject(folder);
  assert.deepEqual(compareProjects(before,after).changed,['new.txt','old.txt']);
  assert.equal(Object.keys(before.files).some(name=>name.includes('secret')||name.includes('.hydraq')),false);
});

test('limites de inspeção ficam explícitos e não simulam uma verificação completa',async t=> {
  const folder=await temporary(t), large=path.join(folder,'large.bin');
  await writeFile(large,'');await truncate(large,300*1024*1024);
  const result=await inspectProject(folder);
  assert.equal(result.complete,false);assert.match(result.warnings.join(' '),/Limite de leitura/);
});

test('Unity sem git exclui apenas caches reconhecidas e conserva código e nomes especiais',async t=>{
  const folder=await temporary(t);
  await Promise.all(['Assets','ProjectSettings','Library','Temp'].map(name=>mkdir(path.join(folder,name))));
  await writeFile(path.join(folder,'ProjectSettings/ProjectVersion.txt'),'Unity project');
  await writeFile(path.join(folder,'Assets/game.cs'),'before');
  await writeFile(path.join(folder,'__proto__'),'before');
  const cache=path.join(folder,'Library/cache.bin');await writeFile(cache,'');await truncate(cache,300*1024*1024);
  const before=await inspectProject(folder);assert.equal(before.complete,true);assert.equal(Object.keys(before.files).some(name=>name.startsWith('Library/')),false);
  await writeFile(path.join(folder,'Assets/game.cs'),'after');await writeFile(path.join(folder,'__proto__'),'after');
  const after=await inspectProject(folder);assert.deepEqual(compareProjects(before,after).changed,['Assets/game.cs','__proto__']);
  const generic=await temporary(t);await mkdir(path.join(generic,'Library'));await writeFile(path.join(generic,'Library/source.txt'),'source');
  assert.ok((await inspectProject(generic)).files['Library/source.txt']);
});
