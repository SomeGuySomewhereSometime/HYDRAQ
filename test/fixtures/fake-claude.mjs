import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (!args.includes('-p') || option('--input-format') !== 'stream-json' || option('--output-format') !== 'stream-json') process.exit(8);
if (args.includes('--dangerously-skip-permissions') || args.includes('--allow-dangerously-skip-permissions')) process.exit(9);
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL) process.exit(7);
const catalog = !args.includes('--model');
if (!catalog && option('--permission-prompt-tool') !== 'stdio') process.exit(6);
const resume = option('--resume');
const sessionId = resume || option('--session-id');
const stateFile = `.fake-claude-${sessionId}`;
if (resume && !existsSync(stateFile)) { process.stderr.write(`No conversation found with session ID: ${resume}`); process.exit(1); }
const model = option('--model'), effort = option('--effort'), mode = option('--permission-mode');
const resolved = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }[model] || model;
let count = 0;
try { count = JSON.parse(readFileSync(stateFile, 'utf8')).count; } catch {}
let pending = null, holding = null;
const result = (text, extra = {}) => emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, terminal_reason: 'completed', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } }, ...extra });
const say = (id, text) => {
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_start', message: { id } } });
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 4) } } });
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(4) } } });
  emit({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id, model: resolved, content: [{ type: 'text', text }] } });
};
createInterface({ input: process.stdin }).on('line', line => {
  const input = JSON.parse(line);
  if (input.type === 'control_request' && input.request.subtype === 'initialize') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: {
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Complexo', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Rápido', supportsEffort: true, supportedEffortLevels: ['max', 'low', 'high'] },
      ],
      account: process.env.FAKE_CLAUDE_AUTH === 'api' ? { apiProvider: 'firstParty' } : { subscriptionType: 'Claude Pro', apiProvider: 'firstParty' },
      claude_code_version: '2.1.304',
    } } });
    return;
  }
  if (input.type === 'control_request' && input.request.subtype === 'interrupt') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: { still_queued: [] } } });
    if (holding) { emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, terminal_reason: 'aborted_streaming' }); holding = null; }
    return;
  }
  if (input.type === 'control_response') {
    if (!pending || input.response.request_id !== pending.request) process.exit(4);
    const allowed = input.response.response.behavior === 'allow';
    emit({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: pending.tool, is_error: !allowed, content: allowed ? 'File created' : 'Permission denied by host' }] } });
    say(`msg-${count}-b`, allowed ? 'Permitido.' : 'Recusado.');
    result(allowed ? 'Permitido.' : 'Recusado.');
    pending = null;
    return;
  }
  if (input.type !== 'user') process.exit(5);
  if(process.env.FAKE_CLAUDE_IMAGE_LOG)writeFileSync(process.env.FAKE_CLAUDE_IMAGE_LOG,JSON.stringify(input.message.content));
  const text = Array.isArray(input.message.content)?input.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.message.content;
  if (text === 'disconnect') process.exit(1);
  count++;
  writeFileSync(stateFile, JSON.stringify({ count }));
  writeFileSync(`.fake-claude-last-${sessionId}`, text);
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: resolved, permissionMode: mode });
  if (text === 'hold') { holding = true; say(`msg-${count}`, 'A trabalhar…'); return; }
  if (text === 'subagent-tools') {
    const parent=`parent-${count}`;
    emit({type:'assistant',session_id:sessionId,message:{id:`parent-msg-${count}`,content:[{type:'tool_use',id:parent,name:'Task',input:{description:'Trabalho delegado'}}]}});
    for(const [id,name,input] of [['child-write','Write',{file_path:'child.txt',content:'CHILD'}],['child-bash','Bash',{command:'echo child'}]]){
      emit({type:'assistant',session_id:sessionId,parent_tool_use_id:parent,message:{id:`${id}-message`,content:[{type:'text',text:'CHILD-TEXT-NOT-PUBLIC'},{type:'tool_use',id,name,input}]}});
      emit({type:'user',session_id:sessionId,parent_tool_use_id:parent,message:{content:[{type:'tool_result',tool_use_id:id,content:'ok'}]}});
    }
    emit({type:'user',session_id:sessionId,message:{content:[{type:'tool_result',tool_use_id:parent,content:'Subagente terminou'}]}});
  }
  if (text === 'many-tools') {
    for(let i=-1;i<205;i++){
      const id=`many-${i}`;
      emit({type:'assistant',session_id:sessionId,message:{id:`msg-many-${i}`,content:[{type:'tool_use',id,name:i===-1?'Write':'Bash',input:i===-1?{file_path:'first.txt',content:'ok'}:{command:`command-${i}`}}]}});
      emit({type:'user',session_id:sessionId,message:{content:[{type:'tool_result',tool_use_id:id,is_error:i===0,content:i===0?'exit 42':'ok'}]}});
    }
  }
  if (text === 'tool-approval') {
    const tool = `toolu_${count}`;
    emit({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id: `msg-${count}`, model: resolved, content: [{ type: 'tool_use', id: tool, name: 'Write', input: { file_path: 'ok.txt', content: 'OK' } }] } });
    pending = { request: `perm-${count}`, tool };
    emit({ type: 'control_request', request_id: pending.request, request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input: { file_path: 'ok.txt', content: 'OK' }, description: 'ok.txt', tool_use_id: tool } });
    return;
  }
  if (text === 'bash') {
    emit({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id: `msg-${count}`, model: resolved, content: [{ type: 'tool_use', id: `bash-${count}`, name: 'Bash', input: { command: 'npm test' } }] } });
    emit({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `bash-${count}`, content: 'ok 3 testes' }] } });
  }
  if (text.startsWith('[HYDRAQ') && process.env.FAKE_CLAUDE_SUMMARY === 'fail') { emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, terminal_reason: 'model_error', result: 'Limite de utilização atingido' }); return; }
  const answer = text.startsWith('[HYDRAQ · pedido interno') ? `RESUMO-CLAUDE ${count}` : `Resposta ${count} processo ${process.pid} modelo ${model} esforço ${effort} modo ${mode} contexto ${text.includes('<hydraq_handoff>') ? 'sim' : 'não'}`;
  say(`msg-${count}`, answer);
  setTimeout(() => result(answer), 5);
});
