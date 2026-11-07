import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, mkdir, realpath, utimes, stat } from 'node:fs/promises';
import { createHttpServer } from '../lib/http.mjs';
import { attachTerminalContextReads } from '../lib/terminal-context-reads.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ClaudeCode } from '../lib/claude.mjs';
import { Providers } from '../lib/providers.mjs';
import { parseLines, activeChain, transcriptTurns, sessionSummary, projectDirectory } from '../lib/claude-transcript.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor = async predicate => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Tempo excedido.'); await new Promise(r => setTimeout(r, 10)); } };
const fake = path.join(root, 'test/fixtures/fake-claude.mjs');
const lines = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('consultas MCP repetidas só são associadas quando apontam para um único pedido e dentro do seu intervalo',()=>{
 const read={id:'read',server:'hydraq_test',tool:'get_project_memory',arguments:{},at:'2026-10-23T10:00:01Z'};
 const tool={id:'call1',name:'mcp__hydraq_test__get_project_memory',input:{},at:'2026-10-23T10:00:00Z'};
 const parsed=[{prompt:{uuid:'p'},messages:[],tools:[tool]}];
 const make=reads=>({terminal:{contextReads:reads},turns:[{requestId:'terminal:p',completedAt:'2026-10-23T10:00:02Z'},{requestId:'terminal:q',completedAt:'2026-10-23T10:00:09Z'}]});
 const repeated=make([read,{...read,id:'read2'}]);attachTerminalContextReads(repeated,parsed);
 assert.equal(repeated.terminal.contextReads.length,0);assert.deepEqual(repeated.turns[0].contextReads.map(r=>[r.id,r.association,r.nativeToolCallId]),[['read','request',undefined],['read2','request',undefined]]);
 const multipleCalls=make([read]);attachTerminalContextReads(multipleCalls,[{...parsed[0],tools:[tool,{...tool,id:'call2'}]}]);
 assert.equal(multipleCalls.terminal.contextReads.length,0);assert.equal(multipleCalls.turns[0].contextReads[0].nativeCalls,2);
 const twoRequests=make([read]);attachTerminalContextReads(twoRequests,[...parsed,{prompt:{uuid:'q'},messages:[],tools:[{...tool,id:'call3',at:'2026-10-23T10:00:05Z'}]}]);
 assert.equal(twoRequests.terminal.contextReads.length,1,'chamadas iguais em pedidos diferentes ficam sem pedido identificado');assert.equal(twoRequests.turns[0].contextReads,undefined);
 const late=make([{...read,at:'2026-10-23T10:00:03Z'}]);attachTerminalContextReads(late,parsed);assert.equal(late.terminal.contextReads.length,1);
 const early=make([read,{...read,id:'early',at:'2026-10-23T09:59:59Z'}]);attachTerminalContextReads(early,parsed);
 assert.deepEqual(early.terminal.contextReads.map(r=>r.id),['early']);assert.deepEqual(early.turns[0].contextReads.map(r=>r.id),['read']);
 const unique=make([read]);attachTerminalContextReads(unique,parsed);attachTerminalContextReads(unique,parsed);
 assert.equal(unique.turns[0].contextReads.length,1);assert.equal(unique.turns[0].contextReads[0].nativeToolCallId,'call1');assert.equal(unique.turns[0].contextReads[0].association,'tool-and-arguments');
});

test('terminal Claude recebe MCP privado, conserva consultas e importa só associações inequívocas',async t=>{
  const {providers,claude,directory,env}=await hub(t);
  const server=createHttpServer({hydraq:providers,publicDir:root+'/public'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeStreams();server.close();});
  const project=await providers.createProject({name:'Memória terminal',root:directory,revision:0});
  await providers.context.save(project.id,{revision:0,text:'MEMORIA_TERMINAL'});
  const chat=await providers.create({provider:'claude',projectId:project.id,revision:providers.projects.data.revision,model:'haiku',effort:'low',sandbox:'plan'}),c=claude.conversation(chat.id);
  await providers.send(c.id,'início','seed');await waitFor(()=>c.status==='completed');
  const file=path.join(projectDirectory(env,directory),c.threadId+'.jsonl'),s=sessionEntries(c.threadId,directory);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,lines([s.add('user',{message:{content:'início'}}),s.add('assistant',{message:{id:'seed',stop_reason:'end_turn',content:[{type:'text',text:'OK'}]}})]));
  const info=await providers.claudeTerminal.open(c.id,{launch:false}),configFile=c.terminal.mcpConfigFile;
  assert.match(info.command,/--mcp-config/);assert.doesNotMatch(info.command,/mcpServers|--strict-mcp-config/);
  assert.equal((await stat(configFile)).mode&0o777,0o600);
  const config=JSON.parse(await readFile(configFile,'utf8')),name=Object.keys(config.mcpServers)[0],lease=providers.contextMcp.sessions.get(c.id);
  assert.equal(config.mcpServers[name].env.HYDRAQ_CONTEXT_LEASE,lease.file);
  const argv=await providers.claudeTerminal.argv(c),allowed=argv[argv.indexOf('--allowedTools')+1];
  assert.equal(argv[argv.indexOf('--mcp-config')+1],configFile);
  assert.deepEqual(allowed.split(','),['get_project_memory','list_project_conversations','search_project_conversations','read_conversation_excerpt'].map(tool=>`mcp__${name}__${tool}`),'só as quatro ferramentas de memória ficam pré-autorizadas');
  assert.ok(info.command.includes(`--allowedTools ${allowed}`),'o comando manual leva a mesma autorização');
  lease.expires=0;assert.equal((await providers.contextMcp.query(lease.token,'get_project_memory',{})).text,'MEMORIA_TERMINAL');
  await providers.contextMcp.query(lease.token,'list_project_conversations',{});await providers.contextMcp.query(lease.token,'list_project_conversations',{});
  assert.equal(c.terminal.contextReads.length,3);assert.equal(c.turns[0].contextReads?.some(r=>r.source==='terminal')||false,false);
  const read=c.terminal.contextReads[0],at=delta=>new Date(Date.parse(read.at)+delta).toISOString();
  await appendFile(file,lines([s.add('user',{timestamp:at(-100),promptSource:'typed',message:{content:'Consulta memória'}}),s.add('assistant',{timestamp:at(-50),message:{id:'tool-message',content:[{type:'tool_use',id:'memory-call',name:`mcp__${name}__get_project_memory`,input:{}}]}}),s.add('user',{timestamp:at(20),message:{content:[{type:'tool_result',tool_use_id:'memory-call',content:'MEMORIA_TERMINAL'}]}}),s.add('assistant',{timestamp:at(50),message:{id:'done',stop_reason:'end_turn',content:[{type:'text',text:'Lida'}]}})]));
  const result=await providers.claudeTerminal.release(c.id);assert.equal(result.imported,1);
  assert.equal(c.turns.at(-1).contextReads[0].nativeToolCallId,'memory-call');assert.equal(c.unattributedContextReads.length,2);
  assert.ok(c.unattributedContextReads.every(r=>r.association==='unidentified-request'));
  assert.ok(lease.expires>Date.now());lease.expires=0;await assert.rejects(providers.contextMcp.query(lease.token,'get_project_memory',{}),/expirada/);
});

test('terminal Claude: arquivar deixa o motivo no lugar da credencial e desarquivar devolve o acesso',async t=>{
  const {providers,claude,directory,env}=await hub(t);
  const server=createHttpServer({hydraq:providers,publicDir:root+'/public'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeStreams();server.close();});
  const project=await providers.createProject({name:'Arquivo terminal',root:directory,revision:0});
  const chat=await providers.create({provider:'claude',projectId:project.id,revision:providers.projects.data.revision,model:'haiku',effort:'low',sandbox:'plan'}),c=claude.conversation(chat.id);
  await providers.send(c.id,'início','seed');await waitFor(()=>c.status==='completed');
  const file=path.join(projectDirectory(env,directory),c.threadId+'.jsonl'),s=sessionEntries(c.threadId,directory);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,lines([s.add('user',{message:{content:'início'}}),s.add('assistant',{message:{id:'seed',stop_reason:'end_turn',content:[{type:'text',text:'OK'}]}})]));
  await providers.claudeTerminal.open(c.id,{launch:false});
  const lease=providers.contextMcp.sessions.get(c.id),read=async()=>JSON.parse(await readFile(lease.file,'utf8'));
  await providers.organizeGroups({groups:[c.group||c.id],revision:providers.projects.data.revision,title:'Mesmo projeto',projectId:project.id});
  assert.equal(providers.contextMcp.sessions.get(c.id),lease,'guardar o mesmo projeto não revoga');
  await providers.organizeGroups({groups:[c.group||c.id],revision:providers.projects.data.revision,archived:true});
  assert.deepEqual(Object.keys(await read()).sort(),['ownerIdentity','ownerPid','revoked']);assert.equal((await read()).revoked,'conversation-archived');
  await assert.rejects(providers.contextMcp.query(lease.token,'get_project_memory',{}),/sem sessão/);
  const command=(await providers.claudeTerminal.open(c.id,{launch:false})).command;assert.match(command,/--mcp-config/,'o terminal arquivado mantém a configuração para explicar o motivo');
  await providers.organizeGroups({groups:[c.group||c.id],revision:providers.projects.data.revision,archived:false});
  const restored=providers.contextMcp.sessions.get(c.id);assert.ok(restored);assert.equal(restored.file,lease.file);assert.equal((await read()).token,restored.token);
  assert.equal((await providers.contextMcp.query(restored.token,'get_project_memory',{})).revision,0);
  await providers.updateProject(project.id,{revision:providers.projects.data.revision,archived:true});
  assert.equal((await read()).revoked,'project-archived');
  await providers.updateProject(project.id,{revision:providers.projects.data.revision,archived:false});
  assert.ok((await read()).token,'desarquivar o projeto devolve o acesso ao terminal');
});

async function hub(t, extraEnv = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hydraq-claude-terminal-')));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(directory, 'claude-home'), FAKE_CLAUDE_AGENTS: path.join(directory, 'agents.json'), FAKE_CLAUDE_ARGS_LOG: path.join(directory, 'args.json'), FAKE_CLAUDE_INFERENCE_ARGS_LOG: path.join(directory, 'inference-args.json'), ...extraEnv };
  const claude = new ClaudeCode({ dataDir: path.join(directory, 'claude'), defaultCwd: directory, executable: process.execPath, prefixArgs: [fake], env, questions: true });
  const providers = new Providers({ dataDir: path.join(directory, 'state'), defaultCwd: directory, clients: { claude }, git: async () => null });
  await providers.load(); await providers.connect('claude');
  t.after(async () => { await providers.close(); await rm(directory, { recursive: true, force: true }); });
  return { providers, claude, directory, env };
}

function sessionEntries(sessionId, cwd) {
  let previous = null, n = 0;
  const add = (type, extra = {}) => { const uuid = `${type}-${++n}`; const entry = { type, uuid, parentUuid: previous, isSidechain: false, sessionId, cwd, timestamp: new Date(Date.UTC(2026, 9, 23, 10, 0, n)).toISOString(), ...extra }; previous = uuid; return entry; };
  return { add, set previous(value) { previous = value; }, get previous() { return previous; } };
}

test('processos Claude recusam mensagens de outras sessões e não herdam a identidade de uma sessão Claude', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-claude-settings-')), clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await rm(directory, { recursive: true, force: true }); });
  const log = path.join(directory, 'args.json');
  const env = { ...process.env, FAKE_CLAUDE_ARGS_LOG: log, CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'pai', CLAUDE_CODE_MESSAGING_TOKEN: 'segredo', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock', CLAUDE_PID: '1' };
  for (const [readOnly, questions] of [[false, false], [false, true], [true, true]]) {
    const client = new ClaudeCode({ dataDir: path.join(directory, `state-${readOnly}-${questions}`), defaultCwd: directory, executable: process.execPath, prefixArgs: [fake], env, readOnly, questions });
    clients.push(client);
    for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_PID']) assert.equal(client.env[key], undefined);
    await client.load(); await client.connect();
    const c = await client.create({ cwd: directory, model: 'haiku', effort: 'low', sandbox: 'plan' });
    await client.send(c.id, 'olá', `r-${readOnly}-${questions}`);
    await waitFor(() => c.status === 'completed');
    const args = JSON.parse(await readFile(log, 'utf8'));
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), readOnly ? { disableAllHooks: true, crossSessionInbound: 'refuse' } : { crossSessionInbound: 'refuse' });
    assert.equal(args.filter(arg => arg === '--settings').length, 1);
    assert.equal(args.includes('AskUserQuestion'), !questions || readOnly, 'só o cliente principal recebe a ferramenta de perguntas');
  }
});

test('perguntas do Claude aparecem na interface, exigem resposta válida e chegam como answers', async t => {
  const { providers, claude, directory } = await hub(t);
  const chat = await providers.create({ provider: 'claude', cwd: directory, model: 'haiku', effort: 'low', sandbox: 'plan' });
  const c = claude.conversation(chat.id);
  await providers.send(c.id, 'ask', 'pergunta-1');
  await waitFor(() => claude.approvals.size === 1);
  const [request] = claude.approvals.values();
  assert.equal(request.method, 'claude/askUserQuestion');
  assert.equal(c.status, 'waiting');
  assert.deepEqual(request.params.questions.map(q => [q.question, q.multiSelect, q.options.map(o => o.label)]), [['Qual formato?', false, ['Resumo', 'Detalhado']], ['Que secções?', true, ['Intro', 'Fim']]]);
  assert.throws(() => providers.respond(`claude:${request.id}`, { decision: 'accept', answers: { 'Qual formato?': 'Resumo' } }), /Que secções/);
  assert.throws(() => providers.respond(`claude:${request.id}`, { decision: 'accept', answers: { 'Qual formato?': ['Resumo', 'Detalhado'], 'Que secções?': 'Intro' } }), /só uma resposta/);
  assert.equal(claude.approvals.size, 1, 'uma resposta inválida não resolve o pedido');
  providers.respond(`claude:${request.id}`, { decision: 'accept', answers: { 'Qual formato?': ['Outro formato à minha escolha'], 'Que secções?': ['Intro', 'Fim'] } });
  await waitFor(() => c.status === 'completed');
  assert.match(c.messages.at(-1).text, /"Qual formato\?":"Outro formato à minha escolha","Que secções\?":"Intro, Fim"/);
  await providers.send(c.id, 'ask', 'pergunta-2');
  await waitFor(() => claude.approvals.size === 1);
  const [second] = claude.approvals.values();
  providers.respond(`claude:${second.id}`, { decision: 'decline' });
  await waitFor(() => c.status === 'completed');
  assert.match(c.messages.at(-1).text, /preferiu não responder/);
  assert.equal(c.items.find(item => item.id === 'ask_2').summary, 'Perguntas ao utilizador');
});

test('sem a ferramenta de perguntas, um pedido inesperado é recusado sem ficar à espera', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hydraq-claude-noquestions-'));
  const client = new ClaudeCode({ dataDir: path.join(directory, 'state'), defaultCwd: directory, executable: process.execPath, prefixArgs: [fake], env: process.env });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.load(); await client.connect();
  const c = await client.create({ cwd: directory, model: 'haiku', effort: 'low', sandbox: 'plan' });
  await client.send(c.id, 'ask', 'sem-perguntas');
  await waitFor(() => c.status === 'completed');
  assert.equal(client.approvals.size, 0);
  assert.match(c.messages.at(-1).text, /não conseguiu apresentar estas perguntas/);
});

test('transcrição nativa: ramo ativo, compactação, interrupção, comandos locais e subagentes', () => {
  const s = sessionEntries('s', '/p');
  const entries = [
    s.add('user', { promptSource: 'typed', message: { role: 'user', content: 'primeiro' } }),
    s.add('assistant', { message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Velho' }] } }),
  ];
  const fork = entries[0].uuid;
  s.previous = fork; // rewind: a new reply to the first prompt replaces the old branch
  entries.push(
    s.add('assistant', { message: { id: 'm2', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Novo ' }] } }),
    s.add('assistant', { message: { id: 'm2', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ramo' }] } }),
    s.add('user', { isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } }),
    s.add('user', { message: { role: 'user', content: '<command-name>/model</command-name>' } }),
    s.add('user', { message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }),
    s.add('system', { subtype: 'compact_boundary' }),
  );
  entries.at(-1).logicalParentUuid = entries.at(-1).parentUuid; entries.at(-1).parentUuid = null;
  entries.push(
    s.add('user', { isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'resumo' } }),
    s.add('user', { promptSource: 'typed', message: { role: 'user', content: [{ type: 'text', text: 'segundo' }, { type: 'image', source: {} }] } }),
    s.add('assistant', { message: { id: 'm3', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'a.txt', content: 'A' } }] } }),
    { type: 'assistant', uuid: 'side', parentUuid: null, isSidechain: true, message: { id: 'sx', content: [{ type: 'text', text: 'SUBAGENTE' }] } },
    s.add('user', { toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } }),
    s.add('assistant', { message: { id: 'm4', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 9' } }] } }),
    s.add('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  );
  const parsed = parseLines(lines(entries) + '{partial');
  assert.equal(parsed.skipped, 1);
  const chain = activeChain(parsed.entries);
  assert.ok(!chain.some(entry => entry.uuid === entries[1].uuid), 'o ramo abandonado fica de fora');
  const { turns, compactions } = transcriptTurns(chain);
  assert.equal(compactions, 1);
  assert.deepEqual(turns.map(turn => [turn.prompt.text, turn.prompt.images, turn.status, turn.messages.map(m => m.text), turn.tools.map(tool => [tool.name, tool.done])]),
    [['primeiro', 0, 'completed', ['Novo ramo'], []], ['segundo', 1, 'interrupted', [], [['Write', true], ['Bash', false]]]]);
  assert.equal(turns[1].model, 'claude-opus-5-5');
  const summary = sessionSummary([...parsed.entries, { type: 'ai-title', aiTitle: 'Título gerado' }]);
  assert.equal(summary.title, 'Título gerado');
  assert.equal(summary.cwd, '/p');
  assert.equal(sessionSummary([{ type: 'user', entrypoint: 'claude-desktop', promptSource: 'sdk', message: { role: 'user', content: '<wake reason="mention">\n  <message from="human">Olá equipa</message>\n</wake>' } }]).title, 'Olá equipa');
});

test('Claude original: passa a sessão ao terminal, bloqueia a HYDRAQ e importa só o que foi feito lá', async t => {
  const { providers, claude, directory, env } = await hub(t);
  const chat = await providers.create({ provider: 'claude', cwd: directory, model: 'haiku', effort: 'low', sandbox: 'workspace-write' });
  const c = claude.conversation(chat.id);
  await assert.rejects(providers.claudeTerminal.open(c.id, { launch: false }), /Envia primeiro um pedido/);
  await providers.send(c.id, 'olá', 'hydraq-1');
  await waitFor(() => c.status === 'completed');
  const file = path.join(projectDirectory(env, directory), `${c.threadId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const s = sessionEntries(c.threadId, directory);
  await writeFile(file, lines([s.add('user', { entrypoint: 'sdk-cli', promptSource: 'sdk', message: { role: 'user', content: 'olá' } }),
    s.add('assistant', { entrypoint: 'sdk-cli', message: { id: 'h1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Resposta HYDRAQ' }] } })]));
  const before = c.turns.length, messages = c.messages.length;

  const info = await providers.claudeTerminal.open(c.id, { launch: false });
  assert.match(info.command, new RegExp(`--resume ${c.threadId} --model haiku --effort low --permission-mode default$`));
  assert.ok(info.command.startsWith(`cd ${directory} && `));
  assert.equal(claude.session, null, 'o processo da HYDRAQ termina antes de o terminal continuar');
  assert.equal(c.terminal.leaf, 'assistant-2');
  assert.deepEqual(await providers.claudeTerminal.open(c.id, { launch: false }), info, 'voltar a abrir só mostra o comando');
  await assert.rejects(providers.send(c.id, 'durante', 'hydraq-2'), /Claude original \(terminal\)/);
  assert.ok(providers.workScopes().some(scope => scope.kind === 'terminal' && scope.cwd === directory));
  assert.throws(() => providers.assertFree({ cwd: directory, resources: ['normal:codex'] }), /Claude original no terminal/);
  assert.doesNotThrow(() => providers.assertFree({ cwd: '/outra/pasta', resources: ['normal:claude'] }), 'o Claude da HYDRAQ continua livre noutras pastas');

  await appendFile(file, lines([
    s.add('user', { entrypoint: 'cli', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } }),
    s.add('user', { entrypoint: 'cli', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
    s.add('user', { entrypoint: 'cli', promptSource: 'typed', message: { role: 'user', content: 'Cria novo.txt' } }),
    s.add('assistant', { entrypoint: 'cli', message: { id: 't1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tw', name: 'Write', input: { file_path: 'novo.txt', content: 'x' } }] } }),
    s.add('user', { entrypoint: 'cli', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw', content: 'File created' }] } }),
    s.add('assistant', { entrypoint: 'cli', message: { id: 't2', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Criei o ficheiro.' }] } }),
    s.add('user', { entrypoint: 'cli', promptSource: 'typed', message: { role: 'user', content: 'Corre os testes' } }),
    s.add('assistant', { entrypoint: 'cli', message: { id: 't3', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'rm -rf build' } }] } }),
    s.add('user', { entrypoint: 'cli', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tb', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } }),
    s.add('user', { entrypoint: 'cli', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  ]));
  await writeFile(env.FAKE_CLAUDE_AGENTS, JSON.stringify([{ pid: 4242, kind: 'interactive', sessionId: c.threadId, cwd: directory }]));
  await assert.rejects(providers.claudeTerminal.release(c.id), /ainda tem esta sessão aberta \(processo 4242\)/);
  assert.ok(c.terminal, 'continua bloqueada enquanto o terminal tiver a sessão');

  await writeFile(env.FAKE_CLAUDE_AGENTS, '[]');
  const result = await providers.claudeTerminal.release(c.id);
  assert.deepEqual([result.imported, result.warning], [2, null]);
  assert.equal(c.terminal, undefined);
  const imported = c.turns.slice(before);
  assert.deepEqual(imported.map(turn => [turn.source, turn.status, turn.model]), [['terminal', 'completed', 'opus'], ['terminal', 'interrupted', 'opus']]);
  assert.deepEqual(c.messages.slice(messages).map(m => [m.role, m.text, m.phase || null]), [['user', 'Cria novo.txt', null], ['assistant', 'Criei o ficheiro.', 'final_answer'], ['user', 'Corre os testes', null]]);
  assert.deepEqual(c.items.filter(item => item.source === 'terminal').map(item => [item.type, item.status]), [['fileChange', 'completed'], ['commandExecution', 'declined']]);
  await waitFor(() => imported[0].facts);
  assert.deepEqual(imported[0].facts.files, ['novo.txt']);
  const { buildHandoff } = await import('../lib/handoff.mjs');
  const handoff = buildHandoff({ target: { id: 'outro', provider: 'codex', turns: [], messages: [] }, members: [{ ...c, provider: 'claude' }, { id: 'outro', provider: 'codex', turns: [], messages: [] }], git: null, budget: 40000 });
  assert.match(handoff.text, /Claude Code · opus · Claude original · concluído/);
  assert.doesNotMatch(handoff.text, /\(null\)/);
  assert.equal((await providers.claudeTerminal.release(c.id)).imported, 0, 'voltar sem terminal ativo não repete nada');

  await providers.send(c.id, 'depois', 'hydraq-3');
  await waitFor(() => c.status === 'completed');
  const args = JSON.parse(await readFile(env.FAKE_CLAUDE_INFERENCE_ARGS_LOG, 'utf8'));
  assert.equal(args[args.indexOf('--resume') + 1], c.threadId, 'a HYDRAQ retoma a mesma sessão nativa');
});

test('Claude original: rebobinar no terminal importa só o ramo novo e avisa', async t => {
  const { providers, claude, directory, env } = await hub(t);
  const chat = await providers.create({ provider: 'claude', cwd: directory, model: 'haiku', effort: 'low', sandbox: 'plan' });
  const c = claude.conversation(chat.id);
  await providers.send(c.id, 'olá', 'hydraq-1');
  await waitFor(() => c.status === 'completed');
  const file = path.join(projectDirectory(env, directory), `${c.threadId}.jsonl`), s = sessionEntries(c.threadId, directory);
  await mkdir(path.dirname(file), { recursive: true });
  const first = s.add('user', { promptSource: 'sdk', message: { role: 'user', content: 'olá' } });
  await writeFile(file, lines([first, s.add('assistant', { message: { id: 'h1', content: [{ type: 'text', text: 'HYDRAQ' }] } })]));
  await providers.claudeTerminal.open(c.id, { launch: false });
  s.previous = first.uuid;
  await appendFile(file, lines([s.add('assistant', { message: { id: 'r1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Outra resposta' }] } }),
    s.add('user', { promptSource: 'typed', message: { role: 'user', content: 'Depois de rebobinar' } }),
    s.add('assistant', { message: { id: 'r2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Feito' }] } })]));
  const result = await providers.claudeTerminal.release(c.id);
  assert.equal(result.imported, 2);
  assert.match(result.warning, /rebobinada/);
  assert.deepEqual(c.messages.filter(m => m.source === 'terminal').map(m => m.text), ['Continuação no Claude original', 'Outra resposta', 'Depois de rebobinar', 'Feito']);
});

test('associar sessões do terminal e da app Claude; sessões programáticas ficam de fora', async t => {
  const { providers, claude, directory, env } = await hub(t);
  const folder = projectDirectory(env, directory);
  await mkdir(folder, { recursive: true });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const write = async (id, entrypoint, extra = [], cwd = directory, minutes = 0) => {
    const s = sessionEntries(id, cwd), file = path.join(folder, `${id}.jsonl`);
    await writeFile(file, lines([s.add('user', { entrypoint, promptSource: 'typed', message: { role: 'user', content: `Pergunta ${entrypoint}` } }),
      s.add('assistant', { entrypoint, message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `Resposta ${entrypoint}` }] } }), ...extra]));
    const when = new Date(Date.now() - minutes * 60_000); await utimes(file, when, when);
  };
  await write(ids[0], 'cli', [{ type: 'ai-title', aiTitle: 'Título do terminal' }], directory, 1);
  await write(ids[1], 'claude-desktop', [], directory, 2);
  await write(ids[2], 'sdk-cli', [], directory, 0);
  await write(ids[3], 'cli', [], '/outra/pasta', 0);
  const page = await providers.claudeTerminal.list({ cwd: directory });
  assert.deepEqual(page.data.map(s => [s.id, s.source, s.title, s.imported]), [[ids[0], 'Terminal', 'Título do terminal', false], [ids[1], 'App Claude', 'Pergunta claude-desktop', false]]);
  assert.equal(page.nextCursor, null);

  await writeFile(env.FAKE_CLAUDE_AGENTS, JSON.stringify([{ pid: 77, sessionId: ids[0] }]));
  await assert.rejects(providers.claudeTerminal.import({ sessionId: ids[0], cwd: directory }), /aberta noutro Claude \(processo 77\)/);
  assert.equal(claude.conversations.length, 0, 'uma sessão aberta não cria conversa');
  await writeFile(env.FAKE_CLAUDE_AGENTS, '[]');
  const result = await providers.claudeTerminal.import({ sessionId: ids[0], cwd: directory });
  const c = claude.conversation(result.conversationId);
  assert.deepEqual([c.threadId, c.sessionStarted, c.title, c.model, c.nativeSource.source, result.imported], [ids[0], true, 'Título do terminal', 'opus', 'Terminal', 1]);
  assert.deepEqual(c.messages.map(m => [m.role, m.text]), [['user', 'Pergunta cli'], ['assistant', 'Resposta cli']]);
  assert.deepEqual(await providers.claudeTerminal.import({ sessionId: ids[0], cwd: directory }), { conversationId: c.id, existing: true });
  assert.equal((await providers.claudeTerminal.list({ cwd: directory })).data[0].conversationId, c.id);
  await assert.rejects(providers.claudeTerminal.import({ sessionId: ids[3], cwd: directory }), /não pertence a esta pasta/);
  await writeFile(path.join(directory, `.fake-claude-${ids[0]}`), JSON.stringify({ count: 1 }));
  await providers.send(c.id, 'continuar', 'continuar-1');
  await waitFor(() => c.status === 'completed');
  const args = JSON.parse(await readFile(env.FAKE_CLAUDE_INFERENCE_ARGS_LOG, 'utf8'));
  assert.equal(args[args.indexOf('--resume') + 1], ids[0]);
});

test('transcrição nativa: resultados de ferramentas em paralelo ficam em ramos laterais', () => {
  const s = sessionEntries('s', '/p');
  const p = s.add('user', { promptSource: 'sdk', message: { role: 'user', content: 'lê dois ficheiros' } });
  const a = s.add('assistant', { message: { id: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a' } }] } });
  const b = s.add('assistant', { message: { id: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'b' } }] } });
  s.previous = a.uuid;
  const first = s.add('user', { toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'A' }] } });
  s.previous = b.uuid;
  const entries = [p, a, b, first, s.add('user', { toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'B' }] } }),
    s.add('assistant', { message: { id: 'f', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Li os dois.' }] } })];
  const chain = activeChain(entries);
  assert.ok(!chain.includes(first), 'o primeiro resultado está fora do ramo ativo');
  const [turn] = transcriptTurns(chain, entries).turns;
  assert.deepEqual([turn.status, turn.tools.map(tool => [tool.done, tool.result])], ['completed', [[true, 'A'], [true, 'B']]]);
});

test('transcrição nativa: só a marca de fim do CLI confirma um pedido', () => {
  const s = sessionEntries('s', '/p');
  const prompt = text => s.add('user', { promptSource: 'typed', message: { role: 'user', content: text } });
  const reply = (id, text, stop, extra = {}) => s.add('assistant', { ...extra, message: { id, model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: 'text', text }] } });
  const entries = [
    prompt('sem resposta'),
    prompt('texto parcial'), reply('p1', 'A escrever…', null),
    prompt('ferramenta sem fim'), s.add('assistant', { message: { id: 'p2', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } }),
    s.add('user', { toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }),
    prompt('erro da API'), reply('p3', 'API Error: overloaded', 'stop_sequence', { isApiErrorMessage: true }),
    prompt('recusa'), reply('p4', 'Não posso.', 'refusal'),
    prompt('concluído'), reply('p5', 'Feito.', 'end_turn'),
  ];
  const { turns } = transcriptTurns(activeChain(entries));
  assert.deepEqual(turns.map(turn => [turn.prompt.text, turn.status, Boolean(turn.unconfirmed)]), [
    ['sem resposta', 'interrupted', true], ['texto parcial', 'interrupted', true], ['ferramenta sem fim', 'interrupted', true],
    ['erro da API', 'failed', false], ['recusa', 'failed', false], ['concluído', 'completed', false]]);
});

test('Claude original: sem confirmação do CLI ou com histórico incompleto, a conversa fica no terminal até haver decisão explícita', async t => {
  const { providers, claude, directory, env } = await hub(t);
  const chat = await providers.create({ provider: 'claude', cwd: directory, model: 'haiku', effort: 'low', sandbox: 'plan' });
  const c = claude.conversation(chat.id);
  await providers.send(c.id, 'olá', 'hydraq-1');
  await waitFor(() => c.status === 'completed');
  const file = path.join(projectDirectory(env, directory), `${c.threadId}.jsonl`), s = sessionEntries(c.threadId, directory);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines([s.add('user', { promptSource: 'sdk', message: { role: 'user', content: 'olá' } }), s.add('assistant', { message: { id: 'h', stop_reason: 'end_turn', content: [{ type: 'text', text: 'HYDRAQ' }] } })]));
  await providers.claudeTerminal.open(c.id, { launch: false });
  await appendFile(file, lines([s.add('user', { promptSource: 'typed', message: { role: 'user', content: 'Só o pedido' } })]));

  await writeFile(env.FAKE_CLAUDE_AGENTS, 'listagem indisponível');
  await assert.rejects(providers.claudeTerminal.release(c.id), error => error.code === 'CLAUDE_CONFIRM' && error.confirm === 'closed' && error.status === 409);
  assert.ok(c.terminal, 'sem confirmação do CLI a sessão não é libertada');

  await appendFile(file, '{linha cortada\n');
  await assert.rejects(providers.claudeTerminal.release(c.id, { confirm: ['closed'] }), error => error.confirm === 'history' && /1 linha/.test(error.message));
  assert.ok(c.terminal, 'histórico ilegível não liberta sem decisão');
  const turns = c.turns.length;
  const result = await providers.claudeTerminal.release(c.id, { confirm: ['closed', 'history'] });
  assert.equal(result.imported, 1);
  assert.equal(c.terminal, undefined);
  const imported = c.turns.at(-1);
  assert.deepEqual([c.turns.length, imported.status, imported.unconfirmed, c.status], [turns + 1, 'interrupted', true, 'interrupted']);
  assert.match(c.error, /não confirmou a conclusão/);
  assert.match(c.error, /linha\(s\) da transcrição por ler/);
  assert.match(c.error, /sem verificação do CLI/);
  assert.equal(c.messages.filter(m => m.source === 'terminal' && m.role === 'assistant').length, 0, 'nada é apresentado como resposta final');

  await writeFile(env.FAKE_CLAUDE_AGENTS, '[]');
  await providers.claudeTerminal.open(c.id, { launch: false });
  await rm(file);
  await assert.rejects(providers.claudeTerminal.release(c.id), error => error.confirm === 'history' && /Não encontrei a transcrição/.test(error.message));
  assert.ok(c.terminal);
  assert.deepEqual(await providers.claudeTerminal.release(c.id, { confirm: ['history'] }), { released: true, imported: 0, warning: 'Continuaste sem a transcrição nativa: nada do Claude original foi importado.' });
});

test('associar sessão com linhas ilegíveis exige decisão explícita', async t => {
  const { providers, claude, directory, env } = await hub(t);
  const id = '55555555-5555-4555-8555-555555555555', s = sessionEntries(id, directory), file = path.join(projectDirectory(env, directory), `${id}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines([s.add('user', { entrypoint: 'cli', promptSource: 'typed', message: { role: 'user', content: 'Olá' } }), s.add('assistant', { entrypoint: 'cli', message: { id: 'a', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá!' }] } })]) + '{partial\n');
  await assert.rejects(providers.claudeTerminal.import({ sessionId: id, cwd: directory }), error => error.confirm === 'history');
  assert.equal(claude.conversations.length, 0);
  await writeFile(env.FAKE_CLAUDE_AGENTS, 'falhou');
  await assert.rejects(providers.claudeTerminal.import({ sessionId: id, cwd: directory, confirm: ['history'] }), error => error.confirm === 'closed');
  assert.equal(claude.conversations.length, 0);
  const result = await providers.claudeTerminal.import({ sessionId: id, cwd: directory, confirm: ['history', 'closed'] });
  assert.equal(result.imported, 1);
  assert.match(claude.conversation(result.conversationId).error, /1 linha\(s\) da transcrição por ler/);
});
