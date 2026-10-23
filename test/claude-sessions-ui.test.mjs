import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeSessionsUI} from '../public/claude-sessions.js';

test('confirmação do Claude pertence à conversa original e não pode passar para outra conversa', async t => {
  const oldDocument=globalThis.document, nodes=new Map();
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{});return nodes.get(selector);};
  globalThis.document={querySelector:()=>({innerHTML:'',querySelector:node})};
  t.after(()=>{globalThis.document=oldDocument;});
  let selected='A';
  const chats=['A','B'].map(id=>({id,provider:'claude',terminal:{},group:id})),calls=[];
  const ui=new ClaudeSessionsUI({state:()=>({conversations:chats}),current:()=>chats.find(c=>c.id===selected),project:()=>null,choose(){},refresh:async()=>{},toast(){},
    api:async(url,body)=>{calls.push({url,body});if(!body.confirm.length)throw Object.assign(Error('Fecha A'),{code:'CLAUDE_CONFIRM',confirm:'closed'});return{imported:0};}});
  ui.render=()=>{};
  await node('[data-claude-release]').onclick();
  const stale=ui.confirmation;
  selected='B';
  node('[data-claude-proceed]').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1,'confirmar A depois de mudar para B não envia nada');
  selected='A';
  await node('[data-claude-release]').onclick();
  node('[data-claude-proceed]').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.at(-1),{url:'/api/conversations/A/claude-release',body:{confirm:['closed']}});
  assert.notEqual(ui.confirmation,stale);
});

test('confirmação recebida depois de mudar de conversa não aparece na nova conversa', () => {
  const ui=Object.create(ClaudeSessionsUI.prototype);let current='A';
  ui.current=()=>({id:current});ui.project=()=>null;
  const context=ui.context();current='B';
  assert.equal(ui.decide({code:'CLAUDE_CONFIRM',confirm:'history',message:'A'},()=>assert.fail('não deve continuar'),context),true);
  assert.equal(ui.confirmation,undefined);
});
