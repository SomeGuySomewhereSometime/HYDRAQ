import { captureDraftIntent, draftMode } from './composer.js';
import { elicitationForm } from './elicitation.js';
import { ImageAttachments } from './attachments.js';
import { ComposerDrafts, draftKey } from './drafts.js';
import { ProjectUI, conversationGroups } from './projects.js';
import { ProjectMemoryUI } from './project-memory.js';
import { CollaborationUI } from './collaboration.js';

const $ = selector => document.querySelector(selector);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function icon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ui-icon' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6');
  svg.append(path);
  return svg;
}

function diffContent(target, text) {
  const fragment = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    const className = /^(@@|diff |index |---|\+\+\+)/.test(line) ? 'diff-heading'
      : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : '';
    fragment.append(element('span', `diff-line ${className}`, line || '\u200b'));
  }
  target.replaceChildren(fragment);
}

let state;
let token;
let selected = localStorage.getItem('hydraq.conversation') || null;
let selectedProject = localStorage.getItem('hydraq.project') || null;
let projectOverview = !selected && localStorage.getItem('hydraq.projectView') === 'true';
const composerDrafts = new ComposerDrafts();
const draftProviders = new Map();
const providerNames = { codex: 'Codex', antigravity: 'Antigravity', claude: 'Claude Code', cursor: 'Cursor' };
let selectedProvider = localStorage.getItem('hydraq.provider') || 'codex';
if (!providerNames[selectedProvider]) selectedProvider = 'codex';
// Client chosen for the next request of an existing conversation; a different one starts a handoff.
const switchTargets = new Map();
let sending = false;
let events;
let recoveryTimer;
let recoveryDelay = 1000;
let toastTimer;
let messageSignature = '';
let activitySignature = '';
let diffSignature;
let approvalsSignature = '';
let modelsSignature = '';
let progressSignature = '';
let composerIntent = null;
const settingDrafts = new Map();
const recoveryDrafts = new Map();
let settingsOwner;
let settingsBaseline;
const activeStatuses = ['starting', 'running', 'waiting'];
const imageAttachments = new ImageAttachments({composer:$('#composer'),getKey:()=>composerKey(),getToken:()=>token,isBusy:()=>anyBusy() || sending,changed:()=>renderSend(),toast});
const statusLabels = { idle: 'Pronta', starting: 'A iniciar…', running: 'A trabalhar…', waiting: 'A aguardar a tua resposta', completed: 'Concluída', interrupted: 'Interrompida', failed: 'Falhou', uncertain: 'Estado por confirmar', inProgress: 'Em execução' };
const effortLabels = { none: 'Sem raciocínio', minimal: 'Mínimo', low: 'Leve', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo', ultra: 'Ultra' };

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 9000);
}

async function api(route, body) {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-hydraq-token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'O pedido não foi concluído.'),{status:response.status});
  return result;
}

function providerId() { const conversation = current(); return conversation ? switchTargets.get(conversation.id) || conversation.provider : selectedProvider; }
function providerState(id = providerId()) { return state?.providers?.[id] || state || {}; }
function providerName(id = providerId()) { return providerNames[id] || id; }
function composerKey() { return draftKey(current(),selectedProject); }
function project() { return state?.projectCatalog?.projects.find(p=>p.id===(current()?.organization?.projectId || (!current()?selectedProject:null))); }
function settingsKey(conversation = current()) { return `${draftKey(conversation,selectedProject)}:${providerId()}`; }
function members(conversation = current()) { return conversation ? state.conversations.filter(entry => entry.group === conversation.group) : []; }
function switching(conversation = current()) { return Boolean(conversation && providerId() !== conversation.provider); }
function targetMember(conversation = current()) { return members(conversation).filter(entry => entry.provider === providerId()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null; }
function focusConversation(conversation = current()) { return members(conversation).find(entry => activeStatuses.includes(entry.status)) || conversation; }
function anyBusy() { return Boolean(state?.collaboration?.busy) || Boolean(state?.handoff) || Boolean(state?.conversations.some(entry => activeStatuses.includes(entry.status))); }
const uncertaintyKey = conversation => conversation.turns?.findLast(turn => turn.status === 'uncertain')?.requestId || conversation.updatedAt;
const needsUncertaintyReview = conversation => conversation.status === 'uncertain' && conversation.uncertaintyReview?.key !== uncertaintyKey(conversation);
function mapSandbox(sandbox, target) {
  if (target === 'codex') return ['ask', 'read-only', 'plan'].includes(sandbox) ? 'read-only' : 'workspace-write';
  if (target === 'cursor') return sandbox === 'ask' ? 'ask' : ['read-only','plan'].includes(sandbox) ? 'plan' : 'workspace-write';
  if (['ask', 'read-only', 'plan'].includes(sandbox)) return 'plan';
  return sandbox === 'accept-edits' ? 'accept-edits' : 'workspace-write';
}
function saferSandbox(source, existing, target) {
  const mapped = mapSandbox(source, target);
  const rank = mode => mode === 'ask' ? -1 : ['read-only','plan'].includes(mode) ? 0 : mode === 'accept-edits' ? 2 : 1;
  return existing && rank(existing) < rank(mapped) ? existing : mapped;
}
function saveSettingsDraft() {
  settingDrafts.set(settingsKey(), { model: $('#model').value, effort: $('#effort').value, sandbox: $('#sandbox').value, context: $('#context').value || null, fast: $('#fast').checked });
}

function current() { return state?.conversations.find(conversation => conversation.id === selected); }
function saveComposerDraft() {
  composerDrafts.save(composerKey(),$('#prompt').value,composerIntent,$('#cwd').value);
  if(!current())draftProviders.set(composerKey(),selectedProvider);
  if(settingsOwner===settingsKey())saveSettingsDraft();
}
function choose(id, projectId=selectedProject, overview=false, internal=false) {
  if(sending&&!internal){toast('Aguarda a confirmação do envio antes de mudar de conversa.');return;}
  saveComposerDraft();
  collaborationUI.show('conversations',false);
  setSidebar(false);
  selected=id;selectedProject=id?current()?.organization?.projectId||null:projectId;projectOverview=overview;
  if(current()?.provider)selectedProvider=current().provider;
  else selectedProvider=draftProviders.get(composerKey()) || project()?.defaults?.provider || selectedProvider;
  const draft=composerDrafts.get(composerKey());$('#prompt').value=draft.text;composerIntent=draft.intent;
  $('#cwd').value=current()?.cwd||project()?.root||draft.cwd||state?.defaultCwd||'';
  if(id)localStorage.setItem('hydraq.conversation',id);else localStorage.removeItem('hydraq.conversation');
  if(selectedProject)localStorage.setItem('hydraq.project',selectedProject);else localStorage.removeItem('hydraq.project');
  localStorage.setItem('hydraq.projectView',String(overview));
  messageSignature=activitySignature=approvalsSignature=progressSignature='';settingsOwner=null;render();
  if(!overview)$('#prompt').focus();
}
const projectUI=new ProjectUI({getState:()=>state,api,refresh:async()=>{state=await api('/api/state');render();},choose:id=>choose(id),openProject:id=>choose(null,id,true),newChat:id=>choose(null,id,false),toast,memory:id=>projectMemory.open(id)});
const projectMemory=new ProjectMemoryUI({api,getState:()=>state,getCurrent:current,getProject:project,getKey:composerKey,getProvider:providerId,toast,renderImages:(target,images)=>imageAttachments.renderMessage(target,images),changed:()=>render()});
const collaborationUI=new CollaborationUI({api,getState:()=>state,toast,changed:()=>render(),markdown});

function populateEfforts(value) {
  const model = providerState().models.find(entry => entry.id === $('#model').value);
  $('#effort').replaceChildren(...(model?.efforts || []).map(effort => {
    const option = element('option', '', effortLabels[effort] || effort);
    option.value = effort;
    return option;
  }));
  $('#effort').value = value || model?.defaultEffort || '';
  $('#model-description').textContent = model?.description || '';
}

function populateCursorOptions(context, fast = false) {
  const model = providerState().models.find(entry => entry.id === $('#model').value);
  const contexts = model?.contexts || [];
  $('#cursor-settings').classList.toggle('hidden', providerId() !== 'cursor');
  $('#context-field').classList.toggle('hidden', !contexts.length);
  $('#context').replaceChildren(...contexts.map(value => { const option=element('option','',value.toUpperCase());option.value=value;return option; }));
  $('#context').value = contexts.includes(context) ? context : model?.defaultContext || '';
  $('#fast-field').classList.toggle('hidden', !model?.supportsFast);
  $('#fast').checked = Boolean(model?.supportsFast && fast);
}

function draftSettings(conversation = current()) {
  return settingDrafts.get(settingsKey(conversation));
}

function cacheSupport(model) {
  if (providerId() === 'cursor') return { status: 'unknown', label: 'Sessão nativa do Cursor', detail: 'O Grok retoma o mesmo ID nativo. Mudar raciocínio, contexto ou Fast não garante reutilização de cache. O ACP não comunicou contadores de tokens nos ensaios.' };
  if (providerId() === 'claude') return { status: 'unknown', label: 'Cache de prompts do Claude', detail: 'A conversa retoma a sessão original do Claude Code pelo mesmo ID. A cache do servidor é por modelo e expira; mudar de modelo pode reprocessar o contexto. Os contadores mostram a cache efetivamente lida.' };
  if (providerId() === 'antigravity') return { status: 'unknown', label: 'Sessão nativa do Antigravity', detail: 'Gemini e Claude usam a sessão original do agy. Mudanças de modelo ou raciocínio retomam a conversa pelo mesmo ID; não há garantia de reutilização da cache.' };
  if (model?.supportsReasoningEffortUpdates === false) return { status: 'unsupported', label: 'Pode reprocessar contexto', detail: 'Este modelo não anuncia a mudança de raciocínio que conserva o prefixo. A sessão mantém-se, mas a cache pode ser afetada.' };
  if (model?.supportsReasoningEffortUpdates === true && providerState().reasoningUpdates?.enabled) return { status: 'supported', label: 'Conserva o prefixo ao mudar raciocínio', detail: 'Suporte anunciado pelo Codex e opção ativa. Funcionalidade experimental: conserva o prefixo no mesmo modelo; reutilizar a cache continua a depender da sua disponibilidade.' };
  return { status: 'unknown', label: 'Preservação não confirmada', detail: 'Não há confirmação suficiente para este modelo nesta ligação. A sessão mantém-se; não se garante a reutilização da cache ao mudar o raciocínio.' };
}

function renderCacheInfo(conversation) {
  const model = providerState().models.find(entry => entry.id === $('#model').value);
  const info = cacheSupport(model);
  const view = $('#cache-info');
  view.dataset.support = info.status;
  view.replaceChildren(element('strong', '', info.label), element('p', '', info.detail));
  const basis = conversation ? targetMember(conversation) : null;
  if (switching(conversation)) view.append(element('p', 'model-switch-warning', `Vais continuar no ${providerName()}: a cache e o raciocínio interno do ${providerName(conversation.provider)} não passam de um cliente para outro; segue a passagem de contexto.`));
  else if (conversation && model && model.id !== conversation.model) view.append(element('p', 'model-switch-warning', 'Vais mudar de modelo: a conversa mantém-se, mas a cache do modelo anterior pode não ser reutilizada.'));
  const source = element('a', '', 'Como funciona');
  source.href = { cursor: 'https://cursor.com/docs/cli/acp', antigravity: 'https://antigravity.google/docs/cli/headless/', claude: 'https://code.claude.com/docs/en/headless' }[providerId()] || 'https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation';
  source.target = '_blank'; source.rel = 'noopener noreferrer';
  view.append(source);
  $('#settings-hint').textContent = !conversation ? 'Aplicam-se ao primeiro pedido.' : !switching(conversation) ? 'Mesmo histórico e sessão. As escolhas aplicam-se ao próximo pedido.' : basis ? `Retoma a sessão do ${providerName()} desta conversa.` : `Cria uma sessão do ${providerName()} ligada a esta conversa.`;
  const table = element('table');
  const head = element('tr'); head.append(element('th', '', 'Modelo'), element('th', '', 'Ao mudar raciocínio'));
  table.append(head);
  for (const entry of providerState().models) {
    const row = element('tr');
    row.append(element('td', '', entry.name || entry.id), element('td', '', { supported: 'Conserva prefixo*', unsupported: 'Pode reprocessar', unknown: 'Não confirmado' }[cacheSupport(entry).status]));
    table.append(row);
  }
  $('#model-capabilities').replaceChildren(table, element('p', '', { cursor: 'A sessão é preservada; o ACP não confirma cache nem consumo por modelo.', antigravity: 'O protocolo do agy não confirma preservação de cache por modelo.', claude: 'O Claude Code não anuncia preservação por modelo; a cache lida aparece nos contadores de cada pedido.' }[providerId()] || '* Mesmo modelo, com a opção experimental ativa. Não garante acerto de cache.'));
}

function renderSettings(conversation) {
  const owner = settingsKey(conversation);
  const provider = providerId();
  const basis = conversation ? targetMember(conversation) : null;
  const group = members(conversation);
  const pendingSettings = !switching(conversation) ? conversation?.handoffState?.settings : null;
  const defaults=!conversation?project()?.defaults?.clients?.[provider]||{}:{};
  const baseline = JSON.stringify([!conversation?project()?.defaults:null,basis?.id,basis?.model,basis?.effort,basis?.sandbox,basis?.context,basis?.fast,pendingSettings]);
  $('#provider').value = provider;
  $('#provider').disabled = sending || Boolean(conversation && (anyBusy() || group.some(needsUncertaintyReview)));
  $('#provider-hint').textContent = { cursor: 'Cursor original · Grok da tua conta', antigravity: 'agy original · Gemini e Claude da tua conta', claude: 'Claude Code original · sessão claude.ai existente', codex: 'Codex original · sessão ChatGPT existente' }[provider] + (conversation ? ' · podes mudar de cliente entre pedidos' : '');
  $('#permissions-hint').textContent = { cursor: 'Autorizações, perguntas e planos aparecem na conversa. Planear/Perguntar são modos nativos; isolamento do sistema operativo não comprovado. Sem orientação do turno ativo.', antigravity: 'Políticas nativas do agy. Em headless, ações que exigem confirmação são recusadas pelo CLI. Sem steer neste protocolo.', claude: 'As autorizações do Claude Code aparecem na conversa. Perguntas interativas estão desativadas nesta versão. Sem steer: uma mensagem a meio ficaria em fila.' }[provider] || 'As autorizações adicionais aparecem na conversa.';
  if ($('#sandbox').dataset.provider !== provider) {
    $('#sandbox').dataset.provider = provider;
    const options = {
      antigravity: [['workspace-write','Executar · permissões do agy'],['accept-edits','Aceitar edições · modo accept-edits do agy'],['plan','Planear · modo plan do agy']],
      claude: [['workspace-write','Perguntar · autorizações na conversa'],['accept-edits','Aceitar edições · modo acceptEdits'],['plan','Planear · modo plan do Claude Code']],
      cursor: [['workspace-write','Executar · permissões nativas'],['plan','Planear · modo nativo'],['ask','Perguntar · modo nativo']],
      codex: [['workspace-write','Leitura e escrita'],['read-only','Só leitura']],
    }[provider];
    $('#sandbox').replaceChildren(...options.map(([value,label])=> { const option=element('option','',label);option.value=value;return option; }));
  }
  const signature = JSON.stringify([provider,providerState().models]);
  let catalogChanged = false;
  if (signature !== modelsSignature) {
    catalogChanged = true;
    const previous = $('#model').value;
    modelsSignature = signature;
    $('#model').replaceChildren(...providerState().models.map(model => {
      const option = element('option', '', model.name || model.id);
      option.value = model.id;
      return option;
    }));
    $('#model').value = providerState().models.some(model => model.id === previous) ? previous : (providerState().models.find(model => model.isDefault)?.id || providerState().models[0]?.id || '');
    populateEfforts();
  }
  if (conversation) {
    $('#cwd').value = conversation.cwd;
  } else if(project()) {
    $('#cwd').value = project().root;
  } else if (!$('#cwd').value) {
    $('#cwd').value = state.defaultCwd;
  }
  if (settingsOwner !== owner || catalogChanged || (!draftSettings(conversation) && settingsBaseline !== baseline)) {
    const draft = draftSettings(conversation);
    const wanted = draft?.model || pendingSettings?.model || basis?.model || defaults.model || $('#model').value;
    if(wanted && !providerState().models.some(m=>m.id===wanted)){const missing=element('option','',`${wanted} · indisponível`);missing.value=wanted;$('#model').append(missing);$('#model').value=wanted;}
    if (providerState().models.some(model => model.id === wanted)) $('#model').value = wanted;
    populateEfforts(draft?.effort || pendingSettings?.effort || basis?.effort || defaults.effort);
    populateCursorOptions(draft?.context ?? pendingSettings?.context ?? basis?.context ?? defaults.context, draft?.fast ?? pendingSettings?.fast ?? basis?.fast ?? defaults.fast ?? false);
    if (conversation) $('#sandbox').value = draft?.sandbox || pendingSettings?.sandbox || (switching(conversation) ? saferSandbox(conversation.sandbox, basis?.sandbox, provider) : basis?.sandbox || conversation.sandbox);
    else $('#sandbox').value = draft?.sandbox || 'workspace-write';
    settingsOwner = owner;
    settingsBaseline = baseline;
  }
  $('#cwd').disabled = Boolean(conversation) || Boolean(project()) || sending;
  const locked = sending || providerState().connection !== 'connected' || anyBusy() || group.some(needsUncertaintyReview) || basis?.status === 'uncertain';
  for (const selector of ['#model', '#effort', '#sandbox', '#context', '#fast']) $(selector).disabled = locked;
  $('#handoff-box').classList.toggle('hidden', !switching(conversation));
  if (switching(conversation)) {
    const source = providerName(conversation.provider), target = providerName();
    $('#handoff-mode').disabled = locked;
    $('#handoff-hint').textContent = ($('#handoff-mode').value === 'quick'
      ? `Sem pedido extra: o ${target} recebe os teus pedidos, as respostas, os ficheiros e comandos observados e o estado git.`
      : `O ${source} faz primeiro um pedido extra para resumir decisões e pendentes. O HYDRAQ verifica o conteúdo dos ficheiros antes e depois; se detetar mudanças, bloqueia a passagem. O ${target} recebe o resumo e os factos observados.`)
      + (basis ? ` Retoma a sessão original do ${target} e envia só o que aconteceu desde então.` : ` Cria uma sessão do ${target} ligada a esta conversa.`);
  }
  renderCacheInfo(conversation);
}

function renderSidebar() {
  projectUI.render({projectId:selectedProject,group:current()?.group,overview:projectOverview});
}

function inlineText(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const part = match[0];
    if (part.startsWith('`')) parent.append(element('code','',part.slice(1,-1)));
    else if (part.startsWith('**')) parent.append(element('strong','',part.slice(2,-2)));
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      const anchor = element('a','',link[1]);
      anchor.href = link[2];
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      parent.append(anchor);
    }
    cursor = match.index + part.length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

function markdown(text) {
  const container = element('div','message-content');
  const languages = [...text.matchAll(/```([^\n]*)\n[\s\S]*?(?:```|$)/g)].map(match => match[1].trim());
  const blocks = text.split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
  blocks.forEach((block, index) => {
    if (index % 2) {
      const pre = element('pre');
      const code = block.replace(/\n$/, '');
      const language = languages[(index - 1) / 2] || 'Texto';
      const wrapper = element('div', 'code-block');
      const heading = element('div', 'code-heading');
      const copy = element('button', 'copy-code', 'Copiar');
      copy.type = 'button';
      copy.setAttribute('aria-label', `Copiar código · ${language}`);
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code); copy.textContent = 'Copiado'; }
        catch { toast('Não foi possível copiar. Seleciona o código para o copiar.'); }
      });
      heading.append(element('span', '', language), copy);
      const content = element('code', '', code);
      if (/^(diff|patch)$/i.test(language)) diffContent(content, code);
      pre.append(content);
      wrapper.append(heading, pre);
      container.append(wrapper);
    } else {
      for (const paragraph of block.split(/\n\s*\n/)) {
        if (!paragraph.trim()) continue;
        if (/^#{1,6} /.test(paragraph)) {
          const heading = element('h3');
          inlineText(heading, paragraph.replace(/^#{1,6} /,''));
          container.append(heading);
        } else if (paragraph.split('\n').every(line => /^\s*(?:[-*]|\d+\.) /.test(line))) {
          const list = element(/^\s*\d+\./.test(paragraph) ? 'ol' : 'ul');
          for (const line of paragraph.split('\n')) {
            const item = element('li');
            inlineText(item,line.replace(/^\s*(?:[-*]|\d+\.) /,''));
            list.append(item);
          }
          container.append(list);
        } else {
          const node = element('p');
          inlineText(node,paragraph);
          container.append(node);
        }
      }
    }
  });
  return container;
}

const welcomeTemplate = $('#welcome').cloneNode(true);
function wireSuggestions() {
  for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => {
    $('#prompt').value = button.dataset.prompt;
    composerIntent = captureDraftIntent(null, $('#prompt').value, current());
    $('#prompt').focus();
    renderSend();
  });
}

function internalMessage(message, owner) {
  const name = providerName(owner.provider);
  if (message.role === 'user') return element('p', 'handoff-note', `HYDRAQ pediu ao ${name} ${message.internal==='memory-proposal'?'uma proposta de memória':'um resumo de passagem'} · ${new Date(message.at).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})}`);
  const details = element('details', 'handoff-summary');
  details.append(element('summary', '', `${message.internal==='memory-proposal'?'Proposta de memória':'Resumo de passagem'} · ${name}${message.streaming ? ' · a escrever…' : ''}`), markdown(message.text));
  return details;
}

function pendingHandoff(entry) {
  const pending = entry.handoffState;
  const article = element('article', 'message user');
  const header = element('div', 'message-header');
  header.append(element('span', 'avatar', 'TU'), element('span', '', `Tu · para o ${providerName(entry.provider)}`));
  const content = element('div', 'message-content');
  content.append(element('p', '', pending.text));
  imageAttachments.renderMessage(content,pending.attachments);
  const from = providerName(pending.from), to = providerName(entry.provider);
  const status = {
    summarizing: `A aguardar o resumo do ${from}; depois segue para o ${to}.`,
    sending: `A enviar ao ${to} com o contexto da passagem…`,
    failed: `Passagem não concluída: ${pending.error} Podes enviar de novo daqui (segue só a passagem rápida) ou voltar ao ${from}.`,
  }[pending.status];
  article.append(header, content, element('p', `handoff-status handoff-${pending.status}`, status));
  return article;
}

function renderMessages(conversation) {
  const group = members(conversation);
  const signature = JSON.stringify([conversation?.id, group.map(entry => [entry.id, entry.messages, entry.turns?.map(turn=>[turn.id,turn.requestId,turn.status,turn.usage,turn.nativeTurnUsage]), entry.handoffState])]);
  if (signature === messageSignature) return;
  messageSignature = signature;
  const view = $('#messages');
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 120;
  const oldScroll = view.scrollTop;
  imageAttachments.resetObservers();
  view.replaceChildren();
  const timeline = group.flatMap(owner => owner.messages.map(message => ({ message, owner }))).sort((a, b) => a.message.at.localeCompare(b.message.at));
  if (!timeline.length && !group.some(entry => entry.handoffState)) {
    view.append(welcomeTemplate.cloneNode(true));
    wireSuggestions();
    return;
  }
  let previousOwner = null;
  for (const { message, owner } of timeline) {
    if (message.internal) { view.append(internalMessage(message, owner)); continue; }
    if (previousOwner && previousOwner !== owner.id) view.append(element('div', 'provider-divider', `Continuação no ${providerName(owner.provider)}`));
    previousOwner = owner.id;
    const article = element('article', `message ${message.role}${message.kind === 'steer' ? ' steering-message' : ''}`);
    article.dataset.provider = owner.provider;
    const header = element('div', 'message-header');
    const avatar = element('span', 'avatar', message.role === 'user' ? 'TU' : '');
    if (message.role !== 'user') avatar.append(icon());
    header.append(avatar);
    header.append(element('span','',message.role === 'user' ? (message.kind === 'steer' ? 'Tu · Orientação' : 'Tu') : providerName(owner.provider)));
    if (message.model) {
      const modelName = providerState(owner.provider).models?.find(model => model.id === message.model)?.name || message.model;
      header.append(element('span', 'message-model', `${modelName} · ${effortLabels[message.effort] || message.effort || ''}`));
    }
    const time = element('time','',new Date(message.at).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'}));
    time.dateTime = message.at;
    header.append(time);
    article.append(header);
    if (message.role === 'user') {
      const content = element('div','message-content');
      content.append(element('p','',message.text));
      imageAttachments.renderMessage(content,[...(message.attachments||[]),...(message.contextImages||[])]);
      article.append(content);
      if(message.projectContext){const details=element('details','handoff-context');details.append(element('summary','','Contexto do projeto enviado com este pedido'),element('pre','',message.projectContext));article.append(details);}
      if (message.handoffContext) {
        const details = element('details', 'handoff-context');
        details.append(element('summary', '', `Contexto da passagem enviado com este pedido · ${formatTokens(message.handoffContext.length)} caracteres`), element('pre', '', message.handoffContext));
        article.append(details);
      }
    } else {
      article.append(markdown(message.text));
      if (message.streaming) article.lastElementChild.append(element('span','streaming-indicator'));
      const turn = owner.turns?.find(turn => turn.requestId === message.requestId || turn.id === message.turnId);
      const finalMessage = !owner.messages.slice(owner.messages.indexOf(message) + 1).some(next => next.role === 'assistant' && (next.requestId === message.requestId || next.turnId === message.turnId));
      if (turn?.usage && finalMessage) article.append(element('p', 'message-usage', `Entrada: ${formatTokens(turn.usage.inputTokens)} · Em cache: ${formatTokens(turn.usage.cachedInputTokens)} (${turn.usage.cachePercent}%) · Sem cache: ${formatTokens(turn.usage.uncachedInputTokens)}`));
      else if (turn?.nativeTurnUsage && finalMessage) article.append(element('p', 'message-usage', `Neste pedido — Entrada: ${formatTokens(turn.nativeTurnUsage.input_tokens)} · Leitura de cache: ${formatTokens(turn.nativeTurnUsage.cache_read_tokens)} · Saída: ${formatTokens(turn.nativeTurnUsage.output_tokens)} · Raciocínio: ${formatTokens(turn.nativeTurnUsage.thinking_tokens)}`));
    }
    if (message.kind === 'steer') {
      const label = element('p', `steer-delivery delivery-${message.delivery || 'uncertain'}`, {
        sending: 'A enviar orientação…', accepted: 'Recebida pelo Codex no mesmo turno', rejected: 'Orientação não entregue', uncertain: 'Entrega não confirmada · não foi reenviada',
      }[message.delivery || 'uncertain']);
      article.append(label);
      if (message.error) article.append(element('p', 'steer-error', message.error));
    }
    view.append(article);
  }
  for (const entry of group) if (entry.handoffState) {
    if (previousOwner && previousOwner !== entry.id) view.append(element('div', 'provider-divider', `Continuação no ${providerName(entry.provider)}`));
    view.append(pendingHandoff(entry));
  }
  view.scrollTop = nearBottom ? view.scrollHeight : oldScroll;
}

function renderProgress(conversation) {
  const progress = conversation?.progress;
  const view = $('#progress-panel');
  view.classList.toggle('hidden', !progress);
  const signature = JSON.stringify(progress);
  if (signature === progressSignature) return;
  progressSignature = signature;
  const expanded = Boolean(view.querySelector('details')?.open);
  view.replaceChildren();
  if (!progress) return;
  view.dataset.status = progress.status;
  const heading = element('div', 'progress-heading');
  const symbol = { completed:'✓', failed:'!', interrupted:'■', uncertain:'?' }[progress.status] || '◌';
  heading.append(element('span', 'progress-symbol', symbol), element('strong', '', progress.title));
  const counts = progress.counts;
  const countText = [`${counts.completed} ${counts.completed === 1 ? 'ação concluída' : 'ações concluídas'}`, ...(counts.running ? [`${counts.running} em curso`] : []), ...(counts.failed ? [`${counts.failed} com erro`] : []), ...(counts.declined ? [`${counts.declined} ${counts.declined === 1 ? 'recusada' : 'recusadas'}`] : [])].join(' · ');
  heading.append(element('span', 'progress-counts', countText));
  view.append(heading);
  if (progress.detail) view.append(element('p', 'progress-detail', progress.detail));
  if (progress.commentary && progress.status !== 'completed') view.append(element('p', 'progress-commentary', `${providerName(conversation.provider)}: ${progress.commentary}`));
  if (progress.steps.length || progress.actions.length) {
    const details = element('details', 'progress-details');
    details.open = expanded;
    details.append(element('summary', '', progress.steps.length ? `Plano e ações · ${progress.completedSteps} de ${progress.steps.length} passos marcados como concluídos` : 'Ver ações deste pedido'));
    if (progress.explanation) details.append(element('p', '', progress.explanation));
    if (progress.steps.length) {
      const list = element('ol', 'progress-plan');
      for (const step of progress.steps) {
        const item = element('li');
        item.dataset.status = step.status;
        const terminal = !activeStatuses.includes(progress.status);
        const label = step.status === 'completed' ? 'Concluído' : step.status === 'inProgress' ? (terminal ? 'Não concluído' : 'Em curso') : 'Pendente';
        item.append(element('span', '', step.step), element('small', '', label));
        list.append(item);
      }
      details.append(list);
    }
    if (progress.actions.length) {
      const list = element('ul', 'progress-actions');
      for (const action of [...progress.actions].reverse()) {
        const item = element('li');
        item.dataset.status = action.status;
        const label = { completed:'Concluída', inProgress:'Em curso', failed:'Com erro', declined:'Recusada', unfinished:'Sem conclusão confirmada', interrupted:'Interrompida', cancelled:'Cancelada' }[action.status] || action.status;
        item.append(element('span', '', action.detail || action.type), element('small', '', label));
        list.append(item);
      }
      details.append(element('h4', '', 'Ações observadas'), list);
    }
    view.append(details);
  }
}

function formatTokens(value) { return new Intl.NumberFormat('pt-PT').format(value); }

function renderTurnUsage(conversation) {
  const turn = conversation?.turns?.at(-1);
  const view = $('#turn-usage');
  view.classList.toggle('hidden', !conversation);
  view.replaceChildren(element('h3', '', 'Último pedido'));
  if (conversation?.provider === 'antigravity') {
    view.replaceChildren(element('h3','','Totais nativos da sessão'));
    const usage = turn?.nativeUsage || conversation.nativeUsage;
    if (!usage) { view.append(element('p','','A aguardar os contadores do agy…')); return; }
    if (turn?.nativeTurnUsage) {
      const turnMetrics = element('dl');
      for (const [label,key] of [['Pedido · Entrada','input_tokens'],['Pedido · Cache lida','cache_read_tokens'],['Pedido · Saída','output_tokens'],['Pedido · Raciocínio','thinking_tokens']]) turnMetrics.append(element('dt','',label),element('dd','',formatTokens(turn.nativeTurnUsage[key])));
      view.append(turnMetrics);
    }
    const metrics=element('dl');
    for (const [label,key] of [['Sessão · Entrada','input_tokens'],['Sessão · Leitura de cache','cache_read_tokens'],['Sessão · Saída','output_tokens'],['Sessão · Raciocínio','thinking_tokens']]) metrics.append(element('dt','',label),element('dd','',formatTokens(usage[key])));
    view.append(metrics,element('small','','Contadores nativos do CLI (último pedido e acumulado da sessão), sem conversão para a cache do Codex.'));return;
  }
  if (conversation?.provider === 'cursor') { view.append(element('p','','Contadores de tokens/cache indisponíveis neste protocolo.')); return; }
  const name = providerName(conversation?.provider);
  if (!turn?.usage) {
    view.append(element('p', '', turn && activeStatuses.includes(turn.status) ? `A aguardar os contadores do ${name}…` : 'Sem medição separada para este pedido. Os pedidos anteriores à atualização mantêm apenas os totais da sessão.'));
    return;
  }
  const usage = turn.usage;
  const metrics = element('dl');
  for (const [label, value] of [['Entrada', usage.inputTokens], ['Reutilizados da cache', usage.cachedInputTokens], ['Entrada sem cache', usage.uncachedInputTokens], ['Saída', usage.outputTokens]]) {
    metrics.append(element('dt', '', label), element('dd', '', formatTokens(value)));
  }
  if (Number.isFinite(usage.cachePercent) && usage.inputTokens > 0) {
    const bar = element('div', 'cache-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${usage.cachePercent}% da entrada reutilizada; ${100 - usage.cachePercent}% sem cache`);
    const fill = element('span');
    // SVG width attributes work with the existing policy that blocks inline styles.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', `${Math.max(0, Math.min(100, usage.cachePercent))}%`);
    svg.setAttribute('height', '6');
    svg.setAttribute('aria-hidden', 'true');
    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    rect.setAttribute('width', '100%'); rect.setAttribute('height', '6'); rect.setAttribute('fill', 'currentColor');
    svg.append(rect); fill.append(svg); bar.append(fill); view.append(bar);
  }
  view.append(metrics, element('p', 'cache-percentage', `${usage.cachePercent}% da entrada reutilizada`), element('small', '', conversation.provider === 'claude' ? 'Tokens comunicados pelo Claude Code. Não equivalem diretamente aos limites da subscrição Claude.' : 'Tokens comunicados pelo Codex. Não equivalem diretamente à quota ChatGPT.'));
}

function itemDescription(item) {
  if (item.type === 'commandExecution') return item.command || 'Executar comando';
  if (item.type === 'fileChange') return (item.changes || []).map(change => change.path.split('/').at(-1)).join(', ') || 'Alterar ficheiros';
  if (item.type === 'subagent') return `Subagente · ${item.detail || (item.subagents || []).join(', ') || 'delegação'}`;
  if (item.type === 'mcpToolCall') return `${item.server || ''} / ${item.tool || 'Ferramenta'}`;
  if (item.type === 'webSearch') return item.query || 'Pesquisar na web';
  if (item.type === 'reasoning') return 'Analisar o pedido';
  if (item.type === 'plan') return 'Organizar o trabalho';
  return item.type || `Atividade do ${providerName()}`;
}

function renderActivity(conversation) {
  const items = members(conversation).flatMap(owner => owner.items.map(item=>({...item,provider:owner.provider}))).sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  const signature = JSON.stringify([conversation?.id,items]);
  if (signature !== activitySignature) {
    activitySignature = signature;
    const open = new Set([...$('#activity').querySelectorAll('details[open]')].map(node => node.dataset.id));
    $('#activity-count').textContent = String(items.length).padStart(2,'0');
    const view = $('#activity');
    view.replaceChildren();
    if (!items.length) {
      const empty = element('div','empty-activity');
      empty.append(icon(),element('p','','O trabalho aparece aqui.'),element('small','','Comandos, ferramentas e alterações, à medida que acontecem.'));
      view.append(empty);
    }
    for (const item of [...items].reverse()) {
      const details = element('details','activity-item');
      details.dataset.id = item.id;
      details.dataset.status = item.status || 'inProgress';
      details.open = open.has(item.id);
      details.append(element('summary','',`${providerName(item.provider)}${item.parentToolUseId ? ' · Subagente' : ''} · ${itemDescription(item)}`));
      const statusText = item.permissionDenied ? (item.provider === 'antigravity' ? 'Recusada pela política headless do agy' : 'Recusada') : (statusLabels[item.status] || item.status || 'Em execução');
      details.append(element('small','',`${statusText}${item.exitCode !== undefined && item.exitCode !== null ? ` · saída ${item.exitCode}` : ''}`));
      let output = item.aggregatedOutput || item.text || '';
      if (!output && item.changes) output = item.changes.map(change => `${change.path}\n${change.diff || ''}`).join('\n\n');
      if (!output && item.summary) output = Array.isArray(item.summary) ? item.summary.join('\n') : String(item.summary);
      if (!output && item.result) output = JSON.stringify(item.result,null,2);
      if (!output && item.error) output = JSON.stringify(item.error,null,2);
      if (output) {
        const pre = element('pre', '', output);
        if (item.type === 'fileChange') diffContent(pre, output);
        details.append(pre);
      }
      view.append(details);
    }
  }
  $('#diff-panel').classList.toggle('hidden', !conversation?.diff);
  const diff = conversation?.diff || '';
  if (diffSignature !== diff) {
    diffSignature = diff;
    diffContent($('#diff'), diff);
  }
  const total = { antigravity: conversation?.nativeUsage?.total_tokens, claude: conversation?.sessionUsage?.totalTokens }[conversation?.provider] ?? conversation?.tokenUsage?.total?.totalTokens;
  $('#usage').textContent = total ? `${new Intl.NumberFormat('pt-PT').format(total)} tokens · sessão` : (conversation ? statusLabels[conversation.status] || conversation.status : 'Pronto para começar');
}

function approvalButton(label, callback, secondary = false) {
  const button = element('button',secondary ? 'secondary' : '',label);
  button.type = 'button';
  button.addEventListener('click',async () => {
    button.disabled = true;
    try { await callback(); } catch (error) { toast(error.message); button.disabled = false; }
  });
  return button;
}

function renderApprovals(conversation) {
  const ids = new Set(members(conversation).map(entry => entry.id));
  const requests = state.approvals.filter(request => ids.has(request.conversationId));
  const approvalItem = request => members(conversation).find(entry=>entry.id===request.conversationId)?.items.find(item=>
    (request.params.itemId && item.id===request.params.itemId) || (request.params.toolCall?.toolCallId && item.nativeId===request.params.toolCall.toolCallId));
  const signature = JSON.stringify(requests.map(request=>[request,approvalItem(request)]));
  if (signature === approvalsSignature) return;
  approvalsSignature = signature;
  $('#approvals').replaceChildren();
  for (const request of requests) {
    const card = element('section','approval');
    const respond = result => api('/api/respond',{id:request.id,...result});
    if (request.method === 'session/request_permission') {
      card.append(element('h3','','O Cursor precisa da tua autorização'), element('pre','',request.params.toolCall?.title || 'Ferramenta do Cursor'));
      const tool = request.params.toolCall || {};
      const item = approvalItem(request), input = tool.rawInput || item?.parameters;
      const locations = tool.locations || item?.locations;
      if (input) card.append(element('pre','',typeof input === 'string' ? input : JSON.stringify(input,null,2)));
      if (locations?.length) card.append(element('p','',`Caminhos: ${locations.map(location=>location.path).join(', ')}`));
      for (const block of tool.content || []) if (block.type === 'diff') card.append(element('pre','',`${block.path}\nAntes:\n${block.oldText || ''}\nDepois:\n${block.newText || ''}`));
      if (!(tool.content || []).some(block=>block.type==='diff') && item?.changes?.length) card.append(element('pre','',item.changes.map(change=>`${change.path}\n${change.diff || ''}`).join('\n\n')));
      const labels={allow_once:'Permitir desta vez',allow_always:'Permitir sempre',reject_once:'Recusar',reject_always:'Recusar sempre'};
      for (const option of request.params.options || []) card.append(approvalButton(labels[option.kind] || option.name,()=>respond({optionId:option.optionId}),option.kind?.startsWith('reject')));
      card.append(approvalButton('Parar tarefa',()=>respond({decision:'cancel'}),true));
    } else if (request.method === 'cursor/ask_question') {
      card.append(element('h3','',request.params.title || 'O Cursor tem uma pergunta'));
      const fields=[];
      for (const question of request.params.questions) {
        const group=element('fieldset','cursor-question'); group.append(element('legend','',question.prompt));
        const choices=[];
        for (const option of question.options) {
          const label=element('label','toggle-field'), input=element('input');
          input.type=question.allowMultiple?'checkbox':'radio';input.name=`cursor-${request.id}-${question.id}`;input.value=option.id;
          label.append(input,document.createTextNode(option.label));group.append(label);choices.push(input);
        }
        fields.push({id:question.id,choices});card.append(group);
      }
      card.append(approvalButton('Responder',()=>respond({answers:fields.map(field=>({questionId:field.id,selectedOptionIds:field.choices.filter(input=>input.checked).map(input=>input.value)}))})),approvalButton('Parar tarefa',()=>respond({decision:'cancel'}),true));
    } else if (request.method === 'cursor/create_plan') {
      card.append(element('h3','',request.params.name || 'Rever o plano do Cursor'));
      if (request.params.overview) card.append(element('p','',request.params.overview));
      const plan=element('div','cursor-plan');plan.append(markdown(request.params.plan));card.append(plan);
      card.append(element('p','','Aceitar o plano mantém as autorizações das ferramentas.'));
      card.append(approvalButton('Aceitar plano',()=>respond({decision:'accept'})),approvalButton('Rejeitar plano',()=>respond({decision:'decline'}),true),approvalButton('Parar tarefa',()=>respond({decision:'cancel'}),true));
    } else if (request.method.endsWith('/requestApproval')) {
      card.append(element('h3','','O Codex precisa da tua autorização'));
      if (request.params.reason) card.append(element('p','',request.params.reason));
      if (request.params.command) card.append(element('pre','',request.params.command));
      if (request.params.cwd) card.append(element('p','',`Pasta: ${request.params.cwd}`));
      if (request.params.grantRoot) card.append(element('p','',`Acesso adicional: ${request.params.grantRoot}`));
      if (request.params.itemId) {
        const item = approvalItem(request);
        if (item?.changes) card.append(element('pre','',item.changes.map(change => `${change.path}\n${change.diff || ''}`).join('\n\n')));
      }
      card.append(approvalButton('Permitir desta vez',()=>respond({decision:'accept'})),approvalButton('Recusar',()=>respond({decision:'decline'}),true),approvalButton('Parar tarefa',()=>respond({decision:'cancel'}),true));
    } else if (request.method === 'claude/canUseTool') {
      const input = request.params.input || {};
      card.append(element('h3','',`O Claude Code pede autorização: ${request.params.displayName || request.params.toolName}`));
      if (request.params.description) card.append(element('p','',request.params.description));
      const preview = input.command || input.plan || (input.file_path ? `${input.file_path}\n${input.content ?? input.new_string ?? ''}` : JSON.stringify(input,null,2));
      card.append(element('pre','',String(preview).slice(0,8000)));
      if (request.params.blockedPath) card.append(element('p','',`Caminho: ${request.params.blockedPath}`));
      card.append(approvalButton('Permitir desta vez',()=>respond({decision:'accept'})),approvalButton('Recusar',()=>respond({decision:'decline'}),true),approvalButton('Parar tarefa',()=>respond({decision:'cancel'}),true));
    } else if (request.method === 'tool/requestUserInput') {
      card.append(element('h3','','O Codex tem uma pergunta'));
      const fields = new Map();
      for (const question of request.params.questions) {
        const label = element('label','',question.question);
        let choice;
        if (question.options?.length) {
          choice = element('select');
          choice.append(element('option','','Escolher uma opção…'));
          choice.firstElementChild.value = '';
          for (const option of question.options) {
            const entry = element('option','',option.label);
            entry.value = option.label;
            entry.title = option.description;
            choice.append(entry);
          }
          label.append(choice);
        }
        const input = element('input');
        input.type = question.isSecret ? 'password' : 'text';
        input.placeholder = choice ? 'Ou escreve a tua resposta' : 'A tua resposta';
        label.append(input);
        card.append(label);
        fields.set(question.id,{choice,input});
      }
      card.append(approvalButton('Responder',()=>respond({answers:Object.fromEntries([...fields].map(([id,{choice,input}])=>[id,input.value || choice?.value || '']))})));
    } else {
      card.append(element('h3','','Pedido de uma ferramenta ligada ao Codex'));
      card.append(element('p','',request.params.message || 'Revê o pedido antes de responder.'));
      if (request.params.url) {
        try {
          const url = new URL(request.params.url);
          if (['http:','https:'].includes(url.protocol)) {
            const link = element('a','','Abrir página solicitada');
            link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
          }
        } catch { /* Invalid external URLs remain plain text in the request. */ }
      }
      const form = elicitationForm(request.params.requestedSchema);
      card.append(form.container);
      card.append(approvalButton('Confirmar',()=>respond({action:'accept',content:form.read()})),approvalButton('Recusar',()=>respond({action:'decline'}),true));
    }
    $('#approvals').append(card);
  }
}

function renderSend() {
  const busy = anyBusy();
  const conversation = current();
  const focus = focusConversation(conversation);
  const moving = switching(conversation);
  const mode = draftMode(composerIntent, conversation);
  const steering = mode === 'steer';
  const expired = mode === 'expired-steer';
  const pending = conversation?.messages.some(message => message.kind === 'steer' && message.delivery === 'sending');
  const hasImages=imageAttachments.list().length>0;
  imageAttachments.render(busy || sending || providerState().capabilities?.images===false);
  $('#send').disabled = !state || Boolean(state?.projectCatalog?.error || project()?.archived || current()?.organization?.archived || project()?.available===false) || !providerState().models?.some(m=>m.id===$('#model').value) || providerState().connection !== 'connected' || expired || (busy && (!steering || hasImages)) || sending || pending || (!$('#prompt').value.trim() && !hasImages) || (hasImages && providerState().capabilities?.images===false) || members(conversation).some(needsUncertaintyReview) || (!moving && conversation?.status === 'uncertain') || (moving && targetMember(conversation)?.status === 'uncertain');
  const passing = state?.handoff && members(conversation).some(entry => entry.id === state.handoff.conversationId);
  $('#stop').classList.toggle('hidden', !passing && !activeStatuses.includes(focus?.status));
  $('#send').textContent = sending ? 'A enviar…' : expired ? 'Turno terminado' : steering ? 'Orientar ↗' : moving ? `Continuar no ${providerName()} ↗` : 'Enviar ↗';
  $('#steer-mode').classList.toggle('hidden', !steering && !expired);
  $('#steer-title').textContent = expired ? 'O turno desta orientação já terminou.' : '↳ Orientar a tarefa em curso';
  $('#steer-description').textContent = expired ? 'O texto foi guardado. Escolhe usá-lo como novo pedido ou limpa-o.' : 'A orientação mantém o pedido atual.';
  $('#use-as-request').classList.toggle('hidden', !expired);
  $('#use-as-request').disabled = sending;
  $('#composer').classList.toggle('steering', steering || expired);
  $('#prompt').placeholder = steering ? 'Acrescenta uma orientação para a tarefa em curso…' : 'Descreve o que queres fazer…';
  $('#composer-hint').textContent = state?.handoff ? 'Passagem entre clientes em curso. Aguarda ou usa Parar.' : focus?.capabilities?.steer === false && busy ? `O ${providerName(focus.provider)} não suporta orientar durante o turno. Aguarda ou usa Parar.` : moving ? `Enter para continuar no ${providerName()} · a passagem segue com este pedido` : expired ? 'A orientação não foi enviada.' : steering ? (conversation.status === 'waiting' ? 'Orientar não aprova as ações pendentes.' : 'Enter para orientar · Mantém o mesmo turno') : 'Enter para enviar · Shift + Enter para nova linha';
}

function renderUncertainty(conversation) {
  let panel = $('#uncertainty-panel');
  if (!panel) { panel = element('section','uncertainty-panel hidden'); panel.id = 'uncertainty-panel'; $('#notice').after(panel); }
  const uncertain = members(conversation).filter(entry => entry.status === 'uncertain');
  panel.classList.toggle('hidden', !uncertain.length);
  const signature = JSON.stringify([uncertain.map(entry => [entry.id,uncertaintyKey(entry),entry.uncertaintyReview]),anyBusy(),sending]);
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  panel.replaceChildren();
  for (const entry of uncertain) {
    panel.append(element('p','',needsUncertaintyReview(entry)
      ? `${providerName(entry.provider)} terminou sem confirmar o resultado. Inspeciona os ficheiros e as ações antes de continuares; o pedido pode já ter causado alterações.`
      : `Autorizaste continuar com o resultado incerto do ${providerName(entry.provider)}. Escolhe outro cliente e a passagem rápida; a sessão incerta continua bloqueada e o aviso segue no contexto.`));
    if (needsUncertaintyReview(entry)) {
      const button = element('button','use-as-request','Verifiquei o estado · permitir continuar noutro cliente');
      button.disabled = anyBusy() || sending;
      button.addEventListener('click',async()=> {
        button.disabled = true;
        try {
          await api(`/api/conversations/${entry.id}/acknowledge-uncertainty`,{expectedRequestId:uncertaintyKey(entry)});
          state = await api('/api/state'); $('#handoff-mode').value = 'quick'; render();
        } catch(error) { button.disabled = false; toast(error.message); }
      });
      panel.append(button);
    }
  }
}

function renderHandoffRecovery(conversation) {
  const view = $('#handoff-recovery-panel');
  const owner = members(conversation).find(entry=>entry.handoffRecovery?.status==='required');
  view.classList.toggle('hidden', !owner);
  const signature = owner?.handoffRecovery.id || '';
  if (view.dataset.signature === signature) return;
  view.dataset.signature = signature; view.replaceChildren();
  if (!owner) return;
  view.append(element('strong','','Rever contexto demasiado grande'),element('p','',`O contexto para o ${providerName(owner.provider)} não cabe no limite. O histórico original fica guardado. Escreve um resumo das instruções, restrições, resultados e pendentes que queres transmitir em sua substituição. Nada será enviado ao guardar; o resumo seguirá com o próximo pedido.`));
  const label=element('label','','Resumo revisto por ti · até 12 000 caracteres');
  const input=element('textarea');input.maxLength=12000;input.rows=5;input.placeholder='Objetivo, restrições, trabalho feito, resultados por confirmar e próximos passos…';input.value=recoveryDrafts.get(owner.id)||'';input.addEventListener('input',()=>recoveryDrafts.set(owner.id,input.value));label.append(input);view.append(label);
  view.append(approvalButton('Usar este resumo na próxima passagem',async()=>{
    await api(`/api/conversations/${owner.id}/handoff-recovery`,{expectedRecoveryId:owner.handoffRecovery.id,summary:input.value});
    recoveryDrafts.delete(owner.id);
    state=await api('/api/state');render();toast('Resumo guardado. Revê e envia o próximo pedido; o original continua no histórico.');
  }));
}

function render() {
  if (!state) return;
  if (selected && !state.conversations.some(conversation => conversation.id === selected)) selected = null;
  const conversation = current();
  if(conversation)selectedProject=conversation.organization?.projectId||null;
  if(selectedProject&&!state.projectCatalog?.projects.some(p=>p.id===selectedProject)){selectedProject=null;projectOverview=false;}
  $('.workspace').classList.toggle('hidden',projectOverview);
  projectMemory.render();
  const connection = providerState().connection;
  const account = providerState().account;
  const name = providerName();
  document.body.dataset.provider = providerId();
  $('#connection-state').dataset.connected = String(connection === 'connected');
  $('#provider-label').textContent = `${name} original`;
  $('#prompt-label').textContent = `Pedido para o ${name}`;
  $('#approvals').setAttribute('aria-label',`Pedidos do ${name}`);
  $('#cwd-hint').textContent = `A pasta onde o ${name} vai trabalhar.`;
  $('#agent-label').textContent = name.toUpperCase();
  $('#connection-state').textContent = {connected:`● ${name} ligado`,connecting:`◌ A ligar ao ${name}…`,disconnected:`○ ${name} desligado`}[connection];
  $('#connection-dot').classList.toggle('connected',connection === 'connected');
  $('#account-label').textContent = account ? ({ cursor: 'Conta do Cursor · autenticação privada', antigravity: 'Sessão do agy · quota do plano', claude: `Claude · ${account.planType}` }[providerId()] || `ChatGPT · ${account.planType}`) : (connection === 'connecting' ? 'A verificar sessão…' : 'Sessão por verificar');
  $('#reconnect').classList.toggle('hidden',connection !== 'disconnected');
  const visibleTitle=conversation?conversationGroups(state).find(g=>g.id===conversation.group)?.title||conversation.title:'';
  $('#project-name').textContent = project() ? `${project().name}${conversation?' / '+visibleTitle:projectOverview?'':' / Nova conversa'}` : conversation ? visibleTitle : projectOverview?'Sem projeto':'Nova conversa';
  $('#project-name').title = conversation?.cwd || '';
  $('#session-badge').textContent = conversation ? statusLabels[conversation.status] || conversation.status : 'Uma tarefa. Todo o contexto.';
  const focus = focusConversation(conversation);
  const notice = (project()?.archived?'Projeto arquivado. Restaura-o nas definições para continuar.':current()?.organization?.archived?'Conversa arquivada. Restaura-a no menu da conversa para continuar.':project()?.available===false?project().folderError:null) || providerState().connectionError || focus?.error || conversation?.error;
  $('#notice').textContent = notice || '';
  $('#notice').classList.toggle('hidden',!notice);
  renderSettings(conversation);
  renderSidebar();
  renderMessages(conversation);
  renderProgress(focus);
  renderActivity(focus);
  renderTurnUsage(focus);
  renderApprovals(conversation);
  renderSend();
  renderUncertainty(conversation);
  renderHandoffRecovery(conversation);
  const active=state.conversations.find(c=>activeStatuses.includes(c.status)) || state.conversations.find(c=>c.id===state.handoff?.conversationId) || state.conversations.find(c=>state.approvals.some(a=>a.conversationId===c.id));
  const banner=$('#global-task');banner.classList.toggle('hidden',!active||(!projectOverview&&active.group===conversation?.group));
  if(active){banner.textContent=`${providerName(active.provider)} · ${active.title} · ${state.approvals.length?'Decisão pendente':'Tarefa em curso'} — Abrir`;banner.onclick=()=>choose(active.id);}
  renderProjectSuggestion();
  const collaboration=state.collaboration?.sessions.find(s=>s.id===state.collaboration.activeId);
  if(collaboration&&collaborationUI.view!=='collaboration'){banner.classList.remove('hidden');banner.textContent=`Colaboração · ${collaboration.title} · Em curso — Abrir`;banner.onclick=()=>{collaborationUI.choose(collaboration.id);collaborationUI.show('collaboration');};}
  collaborationUI.render();
}
function renderProjectSuggestion(){
  const view=$('#project-suggestion');view.replaceChildren();const folder=$('#cwd').value.replace(/\/$/,'');
  const suggestion=!current()&&!project()?state.projectCatalog?.projects.filter(p=>!p.archived&&(folder===p.root||folder.startsWith(p.root==='/'?'/':p.root+'/'))).sort((a,b)=>b.root.length-a.root.length)[0]:null;
  view.classList.toggle('hidden',!suggestion);if(!suggestion)return;
  const button=element('button','',`Usar projeto ${suggestion.name}`);button.type='button';button.addEventListener('click',()=>choose(null,suggestion.id));view.append(button,element('small','','O novo pedido usará a pasta raiz deste projeto. Podes manter esta conversa solta.'));
}

$('#provider').addEventListener('change',()=> {
  saveSettingsDraft();
  const conversation = current();
  if (conversation) {
    if ($('#provider').value === conversation.provider) switchTargets.delete(conversation.id);
    else switchTargets.set(conversation.id, $('#provider').value);
  } else {
    selectedProvider = $('#provider').value;
    localStorage.setItem('hydraq.provider',selectedProvider);
  }
  settingsOwner = null; modelsSignature = '';
  render();
});
try { const mode = localStorage.getItem('hydraq.handoffMode'); if (['model','quick'].includes(mode)) $('#handoff-mode').value = mode; } catch { /* Preference only. */ }
$('#handoff-mode').addEventListener('change',()=> {
  try { localStorage.setItem('hydraq.handoffMode',$('#handoff-mode').value); } catch { /* Preference only. */ }
  renderSettings(current());
});
$('#model').addEventListener('change',()=> {
  const model = providerState().models.find(entry => entry.id === $('#model').value);
  const previous = $('#effort').value;
  populateEfforts(model?.efforts.includes(previous) ? previous : model?.defaultEffort);
  populateCursorOptions($('#context').value, $('#fast').checked);
  saveSettingsDraft();
  renderCacheInfo(current());
});
$('#effort').addEventListener('change',()=> {
  saveSettingsDraft();
  renderCacheInfo(current());
});
$('#context').addEventListener('change',()=>saveSettingsDraft());
$('#fast').addEventListener('change',()=>saveSettingsDraft());
$('#sandbox').addEventListener('change',()=> { saveSettingsDraft(); renderCacheInfo(current()); });
$('#prompt').addEventListener('input',()=> {
  composerIntent = captureDraftIntent(composerIntent, $('#prompt').value, current());
  saveComposerDraft();renderSend();
});
$('#cwd').addEventListener('input',()=>{saveComposerDraft();renderProjectSuggestion();});
$('#use-as-request').addEventListener('click',()=> {
  composerIntent = $('#prompt').value.trim() ? { kind: 'send' } : null;
  renderSend();
  $('#prompt').focus();
});
$('#prompt').addEventListener('keydown',event=> {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('#send').disabled) $('#composer').requestSubmit();
  }
});
function setSidebar(open){$('#projects-sidebar').classList.toggle('is-open',open);$('#sidebar-scrim').classList.toggle('hidden',!open);$('#sidebar-toggle').setAttribute('aria-expanded',String(open));}
$('#sidebar-toggle').addEventListener('click',()=>setSidebar(!$('#projects-sidebar').classList.contains('is-open')));
$('#sidebar-scrim').addEventListener('click',()=>setSidebar(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape')setSidebar(false);});
$('#new-chat').addEventListener('click',()=>choose(null));
document.addEventListener('keydown',event=> {
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); choose(null); }
});
$('#composer').addEventListener('submit',async event=> {
  event.preventDefault();
  composerIntent = captureDraftIntent(composerIntent, $('#prompt').value, current());
  renderSend();
  if ($('#send').disabled) return;
  const text = $('#prompt').value;
  const draftImages=[...imageAttachments.list()];
  const imageDraftKey=composerKey();
  const importedContext=projectMemory.pending.get(imageDraftKey);
  const conversationAtSubmit = current();
  const steeringTarget = draftMode(composerIntent, conversationAtSubmit) === 'steer' ? composerIntent.turnId : null;
  const settings = { model: $('#model').value, effort: $('#effort').value, sandbox: $('#sandbox').value, ...(providerId()==='cursor' ? {context:$('#context').value || null,fast:$('#fast').checked} : {}) };
  const settingsDraftKey = settingsKey(conversationAtSubmit);
  const handoff = switching(conversationAtSubmit) ? { provider: providerId(), handoffMode: $('#handoff-mode').value, sandbox: $('#sandbox').value } : {};
  sending = true;
  renderSend();
  renderSettings(current());
  try {
    let conversation = current();
    if (steeringTarget) {
      if(importedContext)throw new Error('A importação só pode seguir num pedido novo, depois de terminar o turno.');
      const result = await api(`/api/conversations/${conversationAtSubmit.id}/steer`, { text, requestId: crypto.randomUUID(), expectedTurnId: steeringTarget });
      if (!result.accepted) throw new Error('A entrega da orientação não foi confirmada. Não foi reenviada.');
      if (selected === conversationAtSubmit.id && $('#prompt').value === text) { $('#prompt').value = ''; composerIntent = null; }
      return;
    }
    if (!conversation) {
      conversation = await api('/api/conversations',{provider:providerId(),cwd:$('#cwd').value,...settings,sandbox:$('#sandbox').value,...(selectedProject?{projectId:selectedProject,revision:state.projectCatalog.revision}:{})});
      const createdIndex=state.conversations.findIndex(entry=>entry.id===conversation.id);
      if(createdIndex<0)state.conversations.unshift(conversation);else state.conversations[createdIndex]=conversation;
      saveComposerDraft();
      composerDrafts.move(imageDraftKey,draftKey(conversation,selectedProject));
      imageAttachments.move(imageDraftKey,draftKey(conversation,selectedProject));
      projectMemory.move(imageDraftKey,draftKey(conversation,selectedProject));
      choose(conversation.id,selectedProject,false,true);
      composerDrafts.records.delete(imageDraftKey);
    }
    const attachments=await imageAttachments.upload(draftImages,conversation);
    const result = await api(`/api/conversations/${conversation.id}/send`,{text,requestId:crypto.randomUUID(),...settings,...handoff,...(attachments.length?{attachments}:{}),...(importedContext?{importId:importedContext.previewId}:{})});
    imageAttachments.consume(draftImages);
    projectMemory.consume(draftKey(conversation,selectedProject),importedContext);
    settingDrafts.delete(settingsDraftKey);
    composerDrafts.clear(draftKey(conversation,selectedProject),text);
    if (selected === conversation.id && $('#prompt').value === text) { $('#prompt').value = ''; composerIntent = null; }
    if (result.conversationId && result.conversationId !== conversation.id) {
      switchTargets.delete(conversation.id);
      if (!state.conversations.some(entry => entry.id === result.conversationId)) state = await api('/api/state');
      choose(result.conversationId,selectedProject,false,true);
    }
  } catch (error) { toast(error.message); }
  finally { sending = false; try { state = await api('/api/state'); } catch { /* SSE reconnect handles transport loss; do not replay writes. */ } render(); }
});
$('#stop').addEventListener('click',async()=> {
  $('#stop').disabled = true;
  try { await api(`/api/conversations/${focusConversation()?.id || selected}/interrupt`,{}); }
  catch (error) { toast(error.message); }
  finally { $('#stop').disabled = false; }
});
$('#reconnect').addEventListener('click',async()=> {
  $('#reconnect').disabled = true;
  try { state = await api('/api/connect',{provider:providerId()}); render(); }
  catch (error) { toast(error.message); }
  finally { $('#reconnect').disabled = false; }
});

function listen() {
  events?.close();
  events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener('state',event=> {
    recoveryDelay = 1000;
    state = JSON.parse(event.data);
    render();
  });
  events.onerror = () => {
    events.close();
    $('#connection-state').textContent = '○ Ligação local interrompida';
    $('#send').disabled = true;
    $('#notice').textContent = 'A ligação ao HYDRAQ foi interrompida. A página volta a ligar automaticamente; os pedidos não são reenviados.';
    $('#notice').classList.remove('hidden');
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(()=>boot(true),recoveryDelay);
    recoveryDelay = Math.min(recoveryDelay*2,8000);
  };
}

async function boot(recovering = false) {
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw new Error('Não foi possível abrir a sessão local.');
    const initial = await response.json();
    token = initial.token;
    state = initial.state;
    if(!recovering&&!current()&&selectedProject)selectedProvider=state.projectCatalog?.projects.find(p=>p.id===selectedProject)?.defaults?.provider||selectedProvider;
    render();
    listen();
  } catch (error) {
    if (!recovering) toast(error.message);
    $('#connection-state').textContent = '○ Servidor indisponível';
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(()=>boot(true),recoveryDelay);
    recoveryDelay = Math.min(recoveryDelay*2,8000);
  }
}
boot();
