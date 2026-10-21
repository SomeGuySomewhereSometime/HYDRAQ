import test from 'node:test';import assert from 'node:assert/strict';
import {processIdentity,sameProcess} from '../lib/process-owner.mjs';
import {workConflict} from '../public/work-locks.js';
test('PID reutilizado não corresponde ao processo dono nem à sessão MCP',()=>{
 const id=processIdentity();assert.equal(sameProcess(process.pid,id),true);assert.equal(sameProcess(process.pid,{...id,start:String(BigInt(id.start)+1n)}),false);assert.equal(sameProcess(process.pid,{...id,boot:'old-boot'}),false);assert.equal(sameProcess(2147483647,id),false);assert.equal(sameProcess(process.pid),true);
});
test('reservas comparam projeto, sobreposição de caminhos e recurso nativo',()=>{
 assert.ok(workConflict({cwd:'/a'},{cwd:'/a/sub'}));assert.ok(workConflict({cwd:'/a/sub'},{cwd:'/a'}));assert.ok(!workConflict({cwd:'/a'},{cwd:'/ab'}));assert.ok(workConflict({projectId:'p',cwd:'/a'},{projectId:'p',cwd:'/b'}));assert.ok(workConflict({resources:['normal:claude']},{resources:['normal:claude']}));assert.ok(!workConflict({cwd:'/a',resources:['collaboration']},{cwd:'/b',resources:['normal:codex']}));
});
