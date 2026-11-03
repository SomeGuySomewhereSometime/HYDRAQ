import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { readProjectFile } from '../lib/companion-store.mjs';
import { Providers } from '../lib/providers.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { CodexClient } from '../lib/codex.mjs';
import { createHttpServer } from '../lib/http.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const waitFor = async (predicate, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('Tempo excedido no teste da mascote.');
    await new Promise(r => setTimeout(r, 15));
  }
};

async function createTestEnv(t, { wsFactory } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hydraq-companion-'));
  const dataDir = path.join(dir, 'state');
  const repoA = path.join(dir, 'repo-a');
  const repoB = path.join(dir, 'repo-b');
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });

  const makeHub = async () => {
    const clients = {
      codex: new Hydraq({
        dataDir,
        defaultCwd: repoA,
        modelMetadataPath: path.join(dir, 'unused.json'),
        client: new CodexClient({
          executable: process.execPath,
          args: [path.join(root, 'test/fixtures/fake-codex.mjs')],
        }),
      }),
    };
    const hub = new Providers({ dataDir, clients, git: async () => null });
    if (wsFactory) hub.companion.wsFactory = wsFactory;
    await hub.load();
    await hub.connectAll();
    return { hub, clients };
  };

  let current = await makeHub();
  t.after(async () => {
    try { await current.hub.close(); } finally {
      await new Promise(r => setTimeout(r, 30));
      await rm(dir, { recursive: true, force: true });
    }
  });

  const projectA = await current.hub.createProject({
    name: 'Projeto Alfa',
    root: repoA,
    revision: current.hub.projects.data.revision,
  });
  const projectB = await current.hub.createProject({
    name: 'Projeto Beta',
    root: repoB,
    revision: current.hub.projects.data.revision,
  });

  const restartHub = async () => {
    await current.hub.close();
    current = await makeHub();
    return current.hub;
  };

  return {
    dir,
    dataDir,
    repoA,
    repoB,
    projectA,
    projectB,
    get hub() { return current.hub; },
    get clients() { return current.clients; },
    restartHub,
  };
}

test('isolamento por projeto, paginação em blocos, permissões privadas e persistência após reinício', async t => {
  const env = await createTestEnv(t);
  const { projectA, projectB, repoA } = env;

  await env.hub.companion.updateProfile(projectA.id, {
    name: 'Lumen',
    voice: 'Kore',
    style: 'Direta e técnica',
    avatar: 'fox',
  });
  await env.hub.companion.updateProfile(projectB.id, {
    name: 'Nexo',
    voice: 'Puck',
    style: 'Sintética',
    avatar: 'owl',
  });

  const store = env.hub.companion.store;
  const convA = await store.ensureActiveConversation(projectA.id);
  for (let i = 1; i <= 55; i++) {
    await store.appendMessage(projectA.id, convA.id, {
      role: i % 2 ? 'user' : 'assistant',
      text: `Mensagem ${i} do projeto A`,
      modality: 'voice',
    });
  }
  await store.addMemoryItem(projectA.id, { kind: 'decision', text: 'Usar WebSocket dedicado em /api/companion/live' });
  const nowIso = new Date().toISOString();
  await store.updateConversationMetadata(projectA.id, convA.id, meta => ({
    ...meta,
    resumption: {
      handle: 'handle-a-123',
      resumable: true,
      updatedAt: nowIso,
      model: 'gemini-3.8-live-extended-thinking',
      voiceMode: 'hands-free',
    },
  }));

  // Verify nothing was written inside the project repository itself
  const repoFiles = await stat(path.join(repoA, '.hydraq')).catch(() => null);
  assert.equal(repoFiles, null);

  // Verify private permissions and block split (50 messages per block)
  const companionDirStat = await stat(path.join(env.dataDir, 'companion', projectA.id));
  assert.equal(companionDirStat.mode & 0o777, 0o700);
  const profileStat = await stat(path.join(env.dataDir, 'companion', projectA.id, 'profile.json'));
  assert.equal(profileStat.mode & 0o777, 0o600);
  const block1 = JSON.parse(await readFile(path.join(env.dataDir, 'companion', projectA.id, 'conversations', convA.id, 'messages-0001.json'), 'utf8'));
  const block2 = JSON.parse(await readFile(path.join(env.dataDir, 'companion', projectA.id, 'conversations', convA.id, 'messages-0002.json'), 'utf8'));
  assert.equal(block1.messages.length, 50);
  assert.equal(block2.messages.length, 5);

  // Restart hub and verify full state and isolation between Project A and Project B
  const restarted = await env.restartHub();
  const stateA = await restarted.companion.view(projectA.id);
  const stateB = await restarted.companion.view(projectB.id);

  assert.equal(stateA.profile.name, 'Lumen');
  assert.equal(stateA.profile.voice, 'Kore');
  assert.equal(stateA.activeConversation.messageCount, 55);
  assert.equal(stateA.activeConversation.resumption.handle, 'handle-a-123');
  assert.equal(stateA.messages.length, 55);
  assert.equal(stateA.messages[0].text, 'Mensagem 1 do projeto A');
  assert.equal(stateA.messages[54].text, 'Mensagem 55 do projeto A');
  assert.equal(stateA.nextBlockCursor, null);
  assert.equal(stateA.memory.items.length, 1);

  assert.equal(stateB.profile.name, 'Nexo');
  assert.equal(stateB.messages.length, 0);
  assert.equal(stateB.memory.items.length, 0);
});

test('controlos independentes de memória, sessão temporária, arquivo e invalidação imediata da sessão ativa', async t => {
  const setupFrames = [];
  const env = await createTestEnv(t, {
    wsFactory: () => {
      const ws = new EventEmitterSocket();
      ws.onSend = payload => {
        const parsed = JSON.parse(payload);
        if (parsed.setup) {
          setupFrames.push(parsed.setup);
          queueMicrotask(() => ws.receive({ setupComplete: {} }));
        }
      };
      queueMicrotask(() => ws.emit('open'));
      return ws;
    },
  });
  const { projectA } = env;
  const store = env.hub.companion.store;
  const conv = await store.ensureActiveConversation(projectA.id);
  const { item } = await store.addMemoryItem(projectA.id, { kind: 'decision', text: 'Memória inicial importante' });
  await store.updateConversationMetadata(projectA.id, conv.id, meta => ({
    ...meta,
    resumption: {
      handle: 'resume-token-1',
      resumable: true,
      updatedAt: new Date().toISOString(),
      model: 'gemini-3.8-live',
      voiceMode: 'hands-free',
    },
  }));

  // 1. updateMemory = false blocks the mascot tool from adding memory
  await env.hub.companion.updateSettings(projectA.id, { updateMemory: false });
  const blockedTool = await env.hub.companion.executeTool(projectA.id, conv.id, {
    name: 'registar_memoria_mascote',
    args: { kind: 'preference', text: 'Tentativa bloqueada' },
  });
  assert.equal(blockedTool.saved, false);
  assert.match(blockedTool.reason, /desativada/);
  await env.hub.companion.updateSettings(projectA.id, { updateMemory: true });

  // 2. Connect a Live session and verify memory + resumptionHandle are used; then delete the memory item
  // and verify the handle is invalidated and the active Live session recreates its context without the deleted memory.
  env.hub.companion.env.GEMINI_API_KEY = 'test-key-secret';
  const clientSocket = new FakeClientSocket();
  env.hub.companion.attachWebSocket(clientSocket, { projectId: projectA.id });
  await waitFor(() => setupFrames.length === 1);
  assert.equal(setupFrames[0].sessionResumption?.handle, 'resume-token-1');
  assert.match(setupFrames[0].systemInstruction.parts[0].text, /Memória inicial importante/);

  // Delete the memory item while session is live
  await env.hub.companion.manageMemory(projectA.id, { action: 'delete-item', itemId: item.id });
  await waitFor(() => setupFrames.length === 2);
  assert.equal(setupFrames[1].sessionResumption?.handle, undefined);
  assert.doesNotMatch(setupFrames[1].systemInstruction.parts[0].text, /Memória inicial importante/);

  // 3. Temporary session uses neither memory nor history nor resumption without deleting stored data
  await store.addMemoryItem(projectA.id, { kind: 'preference', text: 'Preferência guardada no disco' });
  await env.hub.companion.updateSettings(projectA.id, { temporarySession: true });
  await waitFor(() => setupFrames.length === 3);
  assert.doesNotMatch(setupFrames[2].systemInstruction.parts[0].text, /Preferência guardada no disco/);
  const afterTemp = await store.memory(projectA.id);
  assert.equal(afterTemp.items.length, 1);

  clientSocket.close();
});

test('leitor seguro de ficheiros do projeto recusa symlinks em diretórios intermédios, ficheiros finais, travessia e redige segredos', async t => {
  const env = await createTestEnv(t);
  const { repoA, repoB } = env;

  await mkdir(path.join(repoA, 'src', 'real'), { recursive: true });
  await writeFile(
    path.join(repoA, 'src', 'real', 'config.mjs'),
    'export const ok = true;\nexport const token = "sk-1234567890abcdefghijklmnop";\n',
  );
  await writeFile(path.join(repoB, 'outside.txt'), 'segredo fora do projeto');

  // Symlink to file outside
  await symlink(path.join(repoB, 'outside.txt'), path.join(repoA, 'src', 'file-link.txt'));
  // Intermediate directory symlink pointing outside
  await symlink(repoB, path.join(repoA, 'src', 'dir-link-outside'));
  // Intermediate directory symlink pointing INSIDE the same repo (still rejected per security policy)
  await symlink(path.join(repoA, 'src', 'real'), path.join(repoA, 'src', 'dir-link-inside'));

  // Valid read with redaction
  const valid = await readProjectFile(repoA, 'src/real/config.mjs');
  assert.equal(valid.path, 'src/real/config.mjs');
  assert.match(valid.text, /export const ok = true/);
  assert.match(valid.text, /\[ocultado\]/);
  assert.doesNotMatch(valid.text, /sk-1234567890/);

  // Rejections
  await assert.rejects(readProjectFile(repoA, '../repo-b/outside.txt'), /fora do projeto/);
  await assert.rejects(readProjectFile(repoA, 'src/file-link.txt'), /Ligações simbólicas/);
  await assert.rejects(readProjectFile(repoA, 'src/dir-link-outside/outside.txt'), /Ligações simbólicas/);
  await assert.rejects(readProjectFile(repoA, 'src/dir-link-inside/config.mjs'), /Ligações simbólicas/);
  await assert.rejects(readProjectFile(repoA, '.git/config'), /fora do âmbito/);
  await assert.rejects(readProjectFile(repoA, '.env'), /sensíveis/);

  // Binary file rejection
  await writeFile(path.join(repoA, 'src', 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
  await assert.rejects(readProjectFile(repoA, 'src/binary.bin'), /binários/);
});

test('proveniência da mascote na memória oficial do projeto é validada sem poluir o índice de conversas dos clientes', async t => {
  const env = await createTestEnv(t);
  const { projectA, projectB } = env;

  const store = env.hub.companion.store;
  const convA = await store.ensureActiveConversation(projectA.id);
  const { message: msgA } = await store.appendMessage(projectA.id, convA.id, {
    role: 'assistant',
    text: 'Decidimos manter o transporte WebSocket dedicado para áudio.',
  });

  // Publish decision to official project memory
  const memory = await env.hub.companion.publishDecisionToProject(projectA.id, {
    decisionText: 'Transporte WebSocket dedicado em /api/companion/live.',
    companionConversationId: convA.id,
    messageId: msgA.id,
  });
  assert.equal(memory.sources.length, 1);
  assert.equal(memory.sources[0].kind, 'companion');
  assert.equal(memory.sources[0].companionConversationId, convA.id);
  assert.equal(memory.sources[0].messageId, msgA.id);

  // Forged messageId or cross-project source is rejected
  await assert.rejects(
    env.hub.companion.publishDecisionToProject(projectA.id, {
      decisionText: 'Fonte falsa',
      companionConversationId: convA.id,
      messageId: '00000000-0000-4000-8000-000000000000',
    }),
    /não encontrada neste projeto/,
  );
  await assert.rejects(
    env.hub.companion.publishDecisionToProject(projectB.id, {
      decisionText: 'Fonte de outro projeto',
      companionConversationId: convA.id,
      messageId: msgA.id,
    }),
    /não encontrada neste projeto/,
  );

  // Informal companion chats do not appear in ProjectContext's client conversation index
  const indexed = await env.hub.context.query(projectA.id, null, 'list_project_conversations', {});
  assert.equal((indexed.items || indexed.conversations || []).length, 0);
});

test('protocolo Live: sinais VAD (mãos-livres vs carregar para falar), interactionStatus, interrupção, goAway e erro 429 sem ciclo infinito', async t => {
  const upstreamFrames = [];
  let activeUpstream = null;
  let upstreamCount = 0;

  const env = await createTestEnv(t, {
    wsFactory: () => {
      upstreamCount++;
      const ws = new EventEmitterSocket();
      activeUpstream = ws;
      ws.onSend = payload => {
        const parsed = JSON.parse(payload);
        upstreamFrames.push(parsed);
        if (parsed.setup) {
          queueMicrotask(() => ws.receive({ setupComplete: {} }));
        }
      };
      queueMicrotask(() => ws.emit('open'));
      return ws;
    },
  });
  env.hub.companion.env.GEMINI_API_KEY = 'test-live-key';
  const { projectA } = env;

  const server = createHttpServer({ hydraq: env.hub, publicDir: path.join(root, 'public') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeStreams(); server.close(); });
  const port = server.address().port;

  const bootstrapRes = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
    headers: { 'X-HYDRAQ-Bootstrap': '1' },
  });
  const { token } = await bootstrapRes.json();

  const wsUrl = `ws://127.0.0.1:${port}/api/companion/live?projectId=${encodeURIComponent(projectA.id)}&token=${encodeURIComponent(token)}`;
  const client = new WebSocket(wsUrl, { headers: { origin: `http://127.0.0.1:${port}` } });
  const clientEvents = [];
  client.on('message', data => clientEvents.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  await waitFor(() => clientEvents.some(e => e.type === 'setup_complete' && e.session?.status === 'listening'));

  // Verify setup configuration for default gemini-3.8-live in hands-free mode
  const firstSetup = upstreamFrames.find(f => f.setup)?.setup;
  assert.equal(firstSetup.model, 'models/gemini-3.8-live');
  assert.equal(firstSetup.generationConfig.thinkingConfig, undefined);
  assert.deepEqual(firstSetup.contextWindowCompression, { slidingWindow: {} });
  assert.equal(firstSetup.realtimeInputConfig.automaticActivityDetection.disabled, false);

  // Switch to gemini-3.8-live-extended-thinking to verify thinkingConfig and interactionStatus handling
  await env.hub.companion.updateSettings(projectA.id, { model: 'gemini-3.8-live-extended-thinking' });
  const extSetup = upstreamFrames.findLast(f => f.setup)?.setup;
  assert.equal(extSetup.model, 'models/gemini-3.8-live-extended-thinking');
  assert.equal(extSetup.generationConfig.thinkingConfig.thinkingLevel, 'LOW');

  // In hands-free mode: audio_stream_end is forwarded as audioStreamEnd, activity_start/end are NOT forwarded
  client.send(JSON.stringify({ type: 'audio_stream_end' }));
  client.send(JSON.stringify({ type: 'activity_start' }));
  client.send(JSON.stringify({ type: 'activity_end' }));
  await waitFor(() => upstreamFrames.some(f => f.realtimeInput?.audioStreamEnd === true));
  assert.equal(upstreamFrames.some(f => f.realtimeInput?.activityStart), false);
  assert.equal(upstreamFrames.some(f => f.realtimeInput?.activityEnd), false);

  // Switch to push-to-talk mode: automaticActivityDetection.disabled = true, activityStart/End work, audioStreamEnd is ignored
  upstreamFrames.length = 0;
  client.send(JSON.stringify({ type: 'mode', voiceMode: 'push-to-talk' }));
  await waitFor(() => upstreamFrames.some(f => f.setup));
  const pttSetup = upstreamFrames.find(f => f.setup).setup;
  assert.equal(pttSetup.realtimeInputConfig.automaticActivityDetection.disabled, true);
  // Wait until setup_complete of the recreated session
  await waitFor(() => env.hub.companion.sessions.get(projectA.id)?.isReady());

  client.send(JSON.stringify({ type: 'audio_stream_end' }));
  client.send(JSON.stringify({ type: 'activity_start' }));
  client.send(JSON.stringify({ type: 'activity_end' }));
  await waitFor(() => upstreamFrames.some(f => f.realtimeInput?.activityEnd));
  assert.equal(upstreamFrames.some(f => f.realtimeInput?.activityStart), true);
  assert.equal(upstreamFrames.some(f => f.realtimeInput?.audioStreamEnd), false);

  // Test interactionStatus: IN_PROGRESS filler turnComplete vs IDLE turnComplete
  const liveSession = env.hub.companion.sessions.get(projectA.id);
  activeUpstream.receive({
    serverContent: {
      interactionStatus: 'IN_PROGRESS',
      outputTranscription: { text: 'Deixa-me ver isso...' },
      turnComplete: true,
    },
  });
  await waitFor(() => liveSession.interactionStatus === 'IN_PROGRESS');
  liveSession.enqueueEvent({ id: 'ev-1', kind: 'delegation-finished', summary: 'Resumo de teste na fila' });
  await new Promise(r => setTimeout(r, 40));
  // Event must NOT be flushed while interactionStatus is IN_PROGRESS
  assert.equal(upstreamFrames.some(f => f.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('Resumo de teste na fila')), false);

  // Now model transitions to IDLE
  activeUpstream.receive({
    serverContent: {
      interactionStatus: 'IDLE',
      turnComplete: true,
    },
  });
  await waitFor(() => upstreamFrames.some(f => f.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('Resumo de teste na fila')));

  // Test interruption signal
  activeUpstream.receive({ serverContent: { interrupted: true } });
  await waitFor(() => clientEvents.some(e => e.type === 'interrupted'));

  // Test sessionResumptionUpdate + goAway reconnect
  activeUpstream.receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-after-goaway' } });
  await new Promise(r => setTimeout(r, 25));
  const beforeGoAwayCount = upstreamCount;
  activeUpstream.receive({ goAway: { timeLeft: '5s' } });
  await waitFor(() => upstreamCount > beforeGoAwayCount);
  const resumedSetup = upstreamFrames.findLast(f => f.setup)?.setup;
  assert.equal(resumedSetup.sessionResumption?.handle, 'handle-after-goaway');

  // Test quota error (429): transitions to error and does NOT reconnect in a loop
  const countAtQuotaError = upstreamCount;
  activeUpstream.receive({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } });
  await waitFor(() => clientEvents.some(e => e.type === 'error' && e.code === 'QUOTA_EXCEEDED'));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(upstreamCount, countAtQuotaError);

  client.close();
});

test('garantia de delegação única na criação da conversa e no envio, mesmo após reconexão ou reinício incerto', async t => {
  const env = await createTestEnv(t);
  const { projectA } = env;
  const store = env.hub.companion.store;
  const conv = await store.ensureActiveConversation(projectA.id);

  // First call to delegar_exploracao creates a read-only conversation and sends the request
  const first = await env.hub.companion.executeTool(projectA.id, conv.id, {
    id: 'call-1',
    name: 'delegar_exploracao',
    args: {
      prompt: 'Analisar a estrutura do projeto sem editar ficheiros',
      provider: 'codex',
      actionKey: 'acao-unica-1',
    },
  });
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, undefined);
  assert.ok(first.targetConversationId);

  const createdConv = env.hub.conversations().find(c => c.id === first.targetConversationId);
  assert.ok(createdConv);
  assert.equal(createdConv.sandbox, 'read-only');

  // Second call with a different call.id (simulating Gemini re-calling after reconnect) but same actionKey
  // must NOT create another conversation or send another turn
  const beforeConvCount = env.hub.conversations().length;
  const second = await env.hub.companion.executeTool(projectA.id, conv.id, {
    id: 'call-2-after-reconnect',
    name: 'delegar_exploracao',
    args: {
      prompt: 'Analisar a estrutura do projeto sem editar ficheiros',
      provider: 'codex',
      actionKey: 'acao-unica-1',
    },
  });
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.actionId, first.actionId);
  assert.equal(env.hub.conversations().length, beforeConvCount);

  // Wait for fake-codex to finish the turn and verify the action completes and queues a notification while offline
  await waitFor(() => {
    const c = env.hub.conversations().find(chat => chat.id === first.targetConversationId);
    return c?.status === 'completed';
  });
  await waitFor(async () => {
    const state = await env.hub.companion.view(projectA.id);
    return state.actions.some(a => a.id === first.actionId && a.status === 'completed');
  });
  const completedState = await env.hub.companion.view(projectA.id);
  assert.equal(completedState.pendingNotifications.length, 1);

  // Simulate an interrupted action stuck in 'creating-conversation' before server restart:
  // reconcileProjectActions() must mark it as 'uncertain' and refuse automatic re-execution.
  await store.saveAction(projectA.id, {
    id: '00000000-0000-4000-8000-000000000099',
    projectId: projectA.id,
    companionConversationId: conv.id,
    actionKey: 'acao-interrompida-key',
    kind: 'explore',
    provider: 'codex',
    sandbox: 'read-only',
    prompt: 'Pedido interrompido a meio da criação',
    status: 'creating-conversation',
    requestId: 'companion-interrompida',
    targetConversationId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const restarted = await env.restartHub();
  const actionsAfterRestart = await restarted.companion.store.actions(projectA.id);
  const reconciled = actionsAfterRestart.find(a => a.id === '00000000-0000-4000-8000-000000000099');
  assert.equal(reconciled.status, 'uncertain');

  const retryAttempt = await restarted.companion.executeTool(projectA.id, conv.id, {
    id: 'call-retry',
    name: 'delegar_exploracao',
    args: {
      prompt: 'Pedido interrompido a meio da criação',
      provider: 'codex',
      actionKey: 'acao-interrompida-key',
    },
  });
  assert.equal(retryAttempt.duplicate, true);
  assert.equal(retryAttempt.status, 'uncertain');
});

test('correções da revisão do Codex (1 a 8): deduplicação sem actionKey, troca de conversa em sessão Live, bloqueio de fila em mãos-livres, saveHistory em direto, Interromper a montante, paginação sem perdas e notificações persistidas no reinício', async t => {
  const upstreamFrames = [];
  let activeUpstream = null;

  const env = await createTestEnv(t, {
    wsFactory: () => {
      const ws = new EventEmitterSocket();
      activeUpstream = ws;
      ws.onSend = payload => {
        const parsed = JSON.parse(payload);
        upstreamFrames.push(parsed);
        if (parsed.setup) {
          queueMicrotask(() => ws.receive({ setupComplete: {} }));
        }
      };
      queueMicrotask(() => ws.emit('open'));
      return ws;
    },
  });
  env.hub.companion.env.GEMINI_API_KEY = 'test-live-key';
  const { projectA } = env;
  const store = env.hub.companion.store;
  const conv1 = await store.ensureActiveConversation(projectA.id);

  // [Codex #6] Exactly 50 messages in block 1 must return all 50 messages (1..50), never losing 1..10
  for (let i = 1; i <= 50; i++) {
    await store.appendMessage(projectA.id, conv1.id, {
      role: i % 2 ? 'user' : 'assistant',
      text: `Msg ${i}`,
      modality: 'voice',
    });
  }
  const view50 = await env.hub.companion.view(projectA.id);
  assert.equal(view50.messages.length, 50);
  assert.equal(view50.messages[0].text, 'Msg 1');
  assert.equal(view50.messages[49].text, 'Msg 50');

  // With 105 messages (3 blocks: 50 + 50 + 5), page 1 returns 51..105 with nextBlockCursor = 1, and beforeBlock = 1 returns 1..50
  for (let i = 51; i <= 105; i++) {
    await store.appendMessage(projectA.id, conv1.id, {
      role: i % 2 ? 'user' : 'assistant',
      text: `Msg ${i}`,
      modality: 'voice',
    });
  }
  const page1 = await env.hub.companion.view(projectA.id);
  assert.equal(page1.messages[0].text, 'Msg 51');
  assert.equal(page1.messages.at(-1).text, 'Msg 105');
  assert.equal(page1.nextBlockCursor, 1);
  const page2 = await env.hub.companion.view(projectA.id, { conversationId: conv1.id, beforeBlock: page1.nextBlockCursor });
  assert.equal(page2.messages.length, 50);
  assert.equal(page2.messages[0].text, 'Msg 1');
  assert.equal(page2.messages[49].text, 'Msg 50');
  assert.equal(page2.nextBlockCursor, null);

  // [Codex #1] Deduplication without actionKey when Gemini repeats a tool call with a new call.id for the same user message
  const { message: userOriginMsg } = await store.appendMessage(projectA.id, conv1.id, {
    role: 'user',
    text: 'Pede ao Codex para inspecionar o módulo http',
    modality: 'voice',
  });
  const del1 = await env.hub.companion.executeTool(
    projectA.id,
    conv1.id,
    {
      id: 'gemini-call-a',
      name: 'delegar_exploracao',
      args: { provider: 'codex', prompt: 'Inspeciona lib/http.mjs sem alterar ficheiros' },
    },
    { originMessageId: userOriginMsg.id },
  );
  assert.equal(del1.accepted, true);
  assert.equal(del1.duplicate, undefined);
  await waitFor(() => {
    const c = env.hub.conversations().find(chat => chat.id === del1.targetConversationId);
    return c?.status === 'completed';
  });

  // Even after the turn completed, a reconnect replay with a DIFFERENT call.id and NO actionKey for the SAME originMessageId must be deduplicated
  const convCountBeforeReplay = env.hub.conversations().length;
  const delReplay = await env.hub.companion.executeTool(
    projectA.id,
    conv1.id,
    {
      id: 'gemini-call-b-after-reconnect',
      name: 'delegar_exploracao',
      args: { provider: 'codex', prompt: 'Inspeciona lib/http.mjs sem alterar ficheiros' },
    },
    { originMessageId: userOriginMsg.id },
  );
  assert.equal(delReplay.duplicate, true);
  assert.equal(delReplay.actionId, del1.actionId);
  assert.equal(env.hub.conversations().length, convCountBeforeReplay);

  // [Codex #7] Pending notifications when offline survive a full server restart AND survive a failed Live connection (e.g. rejected key)
  await waitFor(async () => (await env.hub.companion.view(projectA.id)).pendingNotifications.length === 1);
  const restarted = await env.restartHub();
  restarted.companion.env.GEMINI_API_KEY = 'rejected-live-key';
  let rejectNextUpstream = true;
  restarted.companion.wsFactory = () => {
    const ws = new EventEmitterSocket();
    activeUpstream = ws;
    ws.onSend = payload => {
      const parsed = JSON.parse(payload);
      upstreamFrames.push(parsed);
      if (parsed.setup) {
        if (rejectNextUpstream) {
          queueMicrotask(() => {
            ws.receive({ error: { code: 403, message: 'API_KEY_INVALID: key rejected' } });
          });
        } else {
          queueMicrotask(() => ws.receive({ setupComplete: {} }));
        }
      }
    };
    queueMicrotask(() => ws.emit('open'));
    return ws;
  };
  const viewAfterRestart = await restarted.companion.view(projectA.id);
  assert.equal(viewAfterRestart.pendingNotifications.length, 1);

  // Simulate failed connection before setupComplete: notification MUST remain on disk
  const failedSocket = new FakeClientSocket();
  restarted.companion.attachWebSocket(failedSocket, { projectId: projectA.id, conversationId: conv1.id });
  await waitFor(() => failedSocket.sent.some(e => e.type === 'error'));
  const viewAfterFailedConnect = await restarted.companion.view(projectA.id);
  assert.equal(viewAfterFailedConnect.pendingNotifications.length, 1);

  // Now allow connection to succeed: notification is consumed only after setupComplete
  rejectNextUpstream = false;
  restarted.companion.env.GEMINI_API_KEY = 'test-live-key';
  const clientSocket = new FakeClientSocket();
  restarted.companion.attachWebSocket(clientSocket, { projectId: projectA.id, conversationId: conv1.id });
  await waitFor(() => clientSocket.sent.some(e => e.type === 'setup_complete'));
  const viewAfterSuccessConnect = await restarted.companion.view(projectA.id);
  assert.equal(viewAfterSuccessConnect.pendingNotifications.length, 0);
  const session = restarted.companion.sessions.get(projectA.id);
  assert.equal(session.conversation.id, conv1.id);

  // [Codex #2] Creating a «Nova conversa» while Live session is active switches the Live session to the new conversation
  const conv2 = await restarted.companion.manageConversation(projectA.id, { action: 'create', title: 'Conversa Nova' });
  await waitFor(() => session.isReady() && session.conversation.id === conv2.id);
  assert.equal(session.publicState().conversationId, conv2.id);

  // [Codex #3] In hands-free mode:
  // (a) While the user is actively speaking (non-silent PCM frame), queued updates do NOT flush mid-speech.
  // (b) When the user is silent and the browser continues streaming silent PCM frames continuously (without stopping the mic), queued updates DO flush!
  upstreamFrames.length = 0;
  const speechPcmBase64 = Buffer.from('fala-com-energia-vocal-alta').toString('base64');
  const silentPcmBase64 = Buffer.alloc(640).toString('base64');
  clientSocket.emit('message', Buffer.from(JSON.stringify({ type: 'audio', data: speechPcmBase64, mimeType: 'audio/pcm;rate=16000' })));
  session.enqueueEvent({ id: 'ev-handsfree', kind: 'delegation-finished', summary: 'Não cortar a fala do utilizador' });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(upstreamFrames.some(f => f.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('Não cortar a fala do utilizador')), false);

  // Now the browser continuously streams silent PCM frames (microphone still open in hands-free mode, no audio_stream_end)
  for (let i = 0; i < 6; i++) {
    clientSocket.emit('message', Buffer.from(JSON.stringify({ type: 'audio', data: silentPcmBase64, mimeType: 'audio/pcm;rate=16000' })));
  }
  await waitFor(() => upstreamFrames.some(f => f.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('Não cortar a fala do utilizador')));
  // Return session to IDLE
  activeUpstream.receive({ serverContent: { interactionStatus: 'IDLE', turnComplete: true } });
  await waitFor(() => session.interactionStatus === 'IDLE');

  // [Codex #4] Turning off saveHistory during an active session immediately prevents saving new messages to disk
  const beforeDisableMeta = await restarted.companion.store.readMetadata(projectA.id, conv2.id);
  assert.equal(beforeDisableMeta.messageCount, 0);
  await restarted.companion.updateSettings(projectA.id, { saveHistory: false });
  clientSocket.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: 'Mensagem sem histórico em disco' })));
  await new Promise(r => setTimeout(r, 30));
  const afterDisableMeta = await restarted.companion.store.readMetadata(projectA.id, conv2.id);
  assert.equal(afterDisableMeta.messageCount, 0);
  await restarted.companion.updateSettings(projectA.id, { saveHistory: true });

  // [Codex #5] Clicking «Interromper» sends an upstream interruption frame to Gemini and drops subsequent audio from the interrupted turn, EVEN if silent mic frames arrive right after
  upstreamFrames.length = 0;
  const audioEventsCountBefore = clientSocket.sent.filter(e => e.type === 'audio').length;
  activeUpstream.receive({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'BBBB', mimeType: 'audio/pcm;rate=24000' } }] },
    },
  });
  await waitFor(() => clientSocket.sent.filter(e => e.type === 'audio').length === audioEventsCountBefore + 1);

  clientSocket.emit('message', Buffer.from(JSON.stringify({ type: 'interrupt' })));
  await waitFor(() => upstreamFrames.some(f => f.clientContent?.turnComplete === true || f.realtimeInput?.activityEnd));
  // Open microphone sends silent PCM frames right after interrupt
  clientSocket.emit('message', Buffer.from(JSON.stringify({ type: 'audio', data: silentPcmBase64, mimeType: 'audio/pcm;rate=16000' })));
  // In-flight audio chunk from the previous response arriving after silent mic frame must STILL be ignored
  activeUpstream.receive({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'CCCC', mimeType: 'audio/pcm;rate=24000' } }] },
    },
  });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(clientSocket.sent.filter(e => e.type === 'audio').length, audioEventsCountBefore + 1);

  clientSocket.close();
});

test('gemini-3.8-live entrega notificações de delegação quando o turno termina sem interactionStatus e recupera via watchdog se um turno bloquear', async t => {
  const upstreamFrames = [];
  let activeUpstream = null;

  const env = await createTestEnv(t, {
    wsFactory: () => {
      const ws = new EventEmitterSocket();
      activeUpstream = ws;
      ws.onSend = payload => {
        const parsed = JSON.parse(payload);
        upstreamFrames.push(parsed);
        if (parsed.setup) {
          queueMicrotask(() => ws.receive({ setupComplete: {} }));
        }
        if (parsed.toolResponse) {
          // Simulate gemini-3.8-live speaking after toolResponse and finishing with turnComplete: true WITHOUT interactionStatus
          queueMicrotask(() => {
            ws.receive({
              serverContent: {
                modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }] },
                outputTranscription: { text: 'Já pedi ao Codex para analisar.' },
              },
            });
            ws.receive({
              serverContent: {
                turnComplete: true,
              },
            });
          });
        }
      };
      queueMicrotask(() => ws.emit('open'));
      return ws;
    },
  });
  env.hub.companion.env.GEMINI_API_KEY = 'test-live-key';
  const { projectA } = env;

  const clientSocket = new FakeClientSocket();
  env.hub.companion.attachWebSocket(clientSocket, { projectId: projectA.id });
  await waitFor(() => clientSocket.sent.some(e => e.type === 'setup_complete'));
  const session = env.hub.companion.sessions.get(projectA.id);
  assert.equal(session.settings.model, 'gemini-3.8-live');

  // Gemini calls delegar_exploracao
  activeUpstream.receive({
    toolCall: {
      functionCalls: [
        {
          id: 'live-call-1',
          name: 'delegar_exploracao',
          args: {
            provider: 'codex',
            prompt: 'Analisa a estrutura do projeto e resume',
            actionKey: 'live-normal-turn-test',
          },
        },
      ],
    },
  });

  // Verify the turn finishes (turnComplete without interactionStatus returns session to 'listening' and 'IDLE')
  // and the completed Codex delegation notification is delivered to Gemini via clientContent!
  await waitFor(() =>
    upstreamFrames.some(f =>
      f.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('no Codex terminou com estado: completed'),
    ),
  );
  // Gemini finishes speaking the notification with turnComplete: true (without interactionStatus)
  activeUpstream.receive({ serverContent: { turnComplete: true } });
  await waitFor(() => session.status === 'listening');
  assert.equal(session.interactionStatus, 'IDLE');

  // Verify action_updated events were emitted to the UI with sentAt, completedAt and durationMs
  const completedActionEvent = clientSocket.sent.findLast(
    e => e.type === 'action_updated' && e.action?.status === 'completed',
  );
  assert.ok(completedActionEvent);
  assert.ok(completedActionEvent.action.sentAt);
  assert.ok(completedActionEvent.action.completedAt);
  assert.equal(typeof completedActionEvent.action.durationMs, 'number');
  assert.ok(completedActionEvent.action.durationMs >= 0);

  // Now test the watchdog timeout (thinkingTimeoutMs) when a turn gets stuck in IN_PROGRESS / responding
  env.hub.companion.thinkingTimeoutMs = 80;
  upstreamFrames.length = 0;
  activeUpstream.receive({
    serverContent: {
      interactionStatus: 'IN_PROGRESS',
      outputTranscription: { text: 'Vou pensar…' },
    },
  });
  await waitFor(() => session.status === 'responding');
  session.enqueueEvent({
    id: 'ev-after-watchdog',
    kind: 'delegation-finished',
    summary: 'Entregue após recuperação por timeout do turno',
  });
  // Wait for the 80ms watchdog to recover the stuck turn and flush the queued notification
  await waitFor(() =>
    upstreamFrames.some(f =>
      f.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('Entregue após recuperação por timeout do turno'),
    ),
  );
  assert.equal(session.interactionStatus, 'IDLE');
  assert.ok(clientSocket.sent.some(e => e.type === 'warning'));
  activeUpstream.receive({ serverContent: { turnComplete: true } });
  await waitFor(() => session.status === 'listening');

  clientSocket.close();
});

class EventEmitterSocket {
  constructor() {
    this.readyState = WebSocket.OPEN;
    this.listeners = new Map();
    this.onSend = null;
  }
  on(event, fn) {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
  }
  emit(event, ...args) {
    for (const fn of this.listeners.get(event) || []) fn(...args);
  }
  send(payload) {
    this.onSend?.(payload);
  }
  receive(obj) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

class FakeClientSocket extends EventEmitterSocket {
  constructor() {
    super();
    this.sent = [];
    this.onSend = payload => this.sent.push(JSON.parse(payload));
  }
}

test('delegações aparecem na conversa de origem com proveniência persistida, sem copiar o diálogo informal', async t => {
  const { companionRequest, companionTranscriptOwners } = await import('../public/companion.js');
  const env = await createTestEnv(t);
  const { hub, projectA, projectB } = env;
  const source = await hub.create({ projectId: projectA.id, revision: hub.projects.data.revision, provider: 'codex', model: hub.snapshot().providers.codex.models[0].id });
  const foreign = await hub.create({ projectId: projectB.id, revision: hub.projects.data.revision, provider: 'codex', model: hub.snapshot().providers.codex.models[0].id });
  const voice = await hub.companion.store.ensureActiveConversation(projectA.id);
  await hub.companion.store.appendMessage(projectA.id, voice.id, { role: 'user', text: 'Conversa informal privada da mascote.', modality: 'voice' });
  await hub.companion.store.appendMessage(projectA.id, voice.id, { role: 'assistant', text: 'Resposta informal privada.', modality: 'voice' });
  await assert.rejects(hub.companion.delegateExploration(projectA.id, voice.id, { prompt: 'Pedido inválido', sourceGroupId: foreign.group }), /não pertence/);
  const delegated = await hub.companion.delegateExploration(projectA.id, voice.id, { provider: 'codex', prompt: 'Comenta a estrutura do projeto.', sourceGroupId: source.group });
  await waitFor(() => hub.conversations().find(c => c.id === delegated.targetConversationId)?.turns?.some(turn => turn.requestId === delegated.requestId && turn.status === 'completed'));
  const state = hub.snapshot();
  const target = state.conversations.find(c => c.id === delegated.targetConversationId);
  const origin = state.conversations.find(c => c.id === source.id);
  assert.equal(target.organization.companion.sourceGroupId, source.group);
  assert.equal(target.organization.companion.requestId, delegated.requestId);
  assert.equal(target.organization.companion.name, 'Hydra');
  assert.equal(target.messages.find(m => m.role === 'user').text, 'Comenta a estrutura do projeto.');
  assert.equal(target.messages.some(m => /informal privada/.test(m.text)), false);
  const owners = companionTranscriptOwners(state.conversations, origin, [origin]);
  assert.equal(owners.length, 2);
  assert.ok(owners[1].messages.some(m => m.role === 'assistant'));
  assert.ok(owners[1].messages.every(m => companionRequest(owners[1], m)?.name === 'Hydra'));
  const followup = { role: 'user', requestId: 'human-followup', text: 'Pedido humano posterior.', at: new Date().toISOString() };
  const withFollowup = { ...target, messages: [...target.messages, followup] };
  assert.equal(companionTranscriptOwners([origin, withFollowup], origin, [origin])[1].messages.includes(followup), false);
  assert.equal(companionTranscriptOwners(state.conversations, state.conversations.find(c => c.id === foreign.id), [foreign]).length, 1);
  const reloaded = await env.restartHub();
  assert.equal(reloaded.snapshot().conversations.find(c => c.id === target.id).organization.companion.sourceGroupId, source.group);
});

test('encerramentos Live distinguem sessão expirada, autenticação, quota e protocolo', async () => {
  const { classifyGeminiLiveFailure: classify } = await import('../lib/companion.mjs');
  assert.equal(classify(1008, 'BidiGenerateContent session not found or expired'), 'SESSION_EXPIRED');
  assert.equal(classify(1008, 'API key not valid. Please pass a valid API key.'), 'AUTH_ERROR');
  assert.equal(classify(403, 'Permission denied'), 'AUTH_ERROR');
  assert.equal(classify(1008, 'Operation is not implemented, or supported, or enabled.'), 'PROTOCOL_ERROR');
  assert.equal(classify(1007, 'Request contains an invalid argument.'), 'PROTOCOL_ERROR');
  assert.equal(classify(1013, 'Service unavailable'), 'DISCONNECTED');
  assert.equal(classify(1011, 'RESOURCE_EXHAUSTED'), 'QUOTA_EXCEEDED');
});

test('retoma expirada abre sessão nova sem reenviar delegações nem apagar histórico, e preserva erros reais de chave', async t => {
  const env = await createTestEnv(t);
  const { hub, projectA } = env;
  hub.companion.env = { GEMINI_API_KEY: 'private-probe-key' };
  const conversation = await hub.companion.store.ensureActiveConversation(projectA.id);
  const saved = await hub.companion.store.appendMessage(projectA.id, conversation.id, { role: 'user', text: 'Mensagem anterior preservada.', modality: 'voice' });
  await hub.companion.store.updateConversationMetadata(projectA.id, conversation.id, meta => ({ ...meta, resumption: { handle: 'expired-private-handle', model: 'gemini-3.8-live', voiceMode: 'hands-free', updatedAt: new Date().toISOString() } }));
  const setups = [];
  let active;
  hub.companion.wsFactory = () => {
    const ws = new EventEmitterSocket(); active = ws;
    ws.onSend = raw => {
      const frame = JSON.parse(raw);
      if (!frame.setup) return;
      setups.push(frame.setup);
      if (frame.setup.sessionResumption?.handle) {
        queueMicrotask(() => ws.emit('close', 1008, Buffer.from('BidiGenerateContent session not found or expired')));
      } else queueMicrotask(() => ws.receive({ setupComplete: {} }));
    };
    queueMicrotask(() => ws.emit('open')); return ws;
  };
  let toolExecutions = 0;
  hub.companion.executeTool = async () => { toolExecutions++; return {}; };
  const client = new FakeClientSocket();
  const session = hub.companion.attachWebSocket(client, { projectId: projectA.id });
  await waitFor(() => client.sent.some(m => m.type === 'setup_complete'));
  assert.equal(setups.length, 2);
  assert.equal(setups[0].sessionResumption.handle, 'expired-private-handle');
  assert.deepEqual(setups[1].sessionResumption, {});
  assert.equal(session.publicState().status, 'listening');
  assert.ok(client.sent.some(m => m.type === 'warning' && m.code === 'SESSION_EXPIRED'));
  assert.equal(client.sent.some(m => m.type === 'error'), false);
  assert.equal(toolExecutions, 0);
  assert.equal((await hub.companion.store.readMessages(projectA.id, conversation.id)).messages[0].id, saved.message.id);
  assert.equal((await hub.companion.store.readMetadata(projectA.id, conversation.id)).resumption, null);
  // A genuine credential error must remain a terminal authentication error, without leaking the key.
  active.emit('close', 1008, Buffer.from('API key not valid: private-probe-key'));
  await waitFor(() => client.sent.some(m => m.type === 'error'));
  assert.equal(client.sent.findLast(m => m.type === 'error').code, 'AUTH_ERROR');
  assert.equal(setups.length, 2);
  assert.equal(JSON.stringify(client.sent).includes('private-probe-key'), false);
});

test('cor da mascote acompanha o cliente ativo do projeto e regressa ao selecionado', async () => {
  const { mascotColorProvider } = await import('../public/companion.js');
  const conversations = [
    { id: 'a', group: 'source', provider: 'claude', status: 'running', updatedAt: '2026-01-01T10:00:00Z', organization: { projectId: 'project' } },
    { id: 'b', group: 'other', provider: 'cursor', status: 'running', updatedAt: '2026-01-01T10:01:00Z', organization: { projectId: 'project' } },
    { id: 'c', group: 'different', provider: 'opencode', status: 'running', updatedAt: '2026-01-01T10:02:00Z', organization: { projectId: 'other-project' } },
  ];
  assert.equal(mascotColorProvider({ projectId: 'project', conversations, sourceGroupId: 'source', selectedProvider: 'codex' }), 'claude');
  assert.equal(mascotColorProvider({ projectId: 'project', conversations, selectedProvider: 'codex' }), 'cursor');
  assert.equal(mascotColorProvider({ projectId: 'other-project', conversations, selectedProvider: 'codex' }), 'opencode');
  assert.equal(mascotColorProvider({ projectId: 'empty-project', conversations, selectedProvider: 'claude' }), 'claude');
  assert.equal(mascotColorProvider({ projectId: 'empty-project', conversations, selectedProvider: 'claude', voiceStatus: 'responding' }), 'antigravity');
  assert.equal(mascotColorProvider({ projectId: null, conversations, selectedProvider: 'cursor' }), 'cursor');
});
