import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browseFolders, createFolder, createLooseFolder } from '../lib/folders.mjs';
import { Projects } from '../lib/projects.mjs';

test('pastas independentes são distintas e recusam raízes dentro de projetos', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-folders-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const base=path.join(dir,'conversas'),a=await createLooseFolder(base),b=await createLooseFolder(base);
  assert.notEqual(a,b);assert.equal(path.dirname(a),base);assert.equal((await stat(a)).mode&0o777,0o700);
  await assert.rejects(createLooseFolder(base,[dir]),/dentro de um projeto/);
  const repo=path.join(dir,'repo');await mkdir(repo);const alias=path.join(dir,'alias');await symlink(repo,alias);
  await assert.rejects(createLooseFolder(path.join(alias,'nao-criar'),[repo]),/dentro de um projeto/);await assert.rejects(stat(path.join(repo,'nao-criar')),{code:'ENOENT'});
});

test('navegação e criação de projetos respeitam caminhos e revisões', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hydraq-folders-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await createFolder(path.join(dir,'existente'));const view=await browseFolders(dir);assert.ok(view.folders.includes('existente'));
  await assert.rejects(createFolder('relativo'),/absoluto/);
  const store=new Projects(path.join(dir,'state'));await store.load();
  const target=path.join(dir,'novo','projeto');const p=await store.create({name:'Novo',root:target,revision:0});assert.equal(p.root,target);assert.ok((await stat(target)).isDirectory());
  const stale=path.join(dir,'nao-criar');await assert.rejects(store.create({name:'Inválido',root:stale,revision:0}),/noutra janela/);await assert.rejects(stat(stale),{code:'ENOENT'});
});
