import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,symlink,readFile} from 'node:fs/promises';
import {CursorPlanFiles} from '../lib/cursor-plan-files.mjs';
test('ficheiro do plano conserva Markdown completo, ordena atualizações e recusa caminhos ou symlinks',async t=>{
 const root=await mkdtemp('/tmp/hydraq-plan-files-');t.after(()=>rm(root,{recursive:true,force:true}));const store=new CursorPlanFiles(root),id='11111111-1111-1111-1111-111111111111',text='PLANO\n'+'x'.repeat(230000)+'\nPLANO-FIM';await Promise.all([store.save({id,text:'rascunho'}),store.save({id,text})]);assert.equal((await store.read(id)).text,text);assert.throws(()=>store.file('../outside'),/inválido/);const link='22222222-2222-2222-2222-222222222222';await symlink(store.file(id),store.file(link));await assert.rejects(store.read(link),/inválido/);await assert.rejects(store.save({id:link,text:'NO'}),/inválido/);assert.equal(await readFile(store.file(id),'utf8'),text);
});
