import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAction, actionPhrase, actionDuration, formatDuration, requestSummary, summaryLine, currentWork, activeActions } from '../public/actions.js';

// Shapes as each client records them (observed in real conversations).
const codexRead = { type: 'commandExecution', command: "bash -lc 'sed -n 1,40p lib/x.mjs'", commandActions: [{ type: 'read', command: 'sed', name: 'x.mjs', path: 'lib/x.mjs' }], status: 'completed', durationMs: 420, exitCode: 0 };
const codexSearch = { type: 'commandExecution', command: "rg -n hydraTask public", commandActions: [{ type: 'search', command: 'rg', query: 'hydraTask', path: 'public' }], status: 'completed', durationMs: 90, exitCode: 0 };
const codexPipeline = { type: 'commandExecution', command: 'npm test | tail', commandActions: [{ type: 'unknown', command: 'npm test' }, { type: 'unknown', command: 'tail' }], status: 'completed', exitCode: 1 };
const claudeRead = { type: 'mcpToolCall', server: 'Claude Code', tool: 'Read', parameters: { file_path: '/p/public/app.js', offset: 10, limit: 20 }, status: 'completed' };
const claudeGrep = { type: 'mcpToolCall', server: 'Claude Code', tool: 'Grep', parameters: { pattern: 'hydraTask', path: '/p/public' }, status: 'completed' };
const claudeEditRefused = { type: 'fileChange', server: 'Claude Code', tool: 'Edit', changes: [{ path: '/p/a.js', diff: '' }], status: 'declined', permissionDenied: true };
const agyRead = { type: 'mcpToolCall', server: 'Antigravity', tool: 'read_file', parameters: { Path: '/p/notas.md', StartLine: 1, EndLine: 20 }, status: 'completed' };
const agyHydra = { type: 'mcpToolCall', server: 'hydraq', tool: 'read_dialogue', parameters: { ServerName: 'hydraq', ToolName: 'read_dialogue' }, status: 'completed' };
const claudeHydra = { type: 'mcpToolCall', server: 'Claude Code', tool: 'mcp__hydraq_cx_ab12cd34_claude__send_to_peer', status: 'completed' };
const context = { type: 'mcpToolCall', server: 'hydraq_context', tool: 'get_project_memory', status: 'completed' };
const cursorRead = { type: 'mcpToolCall', server: 'Cursor', tool: 'Read AI_CHANGES.md (1 - 80)', nativeKind: 'read', parameters: { path: '/p/AI_CHANGES.md' }, locations: [{ path: '/p/AI_CHANGES.md' }], status: 'completed' };
const openCodeGlob = { type: 'webSearch', server: 'OpenCode', tool: 'glob', nativeKind: 'search', parameters: { pattern: '*.js' }, status: 'completed' };
const web = { type: 'webSearch', query: 'hydra cli', status: 'completed' };

test('cada cliente descrito em palavras, sem mudar os seus campos', () => {
  const cwd = '/p', phrase = item => actionPhrase(item, { cwd });
  assert.equal(phrase(codexRead), 'Ler lib/x.mjs');
  assert.equal(phrase(codexSearch), 'Procurar «hydraTask» em public');
  assert.equal(phrase(codexPipeline), "Correr npm test | tail");
  // As Codex records it, through a login shell.
  assert.equal(phrase({ type: 'commandExecution', command: "/bin/bash -lc 'wc -l notas.md'", commandActions: [{ type: 'unknown', command: 'wc -l notas.md' }], status: 'completed' }), 'Correr wc -l notas.md');
  assert.equal(phrase(claudeRead), 'Ler public/app.js · 10–29');
  assert.equal(phrase(claudeGrep), 'Procurar «hydraTask» em public');
  assert.equal(phrase(claudeEditRefused), 'Alterar a.js');
  assert.equal(phrase(agyRead), 'Ler notas.md · 1–20');
  assert.equal(actionPhrase(agyHydra, { live: true }), 'Hydra · a ler o diálogo');
  assert.equal(phrase(claudeHydra), 'Hydra · escrever ao parceiro');
  assert.equal(actionPhrase(context, { live: true }), 'A ler a memória do projeto');
  assert.equal(phrase(cursorRead), 'Ler AI_CHANGES.md');
  // OpenCode calls its file search «webSearch»; its own kind says it is a search in the project.
  assert.equal(describeAction(openCodeGlob).kind, 'search');assert.equal(phrase(openCodeGlob), 'Procurar ficheiros «*.js»');
  assert.equal(describeAction(web).kind, 'web');
  assert.equal(openCodeGlob.type, 'webSearch', 'o tipo original fica');
});

test('contagens só do que foi confirmado: ficheiros distintos, recusas e pesquisas separadas', () => {
  const items = [claudeRead, { ...claudeRead }, { ...claudeRead, parameters: { file_path: '/p/public/app.js', offset: 200 } }, agyRead, { ...agyRead, status: 'inProgress' }, { ...claudeRead, parameters: { file_path: '/p/b.js' }, status: 'failed' },
    claudeEditRefused, { type: 'fileChange', changes: [{ path: '/p/c.js' }, { path: '/p/d.js' }], status: 'completed' }, { type: 'fileChange', changes: [{ path: '/p/c.js' }], status: 'completed' },
    codexSearch, openCodeGlob, web, codexPipeline, { ...codexPipeline, exitCode: 0 }, { type: 'commandExecution', command: 'rm -rf x', status: 'declined', permissionDenied: true }]
    .map((item, index) => ({ ...item, id: 'i' + index, turnId: 't' }));
  const summary = requestSummary({ items }, { id: 't', status: 'completed', startedAt: '2026-10-28T10:00:00Z', completedAt: '2026-10-28T10:01:12Z' });
  assert.equal(summary.filesRead, 2, 'leituras repetidas do mesmo ficheiro contam uma vez; uma em curso e uma falhada não contam');
  assert.equal(summary.filesChanged, 2);assert.equal(summary.editsRefused, 1);assert.equal(summary.refused, 2);
  assert.equal(summary.searches, 2);assert.equal(summary.web, 1);
  assert.equal(summary.commands, 2);assert.equal(summary.commandsFailed, 1);assert.equal(summary.failed, 1);
  assert.equal(summaryLine(summary), 'Leu 2 ficheiros · alterou 2 ficheiros · 2 comandos (1 falhou) · 2 pesquisas no projeto · 1 pesquisa na web · 1 alteração recusada · 1 ação recusada · 1 ação com erro · 1 min 12 s');
});

test('duração do cliente separada do tempo medido; sem horas, sem duração; interrompida, sem duração', () => {
  assert.deepEqual(actionDuration(codexRead), { ms: 420, measured: false });
  assert.deepEqual(actionDuration({ ...claudeRead, at: '2026-10-28T10:00:00.000Z', completedAt: '2026-10-28T10:00:02.500Z' }), { ms: 2500, measured: true });
  assert.equal(actionDuration({ ...agyRead }), null, 'histórico sem horas: nada inventado');
  assert.equal(actionDuration({ ...agyRead, status: 'interrupted', at: '2026-10-28T10:00:00Z', completedAt: '2026-10-28T10:00:05Z' }), null);
  assert.deepEqual([formatDuration(0), formatDuration(420), formatDuration(12_400), formatDuration(72_000), formatDuration(3_780_000)], ['< 0,1 s', '0,4 s', '12 s', '1 min 12 s', '1 h 03 min']);
  // Codex measures quick commands as 0 ms: a real measure, shown as under a tenth of a second.
  assert.deepEqual(actionDuration({ ...codexRead, durationMs: 0 }), { ms: 0, measured: false });
});

test('ações em paralelo à vista, e nenhuma fica a correr depois de o pedido terminar', () => {
  const items = [{ ...claudeRead, id: 'a', turnId: 't', status: 'inProgress', at: '2026-10-28T10:00:00Z' }, { ...codexPipeline, id: 'b', turnId: 't', status: 'inProgress' }, { ...agyHydra, id: 'c', turnId: 't', status: 'inProgress' }, { id: 'r', turnId: 't', type: 'reasoning', status: 'inProgress' }];
  const conversation = { cwd: '/p', items, messages: [] };
  const work = currentWork(conversation, { id: 't', status: 'running' });
  assert.equal(work.title, '3 ações em curso');assert.equal(work.actions.length, 3);
  const single = currentWork({ ...conversation, items: [items[0]] }, { id: 't', status: 'running' });
  assert.equal(single.title, 'A ler public/app.js · 10–29');assert.equal(single.since, '2026-10-28T10:00:00Z');
  for (const status of ['interrupted', 'uncertain', 'failed', 'completed']) { assert.equal(currentWork(conversation, { id: 't', status }), null); assert.equal(activeActions(conversation, { id: 't', status }).length, 0); }
});
