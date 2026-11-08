import { NativeSessionsUI, OpenCodeSessionsUI, AntigravitySessionsUI, TerminalSwitch } from './native-sessions.js';
import { ClaudeSessionsUI } from './claude-sessions.js';
import { workConflict, workReason } from './work-locks.js';
import { captureDraftIntent, draftMode, followupOptions, followupDescriptions } from './composer.js';
import { elicitationForm } from './elicitation.js';
import { ImageAttachments } from './attachments.js';
import { ComposerDrafts, PersistentDraftMap, draftKey } from './drafts.js';
import { ProjectUI, conversationGroups, chooseFolder } from './projects.js';
import { ProjectMemoryUI } from './project-memory.js';
import { CollaborationUI } from './collaboration.js';
import { ModelPicker } from './model-picker.js';
import { quotaUsageView } from './turn-quotas.js';
import { OpinionUI, opinionResultAnchors, diagnosticsView } from './opinions.js';
import { Layout, Tooltips, AppearanceMenu, ClientColors, APPEARANCES, COLUMNS } from './layout.js';
// A server started before the dual routes does not serve dual.js: the composer then works without Dual.
const permissionModule = await import('./permissions.js').catch(()=>null);
const {PermissionControls,policyLabel,effectivePolicy}=permissionModule||{};
const gitPanelModule = await import('./git-panel.js').catch(() => null);
const claudexModule = await import('./claudex.js').catch(() => null);
const dualModule = await import('./dual.js').catch(() => null);
// Readable actions, durations and the request summary; a server started before it existed leaves the old card.
const actions = await import('./actions.js').catch(() => null);
const providerStatusModule = await import('./provider-status.js').catch(() => null);
const dictationModule = await import('./dictation.js').catch(() => null);
const companionModule = await import('./companion.js').catch(() => null);
const { companionRequest = () => null, companionTranscriptOwners = (_all, _current, group) => group } = companionModule || {};
const { isReadMode: dualRead, dualSendLabel, memberKeys: multiKeys, targetKeys: multiTargets } = dualModule || {};

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
  // The approved HYDRAQ symbol is shown in Mono; the other appearances keep their icon.
  const mark = document.createElementNS(svg.namespaceURI, 'use');
  for (const [key, value] of Object.entries({ href: '#mono-logo-symbol', width: '24', height: '24', display: 'none', class: 'mono-message-symbol' })) mark.setAttribute(key, value);
  svg.append(mark);
  return svg;
}

// Local vector marks: no network assets, and the connection light remains a separate node.
function renderClientGlyph(provider) {
  const host = $('#client-glyph');
  if (host.dataset.provider === provider) return;
  host.dataset.provider = provider;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ui-icon client-mark' })) svg.setAttribute(key, value);
  const path = (d, attributes = {}) => {
    const node = document.createElementNS(svg.namespaceURI, 'path');
    for (const [key, value] of Object.entries({ d, ...attributes })) node.setAttribute(key, value);
    svg.append(node);
  };
  if (provider === 'antigravity') {
    // Gemini's four-point sparkle, used for the Antigravity client.
    path('M12 1C10.8 7.7 7.7 10.8 1 12c6.7 1.2 9.8 4.3 11 11 1.2-6.7 4.3-9.8 11-11C16.3 10.8 13.2 7.7 12 1Z', { fill: 'currentColor', stroke: 'none' });
  } else if (provider === 'claude') {
    for (let angle = 0; angle < 360; angle += 30) path('M12 3v6', { transform: `rotate(${angle} 12 12)`, 'stroke-width': '2' });
  } else if (provider === 'cursor') {
    path('m12 2 9 5.2v9.6L12 22l-9-5.2V7.2Z');
    path('m3 7.2 9 5.2 9-5.2M12 12.4V22M12 2v10.4', { 'stroke-width': '1.3' });
    path('m12 6 5 2.9-5 2.9Z', { fill: 'currentColor', stroke: 'none' });
  } else if (provider === 'opencode') {
    path('M4 3h16v18H4Z', { 'stroke-width': '2' });
    path('M8 8h8v9H8Z', { fill: 'currentColor', stroke: 'none' });
  } else {
    // Six interlocking arms distinguish Codex from the other client marks.
    for (let angle = 0; angle < 360; angle += 60) path('M12 4.2a4.3 4.3 0 0 1 7.45 4.3l-6.1 3.52-2.7-1.56V6.5l3.35-1.94', { transform: `rotate(${angle} 12 12)`, 'stroke-width': '1.45' });
  }
  host.replaceChildren(svg);
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
// Assigned once the composer helpers exist; read through optional chaining before that.
let dualUI, claudexUI, dictationUI, companionUI;
let selected = localStorage.getItem('hydraq.conversation') || null;
let selectedProject = localStorage.getItem('hydraq.project') || null;
let projectOverview = !selected && localStorage.getItem('hydraq.projectView') === 'true';
const composerDrafts = new ComposerDrafts();
const draftProviders = new PersistentDraftMap('hydraq.draft-providers.v1');
const providerNames = { codex: 'Codex', antigravity: 'Antigravity', claude: 'Claude Code', cursor: 'Cursor', opencode: 'OpenCode' };
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
const progressPanel = $('#progress-panel');
// The Hydra task card; it moves into the transcript while Hydra runs in the conversation.
const hydraHost = $('#hydra-inline');
let transcriptPinned = true;
let composerIntent = null;
const deliveryPreferences = {};
const chosenDelivery = () => composerIntent?.deliveryMode || $('#followup-mode')?.value || followupOptions(current())[0];
const settingDrafts = new PersistentDraftMap('hydraq.draft-settings.v1');
const recoveryDrafts = new Map();
let settingsOwner;
let settingsBaseline;
const nativeUI = new NativeSessionsUI({api, state:()=>state, current, project, choose, toast, changed:renderTerminal, refresh:async()=>{accept(await api('/api/state'));render();}});
const claudeUI = new ClaudeSessionsUI({api, state:()=>state, current, project, choose, toast, changed:renderTerminal, refresh:async()=>{accept(await api('/api/state'));render();}});
const openCodeUI = new OpenCodeSessionsUI({api,state:()=>state,current,toast,changed:renderTerminal,refresh:async()=>{accept(await api('/api/state'));render();}});
const agyUI = new AntigravitySessionsUI({api,state:()=>state,current,toast,changed:renderTerminal,refresh:async()=>{accept(await api('/api/state'));render();}});
// Opens the settings at a section that needs the person: a failed launch's command or a confirmation.
function revealSettings(target){layout.toggle('inspector',true);$('#inspector-tabs [data-inspector-view=system]')?.click();$('#settings-details').open=true;(target||$('#settings-details')).scrollIntoView({block:'nearest'});}
const terminalSections = {codex:nativeUI,claude:claudeUI,opencode:openCodeUI,antigravity:agyUI};
const terminalSwitch = new TerminalSwitch({host:$('#terminal-switch'),state:()=>state,current:terminalConversation,dual:()=>dualUI,choose,reveal:revealSettings,sections:terminalSections,toast});
// The same control in the Modo panel, next to the client and model it continues, with room for the steps.
const inspectorTerminal = new TerminalSwitch({host:$('#inspector-terminal'),state:()=>state,current:terminalConversation,dual:()=>dualUI,choose,reveal:revealSettings,sections:terminalSections,toast,detail:true});
// Both controls follow a section's request from its start, wherever it was asked.
function renderTerminal(){terminalSwitch.render();inspectorTerminal.render();}
const activeStatuses = ['starting', 'running', 'waiting'];
const layout = new Layout();
new Tooltips();
const imageAttachments = new ImageAttachments({composer:$('#composer'),getKey:()=>composerKey(),getToken:()=>token,isBusy:()=>anyBusy() || sending,changed:()=>renderSend(),toast});
dictationUI = dictationModule ? new dictationModule.Dictation({composer:$('#composer'),input:$('#prompt'),getKey:composerKey,getToken:()=>token,changed:()=>{if(state)renderSend();},toast}) : null;
const statusLabels = { idle: 'Pronta', starting: 'A iniciar…', running: 'A trabalhar…', waiting: 'A aguardar a tua resposta', completed: 'Concluída', interrupted: 'Interrompida', failed: 'Falhou', uncertain: 'Estado por confirmar', inProgress: 'Em execução' };
const effortLabels = { default: 'Automático', none: 'Sem raciocínio', minimal: 'Mínimo', low: 'Leve', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo', ultra: 'Ultra' };

// Snapshots arrive by SSE and in request responses; an older one never replaces a newer one.
function accept(next) {
  if (next && state && next.stateInstance === state.stateInstance && next.stateRevision < state.stateRevision) return state;
  state = next;
  return state;
}

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
  if (!response.ok) throw Object.assign(new Error(result.error || 'O pedido não foi concluído.'),{status:response.status,code:result.code,beforeSend:result.beforeSend,confirm:result.confirm});
  return result;
}

function providerId() { const conversation = current(); const dual = dualUI?.focusProvider(conversation); if (dual) return dual; return conversation ? switchTargets.get(conversation.id) || conversation.provider : selectedProvider; }
function providerState(id = providerId()) { const info=state?.providers?.[id] || state || {}; if(id!=='opencode')return info; const cwd=openCodeCwd(),catalog=info.catalogs?.[resolvedOpenCodeScopes.get(cwd)||cwd]; return {...info,models:catalog?.models||[],catalog}; }
const resolvedOpenCodeScopes=new Map(),openCodeChecks=new Map();
function openCodeCwd(){return current()?.cwd||project()?.root||$('#cwd').value||state?.defaultCwd||'';}
async function checkOpenCodeModels(force=false){
  const cwd=openCodeCwd();if(!cwd)return;
  const old=openCodeChecks.get(cwd);if(old?.promise)return old.promise;
  if(!force&&!providerState('opencode').catalog?.stale&&old?.at&&Date.now()-old.at<10*60_000)return;
  const promise=api('/api/opencode/models',{cwd,force}).then(result=>{resolvedOpenCodeScopes.set(cwd,result.catalog.cwd);accept(result.state);render();return result.catalog;}).finally(()=>openCodeChecks.set(cwd,{at:Date.now()}));
  openCodeChecks.set(cwd,{at:Date.now(),promise});return promise;
}
const modelPicker=new ModelPicker({select:$('#model'),getCatalog:()=>providerState('opencode').catalog,refresh:checkOpenCodeModels,toast});
function providerName(id = providerId()) { return providerNames[id] || id; }
function conversationFolder(conversation) { return conversation?.workspaceOrigin || conversation?.cwd || ''; }
function composerKey() { return draftKey(current(),selectedProject); }
function project() { return state?.projectCatalog?.projects.find(p=>p.id===(current()?.organization?.projectId || (!current()?selectedProject:null))); }
function companionProject() {
  const direct = project();
  if (direct && !direct.archived) return direct;
  const folder = (conversationFolder(current()) || $('#cwd')?.value || '').replace(/\/$/, '');
  const projects = (state?.projectCatalog?.projects || []).filter(p => !p.archived);
  if (!folder) return null;
  return projects.filter(p => folder === p.root || folder.startsWith(p.root === '/' ? '/' : `${p.root}/`)).sort((a, b) => b.root.length - a.root.length)[0] || null;
}
function settingsKey(conversation = current()) { return `${draftKey(conversation,selectedProject)}:${providerId()}`; }
function members(conversation = current()) { return conversation ? state.conversations.filter(entry => entry.group === conversation.group) : []; }
function switching(conversation = current()) { return Boolean(conversation && !dualUI?.record(conversation) && providerId() !== conversation.provider); }
// A dual conversation never steers a running turn: the next message waits for the round to end.
function steerTarget(conversation = current()) { return dualUI?.record(conversation) || conversation?.claudexTask ? null : conversation; }
// Hydra: a ClaudeX, Geminex or Claudini task shown inside the conversation. A new conversation keeps
// the chosen pair until its first request; afterwards the conversation is the task's group.
const HYDRA_PAIRS = [['codex', 'claude'], ['codex', 'antigravity'], ['claude', 'antigravity'], ['codex', 'claude', 'antigravity']];
const hydraDrafts = new Map();
const pairName = claudexModule?.pairName || (() => 'Hydra');
function hydraTask(conversation = current()) { return conversation?.claudexTask ? state?.claudex?.records.find(record => record.id === conversation.claudexTask) || { id: conversation.claudexTask } : null; }
function hydraPair(conversation = current()) { const task = hydraTask(conversation); if (task) return task.roles || HYDRA_PAIRS[0]; return claudexUI && state?.claudex ? hydraDrafts.get(composerKey()) || null : null; }
function hydraOn() { return Boolean(claudexUI && !projectOverview && collaborationUI.view === 'conversations' && hydraPair()); }
function lastHydraPair() { try { const pair = JSON.parse(localStorage.getItem('hydraq.hydraPair')); return HYDRA_PAIRS.find(entry => entry.join() === pair?.join()) || HYDRA_PAIRS[0]; } catch { return HYDRA_PAIRS[0]; } }
function terminalConversation() { const conversation = current(); return hydraTask(conversation) ? null : conversation; }
function targetMember(conversation = current()) { return members(conversation).filter(entry => entry.provider === providerId()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null; }
function focusConversation(conversation = current()) { return members(conversation).find(entry => activeStatuses.includes(entry.status)) || conversation; }
function workBlock(){return state?.workLocks?.find(lock=>workConflict(lock,{cwd:current()?.cwd||project()?.root||$('#cwd').value,projectId:project()?.id,resources:['normal-preparation','normal:'+providerId()]}));}
function anyBusy() { return state?.workLocks?Boolean(workBlock()):Boolean(state?.collaboration?.busy || state?.handoff || state?.conversations.some(entry => activeStatuses.includes(entry.status))); }
const uncertaintyKey = conversation => conversation.turns?.findLast(turn => turn.status === 'uncertain')?.requestId || conversation.updatedAt;
const needsUncertaintyReview = conversation => conversation.status === 'uncertain' && conversation.uncertaintyReview?.key !== uncertaintyKey(conversation);
function mapSandbox(sandbox, target) {
  if (target === 'codex') return ['ask', 'read-only', 'plan'].includes(sandbox) ? 'read-only' : 'workspace-write';
  if (target === 'opencode') return ['ask','read-only','plan'].includes(sandbox)?'plan':'workspace-write';
  if (target === 'cursor') return sandbox === 'ask' ? 'ask' : ['read-only','plan'].includes(sandbox) ? 'plan' : 'workspace-write';
  if (['ask', 'read-only', 'plan'].includes(sandbox)) return 'plan';
  return sandbox === 'accept-edits' ? 'accept-edits' : 'workspace-write';
}
function saferSandbox(source, existing, target) {
  const mapped = mapSandbox(source, target);
  const rank = mode => mode === 'ask' ? -1 : ['read-only','plan'].includes(mode) ? 0 : mode === 'accept-edits' ? 2 : 1;
  return existing && rank(existing) < rank(mapped) ? existing : mapped;
}
// Planning is a native mode of these clients; it is stored as the request's sandbox value.
const planSupport = { codex:true, claude: true, cursor: true, antigravity: true, opencode: true };
let permissionControls = null;
const permissionOptions = {
  opencode: [['workspace-write','Perguntar antes','OpenCode original: autorizações na conversa; sem aprovação automática nem sandbox do sistema operativo comprovada.']],
  antigravity: [['workspace-write','Executar','O agy usa a política de permissões configurada no cliente original e as restrições da sandbox.'],['accept-edits','Aceitar edições','Pede ao agy o modo accept-edits. O efeito depende também da política de permissões configurada no cliente original.']],
  claude: [['workspace-write','Perguntar antes','O Claude Code pede autorização na conversa antes de editar ficheiros ou executar comandos.'],['accept-edits','Aceitar edições','O Claude Code aplica edições de ficheiros sem perguntar; comandos continuam a pedir autorização.']],
  cursor: [['workspace-write','Executar','O Grok trabalha com as permissões nativas do Cursor; autorizações aparecem na conversa.'],['ask','Só perguntas','Modo Perguntar do Cursor: responde e analisa, sem alterar ficheiros.']],
  codex: [['workspace-write','Leitura e escrita','O Codex pode ler e alterar ficheiros da pasta do projeto. Ações fora da sandbox pedem autorização na conversa.'],['read-only','Só leitura','Usa o sandbox de leitura do Codex. Vê as proteções no painel Modo.']],
};
let planMode = false;
function sandboxValue() {
  const policy=permissionControls?.value();
  if(policy?.profile==='read-only')return providerId()==='codex'?'read-only':'plan';
  if(policy?.profile==='project'&&(dualUI?.both(current())||dualUI?.pendingFor()))return providerId()==='codex'?'read-only':'plan';
  if(policy?.profile==='project')return planMode&&providerId()!=='codex'?'plan':'workspace-write';
  return planMode && planSupport[providerId()] && providerId()!=='codex' ? 'plan' : $('#sandbox').value;
}
function setSandbox(value) {
  const provider = providerId(), options = permissionOptions[provider].map(([id]) => id);
  planMode = value === 'plan' && planSupport[provider];
  if (options.includes(value)) $('#sandbox').value = value;
  else if (value === 'plan' && !planSupport[provider]) $('#sandbox').value = 'read-only';
  else if (!options.includes($('#sandbox').value)) $('#sandbox').value = options[0];
  renderPermissionTips();
}
function renderPermissionTips() {
  const provider = providerId(), supported = planSupport[provider]&&(provider!=='codex'||Boolean(state?.permissions));
  $('#plan-toggle').setAttribute('aria-pressed', String(planMode && supported));
  $('#plan-toggle').dataset.tip = supported
    ? `Planear: o ${providerName(provider)} analisa e propõe um plano antes de alterar ficheiros (modo nativo). Define o objetivo do pedido; as permissões definem o acesso.`
    : 'O Codex não tem um modo Planear nesta integração. Para impedir alterações, escolhe “Só leitura” nas permissões.';
  const option = permissionOptions[provider].find(([id]) => id === $('#sandbox').value);
  $('#sandbox').dataset.tip = `Permissões: ${option?.[2] || 'acesso do cliente ao projeto.'}${planMode && supported ? ' Planear pede um plano ao cliente. Vê as proteções no painel Modo.' : ''}`;
}
function saveSettingsDraft() {
  settingDrafts.set(settingsKey(), { model: $('#model').value, effort: $('#effort').value, sandbox: sandboxValue(), context: $('#context').value || null, fast: $('#fast').checked });
}
// The member shown in the composer reads its controls; the other keeps its draft or its last round's choice.
function dualMemberSettings(record, key, fallbackProvider) {
  const member = (key && record?.members?.[key]) || {};
  const provider = member.provider || fallbackProvider || providerId();
  if (provider === providerId()) return { model: $('#model').value, effort: $('#effort').value, ...(provider === 'cursor' ? { context: $('#context').value || null, fast: $('#fast').checked } : {}) };
  const draft = settingDrafts.get(`${draftKey(current(), selectedProject)}:${provider}`) || {};
  const defModel = providerState(provider).models?.find(m => m.isDefault) || providerState(provider).models?.[0];
  const model = draft.model || member.model || defModel?.id || '';
  const modelEntry = providerState(provider).models?.find(m => m.id === model) || defModel;
  const effort = draft.effort || member.effort || modelEntry?.defaultEffort || modelEntry?.efforts?.[0] || '';
  return { model, effort, ...(provider === 'cursor' ? { context: draft.context ?? member.context ?? modelEntry?.defaultContext ?? null, fast: draft.fast ?? member.fast ?? false } : {}) };
}
// Quotas follow the next request's selected models, including both participants.
function quotaSelections() {
  if (claudexUI && (hydraOn() || collaborationUI.view === 'claudex')) {
    const roles = hydraOn() ? hydraPair() : claudexUI.roles();
    return (roles || []).map(provider => ({provider,model:claudexUI.controls[provider+'Model']?.value,effort:claudexUI.controls[provider+'Effort']?.value,mode:'Hydra'}));
  }
  const record = dualUI?.record(current()), pending = dualUI?.pendingFor();
  if (record) return multiKeys(record).filter(key=>key!==record.vacant).map(key => ({provider:record.members[key].provider,...dualMemberSettings(record,key),mode:'Multi'}));
  const principal = {provider:providerId(),model:$('#model').value,effort:$('#effort').value};
  return pending ? [{...principal,mode:'Multi'},...(pending.participants||[pending]).map(p=>({...p,mode:'Multi'}))] : [principal];
}
function shortPath(value) {
  const path = String(value || '').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
  const parts = path.split('/');
  return path.length > 44 && parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join('/')}` : path;
}

function current() { return state?.conversations.find(conversation => conversation.id === selected); }
function saveComposerDraft() {
  composerDrafts.save(composerKey(),$('#prompt').value,composerIntent,$('#cwd').value);
  if(!current())draftProviders.set(composerKey(),selectedProvider);
  if(settingsOwner===settingsKey())saveSettingsDraft();
}
function choose(id, projectId=selectedProject, overview=false, internal=false) {
  if(sending&&!internal){toast('Aguarda a confirmação do envio antes de mudar de conversa.');return;}
  dictationUI?.cancel();
  saveComposerDraft();
  collaborationUI.show('conversations',false);
  layout.closeDrawers();
  selected=id;selectedProject=id?current()?.organization?.projectId||null:projectId;projectOverview=overview;
  if(current()?.provider)selectedProvider=current().provider;
  else selectedProvider=draftProviders.get(composerKey()) || project()?.defaults?.provider || selectedProvider;
  const draft=composerDrafts.get(composerKey());$('#prompt').value=draft.text;composerIntent=draft.intent;
  $('#cwd').value=conversationFolder(current())||project()?.root||draft.cwd||'';
  if(id)localStorage.setItem('hydraq.conversation',id);else localStorage.removeItem('hydraq.conversation');
  if(selectedProject)localStorage.setItem('hydraq.project',selectedProject);else localStorage.removeItem('hydraq.project');
  localStorage.setItem('hydraq.projectView',String(overview));
  messageSignature=activitySignature=approvalsSignature=progressSignature='';settingsOwner=null;render();
  if(!overview)$('#prompt').focus();
}
const gitPanel = gitPanelModule ? new gitPanelModule.GitPanelUI({ api }) : null;
const checkpointDrafts = new PersistentDraftMap('hydraq.git-checkpoints.v1');
$('#git-panel-trigger').addEventListener('click', () => gitPanel?.open(project()));
$('#git-checkpoint-trigger').addEventListener('click', () => {
  const mode = checkpointMode(), key = composerKey(), selected = project();
  if (!mode) return;
  gitPanel.open(selected, { selectedCheckpoint: mode === 'hydra' && draftCheckpoint(selected, key), onCheckpoint: point => {
    if (mode === 'hydra') {
      if (point) checkpointDrafts.set(key, { projectId: selected.id, ...point });
      else checkpointDrafts.delete(key);
    }
    toast(point ? 'Ponto de segurança guardado · ' + point.commit.slice(0, 12) : 'Associação retirada. O commit continua no histórico Git.');
    renderSend();
  } });
});
const projectUI=new ProjectUI({getState:()=>state,api,refresh:async()=>{accept(await api('/api/state'));render();},choose:id=>choose(id),openProject:id=>choose(null,id,true),newChat:id=>choose(null,id,false),toast,memory:id=>projectMemory.open(id),git:gitPanel ? p=>gitPanel.open(p) : null});
const projectMemory=new ProjectMemoryUI({api,getState:()=>state,getCurrent:current,getProject:project,getKey:composerKey,getProvider:providerId,toast,renderImages:(target,images)=>imageAttachments.renderMessage(target,images),changed:()=>render()});
const providerStatus = providerStatusModule && $('#provider-status') ? new providerStatusModule.ProviderStatus({root:$('#provider-status'),api,getState:()=>state,getProvider:providerId,getSelections:quotaSelections,accept,render,toast}) : null;
if ($('#provider-status')) $('#provider-status').hidden = !providerStatus;
const collaborationUI=new CollaborationUI({api,getState:()=>state,toast,changed:()=>render(),markdown});
claudexUI=claudexModule?new claudexModule.ClaudeXUI({api,getState:()=>state,area:collaborationUI,toast,markdown,openConversation:id=>choose(id,selectedProject,false,true),
  openCheckpoint: gitPanel ? task => {
    const target = state?.projectCatalog?.projects.find(p => p.id === task.projectId && !p.archived && p.available !== false);
    if (target) gitPanel.open(target, { taskId: task.id });
    else toast('O projeto deste ponto de segurança está indisponível.');
  } : null,
  openTask:id=>{const task=state?.claudex?.records.find(record=>record.id===id),member=task&&Object.values(task.members||{}).find(entry=>state.conversations.some(c=>c.id===entry.conversationId));if(member)choose(member.conversationId);else claudexUI.choose(id);},
  elapsed,changed:()=>{if(!state)return;renderMessages(current());if(transcriptPinned&&hydraHost.parentElement===$('#messages'))$('#messages').scrollTop=$('#messages').scrollHeight;if(hydraOn()){renderSend();syncModePanel();}providerStatus?.render();}}):null;
const opinionUI=new OpinionUI({api,getKey:composerKey,getState:()=>state,getTarget:current,getSettings:()=>{if(switching(current()))throw Error('Conclui ou cancela a troca de cliente antes de incorporar pareceres.');return {permissionPolicy:permissionControls?.value(),model:$('#model').value,effort:$('#effort').value,sandbox:sandboxValue(),...(providerId()==='cursor'?{context:$('#context').value||null,fast:$('#fast').checked}:{})};},refresh:async()=>{accept(await api('/api/state'));render();},toast,markdown});
companionUI = companionModule ? new companionModule.CompanionUI({ api, getState: () => state, getProject: companionProject, markdown, getSourceGroup: () => current()?.organization?.projectId === companionProject()?.id ? current()?.group || current()?.id || null : null, getSelectedProvider: providerId, getToken: () => token, chooseConversation: id => choose(id), choose: id => choose(id), toast }) : null;

dualUI=dualModule?new dualModule.DualUI({api,getState:()=>state,getCurrent:current,markdown,elapsed,
  describeWork:(owner,turn)=>{if(!actions)return null;const work=actions.currentWork(owner,turn);return {now:!work?[]:work.actions?.length?work.actions.map(item=>({text:actions.actionPhrase(item,{live:true,cwd:owner.cwd}),since:item.at})):[{text:work.title,since:null}],summary:activeStatuses.includes(turn.status)?'':actions.summaryLine(actions.requestSummary(owner,turn)),thought:actions.thoughtLabel?.(owner.provider)?actions.latestThought(owner,turn,Infinity):null,thoughtLabel:actions.thoughtLabel?.(owner.provider)||'',thoughtOpen:actions.thoughtOpen?(live,choice,previous)=>actions.thoughtOpen(owner.provider,live,choice,previous):null};},getSyntheses:()=>opinionUI.viewState()?.batches?.filter(batch=>batch.kind==='synthesis')||[],getKey:composerKey,getProvider:()=>selectedProvider,setProvider:id=>{if(current()){if(id===current().provider)switchTargets.delete(current().id);else switchTargets.set(current().id,id);}else{selectedProvider=id;try{localStorage.setItem('hydraq.provider',selectedProvider);}catch{}}},getModels:id=>providerState(id).models||[],memberSettings:dualMemberSettings,toast,refresh:async()=>{accept(await api('/api/state'));render();},beforeChange:()=>saveSettingsDraft(),changed:()=>{settingsOwner=null;modelsSignature='';render();},open:id=>choose(id),
  loadModels:(id,force=false)=>id==='opencode'?checkOpenCodeModels(force):null,
  applySettings:(provider,settings)=>{const key=`${draftKey(current(),selectedProject)}:${provider}`;settingDrafts.set(key,{...(settingDrafts.get(key)||{}),...settings});}}):null;
$('#dual-toggle').classList.toggle('hidden',!dualUI);

function populateEfforts(value) {
  const model = providerState().models.find(entry => entry.id === $('#model').value);
  $('#effort').replaceChildren(...(model?.efforts || []).map(effort => {
    const option = element('option', '', effortLabels[effort] || effort);
    option.value = effort;
    return option;
  }));
  $('#effort').value = model?.efforts?.includes(value) ? value : model?.defaultEffort || model?.efforts?.[0] || '';
  $('#model-description').textContent = model?.description || '';
  $('#model').dataset.tip = `Modelo do próximo pedido${model?.description ? `: ${model.description}` : '.'}`;
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
  if(providerId()==='opencode')return {status:'unknown',label:'Sessão nativa OpenCode',detail:'A sessão e o histórico são mantidos. Só modelos gratuitos do fornecedor OpenCode; cache lida comunicada nativamente. Não usa a quota ChatGPT ou Claude.'};
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
  source.href = { opencode: 'https://opencode.ai/v2/docs/cli/acp/', cursor: 'https://cursor.com/docs/cli/acp', antigravity: 'https://antigravity.google/docs/cli/headless/', claude: 'https://code.claude.com/docs/en/headless' }[providerId()] || 'https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation';
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
  $('#model-capabilities').replaceChildren(table, element('p', '', { opencode: 'Variantes anunciadas pelo catálogo atual. Sessão preservada; cache lida comunicada nativamente.', cursor: 'A sessão é preservada; o ACP não confirma cache nem consumo por modelo.', antigravity: 'O protocolo do agy não confirma preservação de cache por modelo.', claude: 'O Claude Code não anuncia preservação por modelo; a cache lida aparece nos contadores de cada pedido.' }[providerId()] || '* Mesmo modelo, com a opção experimental ativa. Não garante acerto de cache.'));
}

function renderSettings(conversation) {
  const owner = settingsKey(conversation);
  const provider = providerId();
  const routineOpenCode=state?.providers?.opencode?.permissionProfile==='routine';
  permissionOptions.opencode=[routineOpenCode?['workspace-write','Trabalho habitual autorizado','Leitura, edição, comandos e pesquisa autorizados. Acesso externo, ficheiros .env e ferramentas adicionais podem pedir confirmação.']:['workspace-write','Perguntar antes','OpenCode original: autorizações na conversa; sem aprovação automática nem sandbox do sistema operativo comprovada.']];
  const permissionProfile=provider==='opencode'&&routineOpenCode?'routine':'default';
  const basis = conversation ? targetMember(conversation) : null;
  const group = members(conversation);
  const pendingSettings = !switching(conversation) ? conversation?.handoffState?.settings : null;
  const defaults=!conversation?project()?.defaults?.clients?.[provider]||{}:{};
  const baseline = JSON.stringify([!conversation?project()?.defaults:null,basis?.id,basis?.model,basis?.effort,basis?.sandbox,basis?.context,basis?.fast,pendingSettings]);
  $('#provider').value = provider;
  // In a dual, talking to one model, the client field replaces that participant (asked first in a dialog).
  $('#provider').disabled = sending || Boolean(conversation && (anyBusy() || group.some(needsUncertaintyReview))) || Boolean(dualUI?.pendingFor() || (dualUI?.record(conversation) && dualUI.both(conversation)));
  $('#provider-hint').textContent = { opencode: 'OpenCode original · apenas gratuitos do fornecedor OpenCode', cursor: 'Cursor original · Grok da tua conta', antigravity: 'agy original · Gemini e Claude da tua conta', claude: 'Claude Code original · sessão claude.ai existente', codex: 'Codex original · sessão ChatGPT existente' }[provider] + (conversation ? ' · podes mudar de cliente entre pedidos' : '');
  $('#provider').dataset.tip = `Cliente: ${$('#provider-hint').textContent}.${conversation ? ' Escolher outro cliente nesta conversa faz uma passagem de contexto no próximo pedido.' : ''}`;
  $('#permissions-hint').textContent = { opencode: 'Autorizações e perguntas na conversa. Planear usa o agente nativo; sem sandbox do sistema operativo comprovada. Sem aprovação automática. Só o fornecedor OpenCode gratuito, sem subagentes nesta versão.', cursor: 'Autorizações, perguntas e planos aparecem na conversa. Planear/Perguntar são modos nativos; isolamento do sistema operativo não comprovado. Sem orientação do turno ativo.', antigravity: 'Políticas nativas do agy. Durante a execução: redirecionar com interrupção confirmada e retoma, ou enviar depois. Não há injeção no mesmo turno nativo.', claude: 'Autorizações na conversa. Durante a execução: orientar na próxima oportunidade, redirecionar agora ou enviar depois. Orientar não aprova ações pendentes.' }[provider] || 'As autorizações adicionais aparecem na conversa.';
  if(provider==='opencode'&&routineOpenCode)$('#permissions-hint').textContent='Trabalho habitual autorizado: ler, editar, executar comandos e testes, pesquisar e consultar a memória. Acesso externo e ficheiros .env podem pedir confirmação. Planear mantém as restrições de edição. Só modelos gratuitos OpenCode.';
  if ($('#sandbox').dataset.provider !== provider || $('#sandbox').dataset.permissionProfile !== permissionProfile) {
    $('#sandbox').dataset.provider = provider;
    $('#sandbox').dataset.permissionProfile = permissionProfile;
    $('#sandbox').replaceChildren(...permissionOptions[provider].map(([value,label])=> { const option=element('option','',label);option.value=value;return option; }));
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
    $('#cwd').value = conversationFolder(conversation);
  } else if(project()) {
    $('#cwd').value = project().root;
  }
  if (settingsOwner !== owner || catalogChanged || (!draftSettings(conversation) && settingsBaseline !== baseline)) {
    const draft = draftSettings(conversation);
    const wanted = draft?.model || pendingSettings?.model || basis?.model || defaults.model || $('#model').value;
    if(wanted && !providerState().models.some(m=>m.id===wanted)){const missing=element('option','',`${wanted} · indisponível`);missing.value=wanted;$('#model').append(missing);$('#model').value=wanted;}
    if (providerState().models.some(model => model.id === wanted)) $('#model').value = wanted;
    populateEfforts(draft?.effort || pendingSettings?.effort || basis?.effort || defaults.effort);
    populateCursorOptions(draft?.context ?? pendingSettings?.context ?? basis?.context ?? defaults.context, draft?.fast ?? pendingSettings?.fast ?? basis?.fast ?? defaults.fast ?? false);
    if (conversation) setSandbox(draft?.sandbox || pendingSettings?.sandbox || (switching(conversation) ? saferSandbox(conversation.sandbox, basis?.sandbox, provider) : basis?.sandbox || conversation.sandbox));
    else setSandbox(draft?.sandbox || 'workspace-write');
    settingsOwner = owner;
    settingsBaseline = baseline;
  }
  $('#cwd').disabled = Boolean(conversation) || Boolean(project()) || sending;
  const locked = sending || providerState().connection !== 'connected' || anyBusy() || group.some(needsUncertaintyReview) || basis?.status === 'uncertain';
  for (const selector of ['#model', '#effort', '#sandbox', '#context', '#fast']) $(selector).disabled = locked;
  $('#plan-toggle').disabled = locked || !planSupport[provider] || (provider==='codex'&&!state?.permissions);
  // Questions to both models stay read-only; the composer shows the principal's read mode.
  if (dualUI?.readOnly(conversation) && !dualRead(sandboxValue())) setSandbox('plan');
  dualUI?.renderComposer(conversation, { locked });
  modelPicker.sync(provider==='opencode');
  if(provider==='opencode' && state?.providers?.opencode?.connection==='connected')queueMicrotask(()=>checkOpenCodeModels(false).catch(()=>{}));
  renderPermissionTips();
  // The handoff mode lives with the conversation; it only acts when the next request changes client.
  $('#handoff-box').classList.toggle('hidden', !conversation || Boolean(conversation.claudexTask));
  $('#handoff-box').classList.toggle('is-active', switching(conversation));
  $('#handoff-mode').disabled = locked;
  if (conversation) {
    const source = providerName(conversation.provider), target = switching(conversation) ? providerName() : 'outro cliente';
    $('#handoff-hint').textContent = ($('#handoff-mode').value === 'quick'
      ? `Rápida, sem pedido extra: o ${target} recebe os teus pedidos, as respostas, os planos, os ficheiros e comandos observados e o estado git.`
      : `Completa: o ${source} faz primeiro um pedido extra para resumir decisões e pendentes. O HYDRAQ verifica os ficheiros antes e depois; se detetar mudanças, bloqueia a passagem. O ${target} recebe o resumo e os factos observados.`)
      + (!switching(conversation) ? ' Só se aplica quando escolheres outro cliente na caixa de mensagens.' : basis ? ` Retoma a sessão original do ${target} e envia só o que aconteceu desde então.` : ` Cria uma sessão do ${target} ligada a esta conversa.`);
    $('#handoff-mode').dataset.tip = `Passagem de contexto entre clientes. ${$('#handoff-hint').textContent}`;
  }
  renderCacheInfo(conversation);
  renderSwitchNote(conversation);
}

function renderSwitchNote(conversation) {
  const note = $('#switch-note');
  const model = providerState().models?.find(entry => entry.id === $('#model').value);
  let text = '';
  if (switching(conversation)) {
    text = `Vais continuar no ${providerName()}. ${$('#handoff-mode').value === 'quick' ? 'Passagem rápida: sem pedido adicional' : `Passagem completa: o ${providerName(conversation.provider)} faz primeiro um pedido extra de resumo`}.`;
  } else if (conversation && model && targetMember(conversation)?.model && model.id !== targetMember(conversation).model) {
    text = 'Vais mudar de modelo nesta sessão: a cache do modelo anterior pode não ser reutilizada.';
  }
  note.classList.toggle('hidden', !text);
  if (note.dataset.text === text) return;
  note.dataset.text = text;
  note.replaceChildren();
  if (!text) return;
  note.append(element('span', '', text));
  if (switching(conversation)) {
    const cancel = element('button', 'text-button', `Manter ${providerName(conversation.provider)}`);
    cancel.type = 'button';
    cancel.addEventListener('click', () => { $('#provider').value = conversation.provider; $('#provider').dispatchEvent(new Event('change')); });
    note.append(cancel);
  }
}

function renderSidebar() {
  projectUI.render({projectId:selectedProject,group:current()?.group,overview:projectOverview});
}

// Inline marks replies use; links open only http(s) and mailto addresses.
const inlinePattern = /\\([\\`*_{}\[\]()#+\-.!~|>])|(`+)([\s\S]*?[^`])\2(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|(?<![\w*\\])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?![\w*])|(?<![\w_\\])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}»])/g;
async function openPlanDocument(owner,documentId){
  try{
    const document=await api(`/api/conversations/${encodeURIComponent(owner.id)}/plan-documents/${encodeURIComponent(documentId)}`);
    const dialog=element('dialog','opinion-dialog plan-file-dialog'),heading=element('div','opinion-dialog-heading'),title=element('h2','',document.name||'Plano do Cursor'),close=element('button','secondary-button','Fechar');close.type='button';close.addEventListener('click',()=>dialog.close());heading.append(title,close);
    const download=element('button','secondary-button','Descarregar Markdown');download.type='button';download.addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([document.text],{type:'text/markdown;charset=utf-8'})),a=element('a');a.href=url;a.download='cursor-plan-'+document.id+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
    const body=markdown(document.text);dialog.append(heading,element('p','plan-file-path',document.path),download,body);dialog.addEventListener('close',()=>dialog.remove(),{once:true});window.document.body.append(dialog);dialog.showModal();
  }catch(error){toast(error.message);}
}
function link(parent, href, label) {
  const anchor = element('a');
  inlineText(anchor, label, false);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  parent.append(anchor);
}
// Inside a link's label, addresses stay text: a link never holds another.
function inlineText(parent, text, links = true) {
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const [part, escaped, ticks, code, strong, strongAlt, struck, em, emAlt, label, href, angled, bare] = match;
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    cursor = match.index + part.length;
    if (escaped) parent.append(document.createTextNode(escaped));
    else if (ticks) parent.append(element('code', '', /^ [\s\S]* $/.test(code) && code.trim() ? code.slice(1, -1) : code));
    else if (!links && (label || angled || bare)) parent.append(document.createTextNode(part));
    else if (label) link(parent, href, label);
    else if (angled || bare) link(parent, angled || bare, angled || bare);
    else {
      const node = element(strong || strongAlt ? 'strong' : struck ? 'del' : 'em');
      inlineText(node, strong || strongAlt || struck || em || emAlt, links);
      parent.append(node);
    }
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

const fencePattern = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const headingPattern = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const rulePattern = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const quotePattern = /^\s{0,3}>\s?(.*)$/;
const itemPattern = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const tableRule = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const longCode = 24; // lines a code block shows before it folds
// Unfolded blocks stay open while a reply streams and re-renders. A block is known by its reply and its first
// lines, already complete when it folds, since the lines that keep arriving come after them.
const expandedCode = new Set();
let codeScope = ''; // the reply markdown() is rendering
const indentOf = line => line.length - line.trimStart().length;
const cells = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && tableRule.test(lines[i + 1]) && cells(lines[i]).length === cells(lines[i + 1]).length;
const startsBlock = (lines, i) => fencePattern.test(lines[i]) || headingPattern.test(lines[i]) || rulePattern.test(lines[i]) || quotePattern.test(lines[i]) || itemPattern.test(lines[i]) || isTable(lines, i);

function codeView(code, info) {
  const language = info || 'Texto';
  const wrapper = element('div', 'code-block');
  const heading = element('div', 'code-heading');
  const actions = element('span', 'code-actions');
  const copy = element('button', 'copy-code', 'Copiar');
  copy.type = 'button';
  copy.setAttribute('aria-label', `Copiar código · ${language}`);
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = 'Copiado'; }
    catch { toast('Não foi possível copiar. Seleciona o código para o copiar.'); }
  });
  const count = code.split('\n').length;
  if (count > longCode) {
    const key = [codeScope, language, ...code.split('\n', longCode)].join('\n');
    const toggle = element('button', 'copy-code code-toggle');
    toggle.type = 'button';
    const show = open => { wrapper.classList.toggle('code-folded', !open); toggle.textContent = open ? 'Recolher' : `Mostrar as ${count} linhas`; toggle.setAttribute('aria-expanded', String(open)); };
    show(expandedCode.has(key));
    toggle.addEventListener('click', () => { const open = wrapper.classList.contains('code-folded'); if (open) expandedCode.add(key); else expandedCode.delete(key); show(open); });
    actions.append(toggle);
  }
  actions.append(copy);
  heading.append(element('span', '', language), actions);
  const pre = element('pre');
  const content = element('code', '', code);
  if (/^(diff|patch)$/i.test(language)) diffContent(content, code);
  pre.append(content);
  wrapper.append(heading, pre);
  return wrapper;
}

// A fence may be indented inside a list item; an unclosed one runs to the end while a reply streams.
function codeBlock(parent, lines, start, [, indent, fence, info]) {
  const body = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { i++; break; }
    body.push(lines[i].slice(Math.min(indent.length, indentOf(lines[i]))));
  }
  parent.append(codeView(body.join('\n'), info));
  return i;
}

function table(parent, lines, start) {
  const head = cells(lines[start]);
  const align = cells(lines[start + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : '');
  const row = (values, tag) => {
    const tr = element('tr');
    head.forEach((_, index) => { const cell = element(tag); if (align[index]) cell.dataset.align = align[index]; inlineText(cell, values[index] || ''); tr.append(cell); });
    return tr;
  };
  const node = element('table'), thead = element('thead'), tbody = element('tbody');
  thead.append(row(head, 'th'));
  let i = start + 2;
  for (; i < lines.length && lines[i].trim() && lines[i].includes('|') && !fencePattern.test(lines[i]); i++) tbody.append(row(cells(lines[i]), 'td'));
  node.append(thead);
  if (tbody.childElementCount) node.append(tbody);
  const wrap = element('div', 'table-wrap');
  wrap.append(node);
  parent.append(wrap);
  return i;
}

// Items of one level; deeper lines, continuations and blocks after a blank line belong to the item above.
function list(parent, lines, start) {
  const first = itemPattern.exec(lines[start]), indent = first[1].length, ordered = /\d/.test(first[2]);
  const node = element(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) node.start = parseInt(first[2], 10);
  const sibling = line => { const match = itemPattern.exec(line); return match && Math.abs(match[1].length - indent) <= 1 && /\d/.test(match[2]) === ordered ? match : null; };
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (next < lines.length && sibling(lines[next])) { i = next; continue; }
      break;
    }
    const match = sibling(lines[i]);
    if (!match) break;
    const column = match[0].length - match[3].length, body = [];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next < lines.length && indentOf(lines[next]) > indent && !(itemPattern.test(lines[next]) && Math.abs(indentOf(lines[next]) - indent) <= 1)) { body.push(...lines.slice(i, next)); i = next; continue; }
        break;
      }
      if (indentOf(line) > indent + 1) { body.push(line); i++; continue; }
      if (body.length && !body.at(-1).trim()) break;
      if (startsBlock(lines, i)) break;
      body.push(line); i++;
    }
    const item = element('li');
    let text = match[3];
    const task = /^\[([ xX])\]\s+/.exec(text);
    if (task) { item.classList.add('task'); item.append(element('span', 'task-box', task[1] === ' ' ? '☐' : '☑')); text = text.slice(task[0].length); }
    const nested = body.map(line => line.slice(Math.min(column, indentOf(line))));
    const lead = [text];
    let k = 0;
    while (k < nested.length && nested[k].trim() && !startsBlock(nested, k)) lead.push(nested[k++].trim());
    inlineText(item, lead.join('\n'));
    if (k < nested.length) renderBlocks(item, nested.slice(k));
    node.append(item);
  }
  parent.append(node);
  return i;
}

function renderBlocks(parent, lines) {
  let i = 0, match;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if ((match = fencePattern.exec(line))) { i = codeBlock(parent, lines, i, match); continue; }
    if ((match = headingPattern.exec(line))) {
      const heading = element(match[1].length <= 2 ? 'h3' : match[1].length === 3 ? 'h4' : 'h5');
      inlineText(heading, match[2]);
      parent.append(heading);
      i++; continue;
    }
    if (rulePattern.test(line)) { parent.append(element('hr')); i++; continue; }
    if (quotePattern.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (match = quotePattern.exec(lines[i]))) { body.push(match[1]); i++; }
      const quote = element('blockquote');
      renderBlocks(quote, body);
      parent.append(quote);
      continue;
    }
    if (isTable(lines, i)) { i = table(parent, lines, i); continue; }
    if (itemPattern.test(line)) { i = list(parent, lines, i); continue; }
    const paragraph = [line.trim()];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) paragraph.push(lines[i].trim());
    const node = element('p');
    inlineText(node, paragraph.join('\n'));
    parent.append(node);
  }
}

function markdown(text, scope = '') {
  const container = element('div','message-content');
  codeScope = scope;
  try { renderBlocks(container, String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/^\t+/, tabs => '    '.repeat(tabs.length)))); }
  finally { codeScope = ''; }
  return container;
}

const welcomeTemplate = $('#welcome').cloneNode(true);
function syncWelcomeFleet() {
  const active = providerId();
  const locked = Boolean($('#provider')?.disabled);
  for (const card of document.querySelectorAll('[data-select-provider]')) {
    const id = card.dataset.selectProvider;
    const pState = state?.providers?.[id];
    const connected = pState?.connection === 'connected';
    card.dataset.active = String(id === active);
    card.dataset.connected = String(Boolean(connected));
    card.disabled = locked;
    const dot = card.querySelector('[data-fleet-dot]');
    if (dot) dot.dataset.connected = String(Boolean(connected));
    const meta = card.querySelector('[data-fleet-meta]');
    if (meta && pState) {
      const defModel = pState.models?.find(m => m.isDefault) || pState.models?.[0];
      const statusText = connected ? 'Ligado' : pState.connection === 'connecting' ? 'A ligar…' : 'Desligado';
      meta.textContent = defModel ? `${statusText} · ${defModel.name || defModel.id}` : statusText;
    }
  }
}
function renderAgentDock() {
  const active = providerId();
  const locked = Boolean($('#provider')?.disabled);
  // In a dual the bar highlights active participants and keeps the remaining clients visible to toggle on or off.
  const dual = Boolean(dualUI?.renderDock(current()));
  for (const pill of document.querySelectorAll('#agent-dock [data-agent]')) {
    const id = pill.dataset.agent;
    const pState = state?.providers?.[id];
    const connected = pState?.connection === 'connected';
    if (!dual) pill.setAttribute('aria-pressed', String(id === active));
    pill.dataset.connected = String(Boolean(connected));
    pill.disabled = dual ? sending || dualUI.memberBusy : locked;
  }
  // The brand's client lights: lit when that client is connected, in its own colour.
  const lit = [];
  for (const light of document.querySelectorAll('#brand-heads [data-client]')) {
    const id = light.dataset.client, connected = state?.providers?.[id]?.connection === 'connected';
    light.dataset.connected = String(connected);
    light.dataset.active = String(id === active);
    if (connected) lit.push(providerNames[id]);
  }
  $('#brand-heads').dataset.tip = lit.length ? `Ligados: ${lit.join(', ')}.` : 'Nenhum cliente ligado.';
  syncWelcomeFleet();
}
function wireSuggestions() {
  for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => {
    $('#prompt').value = button.dataset.prompt;
    composerIntent = captureDraftIntent(null, $('#prompt').value, steerTarget(), chosenDelivery());
    $('#prompt').focus();
    renderSend();
  });
  for (const card of document.querySelectorAll('[data-select-provider]')) card.addEventListener('click', () => {
    if ($('#provider').disabled) return;
    $('#provider').value = card.dataset.selectProvider;
    $('#provider').dispatchEvent(new Event('change'));
    $('#prompt').focus();
  });
  syncWelcomeFleet();
}

// The progress card follows the request of its turn, also one HYDRAQ made itself and shows as a note.
function markTurn(node, message, owner) {
  node.dataset.ownerId = owner.id;
  node.dataset.turnId = message.turnId || owner.turns?.find(turn => turn.requestId === message.requestId)?.id || '';
  if (message.role === 'user' && !message.kind) node.dataset.request = 'true';
}

function internalMessage(message, owner) {
  const name = providerName(owner.provider);
  // Hydra rounds stay in the conversation as short notes; the dialogue and the common answer are in the task panel.
  if (message.internal === 'claudex') {
    if (message.role === 'user') return element('p', 'handoff-note', `Hydra · ${message.kind === 'peer-notice' ? 'aviso ao' : 'ronda do'} ${name} · ${new Date(message.at).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})}`);
    const details = element('details', 'handoff-summary');
    details.append(element('summary', '', `Hydra · ${name}${message.streaming ? ' · a escrever…' : ''}`), markdown(message.text, message.id));
    return details;
  }
  if (message.role === 'user') return element('p', 'handoff-note', `HYDRAQ pediu ao ${name} ${message.internal==='memory-proposal'?'uma proposta de memória':'um resumo de passagem'} · ${new Date(message.at).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})}`);
  const details = element('details', 'handoff-summary');
  details.append(element('summary', '', `${message.internal==='memory-proposal'?'Proposta de memória':'Resumo de passagem'} · ${name}${message.streaming ? ' · a escrever…' : ''}`), markdown(message.text, message.id));
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

function copyButton(text, tip, failure) {
  const button = element('button', 'copy-message', 'Copiar');
  button.type = 'button';
  button.dataset.tip = tip;
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copiado ✓'; setTimeout(() => { button.textContent = 'Copiar'; }, 1800); }
    catch { toast(failure); }
  });
  return button;
}

// The person's requests to a Hydra task stay in the conversation as their own messages, before the task's card.
function hydraRequest({ message, record }) {
  const article = element('article', 'message user hydra-request'), header = element('div', 'message-header'), content = element('div', 'message-content');
  article.dataset.hydraTask = record.id;
  const time = element('time', '', new Date(message.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }));
  time.dateTime = message.at;
  header.append(element('span', 'avatar', 'TU'), element('span', '', `Tu · ${message.type === 'update' ? 'novo requisito para o' : 'para o'} ${pairName(record.roles || HYDRA_PAIRS[0])}`), time, copyButton(message.text, 'Copiar o pedido', 'Não foi possível copiar o pedido.'));
  content.append(element('p', '', message.text));
  article.append(header, content);
  return article;
}

function renderMessages(conversation) {
  const group = companionTranscriptOwners(state?.conversations || [], conversation, members(conversation));
  const liveTask = hydraOn() ? hydraTask(conversation)?.id || claudexUI?.selected || null : null;
  const hydra = claudexUI?.transcript(group, liveTask) || { tasks: [], entries: [], shown: new Set(), signature: '' };
  const opinionState=opinionUI.viewState();
  const signature = JSON.stringify([conversation?.id,hydraOn(),hydra.signature,dualUI?.signature(conversation),opinionUI.archiveRevision,state.opinions?.archivedGroups,opinionState?.batches.map(b=>[b.id,b.conversationId,b.sourceKey]),opinionState?.automatic?.cycles.map(c=>[c.id,c.conversationId,c.requestId,c.returnRequestId,c.status]),opinionState?.merges.map(m=>[m.id,m.requestId,m.jobIds]), group.map(entry => [entry.id, entry.messages, entry.items?.filter(i=>i.turnId===entry.turns?.at(-1)?.id).map(i=>[i.id,i.type,i.status,i.summary]), entry.turns?.map(turn=>[turn.id,turn.requestId,turn.status,turn.usage,turn.nativeTurnUsage,turn.diagnostics,turn.quotaUsage]), entry.handoffState])]);
  if (signature === messageSignature) {opinionUI.refresh();dualUI?.refreshSyntheses();return;}
  messageSignature = signature;
  const view = $('#messages');
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 120;
  const oldScroll = view.scrollTop;
  imageAttachments.resetObservers();
  view.replaceChildren();
  if (!hydraHost.isConnected) view.before(hydraHost);
  opinionUI.mountArchive(view,conversation);
  // Hydra rounds, and the copy of the request published with the result, give way to the task's requests and card.
  // A task's internal requests stay hidden also once the task itself has been deleted.
  const hidden = message => message.internal === 'claudex' || message.source === 'claudex-publication' && message.role === 'user' && hydra.shown.has(message.requestId?.replace(/^cx-result:/, ''));
  const timeline = [...group.flatMap(owner => owner.messages.filter(message => !hidden(message)).map(message => ({ message, owner }))), ...hydra.entries.map(entry => ({ message: { internal: 'hydra', at: entry.at, entry }, owner: conversation }))].sort((a, b) => a.message.at.localeCompare(b.message.at));
  let placed = false;
  if (!timeline.length && !group.some(entry => entry.handoffState)) {
    if (hydraOn()) { view.append(hydraHost); return; }
    view.append(welcomeTemplate.cloneNode(true));
    wireSuggestions();
    return;
  }
  const anchors=opinionResultAnchors(timeline),resultsAt=new Map();
  timeline.forEach((entry,index)=>{const at=anchors[index];if(!resultsAt.has(at))resultsAt.set(at,[]);resultsAt.get(at).push(entry);});
  let previousOwner = null;
  for (const [index,{ message, owner }] of timeline.entries()) {
    if (message.internal === 'hydra') {
      const { card, record } = message.entry;
      if (!card) view.append(hydraRequest(message.entry));
      else if (record.id === liveTask) { view.append(hydraHost); placed = true; }
      else view.append(claudexUI.card(record));
      previousOwner = null;
      continue;
    }
    if (message.internal) { const note = internalMessage(message, owner); markTurn(note, message, owner); view.append(note); continue; }
    const delegated = companionRequest(owner, message);
    if (previousOwner && previousOwner !== owner.id && !delegated && !dualUI?.anyRecord(conversation)) view.append(element('div', 'provider-divider', `Continuação no ${providerName(owner.provider)}`));
    previousOwner = owner.id;
    const article = element('article', `message ${message.role}${message.kind === 'steer' ? ' steering-message' : ''}`);
    article.dataset.provider = owner.provider;
    if (delegated) article.classList.add('companion-delegated-message');
    article.dataset.timelineIndex=index;
    markTurn(article, message, owner);
    const header = element('div', 'message-header');
    const automaticReturn=Boolean(opinionUI.submission(message,owner));
    const avatar = element('span', 'avatar', message.role === 'user' ? (delegated || automaticReturn?'H':'TU') : '');
    if (message.role !== 'user') avatar.append(icon());
    header.append(avatar);
    header.append(element('span','',delegated ? (message.role === 'user' ? `${delegated.name} · Pedido da mascote → ${providerName(owner.provider)}` : `${providerName(owner.provider)} · Resposta à mascote ${delegated.name}`) : message.role === 'user' ? (automaticReturn?'HYDRAQ · Avaliação do parecer':message.kind === 'steer' ? 'Tu · Orientação' : message.source === 'terminal' ? 'Tu · '+providerName(owner.provider)+' original' : 'Tu') : providerName(owner.provider)));
    if (message.model) {
      const modelName = providerState(owner.provider).models?.find(model => model.id === message.model)?.name || message.model;
      header.append(element('span', 'message-model', [modelName, effortLabels[message.effort] || message.effort, message.source === 'terminal' && message.role !== 'user' ? providerName(owner.provider)+' original' : null].filter(Boolean).join(' · ')));
    }
    const time = element('time','',new Date(message.at).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'}));
    time.dateTime = message.at;
    header.append(time);
    if (message.text) {
      const user = message.role === 'user';
      header.append(copyButton(message.text, user ? (message.kind === 'steer' ? 'Copiar a orientação' : 'Copiar o pedido') : 'Copiar resposta completa', user ? 'Não foi possível copiar o pedido.' : 'Não foi possível copiar a resposta.'));
    }
    article.append(header);
    if (delegated && message.role === 'user') {
      const turn = owner.turns?.find(t => t.requestId === delegated.requestId);
      const labels = {starting:'A enviar',running:'Em execução',waiting:'Aguarda autorização',completed:'Concluído',failed:'Falhou',uncertain:'Resultado incerto',interrupted:'Interrompido'};
      const note = element('div', 'companion-delegated-note', `${labels[turn?.status] || 'Pedido delegado'} · Só leitura`);
      if (owner.id !== conversation?.id) {
        const open = element('button', 'text-button', 'Abrir tarefa'); open.type = 'button';
        open.addEventListener('click', () => choose(owner.id)); note.append(open);
      }
      article.append(note);
    }
    if (message.role === 'user') {
      const content = element('div','message-content');
      if(!opinionUI.renderSubmission(content,message))content.append(element('p','',message.text));
      imageAttachments.renderMessage(content,[...(message.attachments||[]),...(message.contextImages||[])]);
      article.append(content);
      // A request typed in an original client whose answer HYDRAQ could not read says so where it appears.
      if(message.terminalNote)article.append(element('p','terminal-note',message.terminalNote));
      if(message.projectContext){const details=element('details','handoff-context');details.append(element('summary','','Contexto do projeto enviado com este pedido'),element('pre','',message.projectContext));article.append(details);}
      if (message.handoffContext) {
        const details = element('details', 'handoff-context');
        details.append(element('summary', '', `Contexto da passagem enviado com este pedido · ${formatTokens(message.handoffContext.length)} caracteres`), element('pre', '', message.handoffContext));
        article.append(details);
      }
    } else {
      article.append(markdown(message.text, message.id));
      if (message.streaming) article.lastElementChild.append(element('span','streaming-indicator'));
      const turn = owner.turns?.find(turn => turn.requestId === message.requestId || turn.id === message.turnId);
      const finalMessage = !owner.messages.slice(owner.messages.indexOf(message) + 1).some(next => next.role === 'assistant' && (next.requestId === message.requestId || next.turnId === message.turnId));
      if(turn?.usage&&finalMessage&&owner.provider==='opencode')article.append(element('p','message-usage',`OpenCode · Entrada: ${formatTokens(turn.usage.inputTokens)} · Saída: ${formatTokens(turn.usage.outputTokens)} · Custo: ${Number.isFinite(turn.costUSD)?turn.costUSD+' USD':'não medido'}`));
      if(turn?.usagePartial&&finalMessage)article.append(element('p','message-usage','Consumo parcial: faltam contadores de um ciclo.'));
      if (turn?.usage && finalMessage && owner.provider!=='opencode') article.append(element('p', 'message-usage', `Entrada: ${formatTokens(turn.usage.inputTokens)} · Em cache: ${formatTokens(turn.usage.cachedInputTokens)} (${turn.usage.cachePercent}%) · Sem cache: ${formatTokens(turn.usage.uncachedInputTokens)}`));
      else if (turn?.nativeTurnUsage && finalMessage) article.append(element('p', 'message-usage', `Neste pedido — Entrada: ${formatTokens(turn.nativeTurnUsage.input_tokens)} · Leitura de cache: ${formatTokens(turn.nativeTurnUsage.cache_read_tokens)} · Saída: ${formatTokens(turn.nativeTurnUsage.output_tokens)} · Raciocínio: ${formatTokens(turn.nativeTurnUsage.thinking_tokens)}`));
      if (turn?.quotaUsage && !owner.messages.slice(owner.messages.indexOf(message) + 1).some(next =>
        next.role === 'assistant' && (turn.requestId && next.requestId === turn.requestId || turn.id && next.turnId === turn.id))) {
        article.append(quotaUsageView(turn.quotaUsage));
      }
    }
    if (message.role === 'assistant' && message.source === 'claudex-publication') {
      const quotas = claudexUI?.quotaRows(claudexUI.detailOf(message.claudexTask, true)) || [];
      if (quotas.length) article.append(claudexUI.quotaSection(quotas));
    }
    const planIds=[...(message.planDocumentIds||[]),...(message.planDocumentId?[message.planDocumentId]:[])];
    if(planIds.length){const files=element('div','native-plan-files');for(const id of new Set(planIds)){const button=element('button','secondary-button','Abrir ficheiro do plano');button.type='button';button.dataset.planDocument=id;button.addEventListener('click',()=>openPlanDocument(owner,id));files.append(button);}article.append(files);}
    const diagnosticTurn=owner.turns?.find(t=>message.requestId&&t.requestId===message.requestId||message.turnId&&t.id===message.turnId);
    if(diagnosticTurn?.diagnostics?.length&&!owner.messages.slice(owner.messages.indexOf(message)+1).some(m=>!m.internal&&(m.requestId&&m.requestId===diagnosticTurn.requestId||m.turnId&&m.turnId===diagnosticTurn.id)))article.append(diagnosticsView(diagnosticTurn.diagnostics));
    if (message.kind === 'steer') {
      const label = element('p', `steer-delivery delivery-${message.delivery || 'uncertain'}`, {
        preparing:'A guardar orientação…', sending: message.nativeEnqueued ? 'Na fila nativa do OpenCode · aguarda o próximo passo' : 'A aguardar confirmação do cliente…', accepted: `Recebida pelo ${providerName(owner.provider)}`, rejected: 'Orientação não entregue', uncertain: 'Entrega não confirmada · não foi reenviada',
      }[message.delivery || 'uncertain']);
      article.append(label);
      if (message.error) article.append(element('p', 'steer-error', message.error));
    }
    if(automaticReturn){article.classList.add('review-internal-message');header.remove();const content=article.querySelector('.message-content'),delivery=content.querySelector('.review-delivery');if(delivery){for(const child of [...content.children])if(child!==delivery)delivery.append(child);for(const child of [...article.children])if(child!==content)delivery.append(child);}}
    else {opinionUI.mount(article,owner,message);opinionUI.foldMessage(article,owner,message);}
    view.append(article);
    for(const source of resultsAt.get(index)||[])opinionUI.mountResults(view,source.owner,source.message,timeline.indexOf(source));
  }
  // Hydra chosen and no task yet: its card waits at the end, where the request will appear.
  if (hydraOn() && !placed) view.append(hydraHost);
  dualUI?.organize(view,timeline,conversation);
  opinionUI.organizeTranscript(view,timeline);
  for (const entry of group) if (entry.handoffState) {
    if (previousOwner && previousOwner !== entry.id) view.append(element('div', 'provider-divider', `Continuação no ${providerName(entry.provider)}`));
    view.append(pendingHandoff(entry));
  }
  renderProgress(focusConversation(conversation));
  view.scrollTop = nearBottom ? view.scrollHeight : oldScroll;
}

// The person opening or closing the reasoning box: { turnId, live, open }.
let thoughtChoice = null;
function renderProgress(conversation) {
  // A Hydra round's work, and the publication of its result, show in the task card.
  const turn = conversation?.turns?.find(entry => entry.id === conversation.progress?.turnId);
  const progress = turn?.internal === 'claudex' || turn?.source === 'claudex-publication' ? null : conversation?.progress;
  const view = progressPanel, transcript = $('#messages');
  const anchor = progress && [...transcript.querySelectorAll('[data-request]')].find(article=>article.dataset.ownerId===conversation.id&&article.dataset.turnId===progress.turnId||JSON.parse(article.dataset.progressRequests||'[]').some(([owner,turn])=>owner===conversation.id&&turn===progress.turnId));
  view.classList.toggle('hidden', !progress);
  // A request missing from the transcript (still in a handoff, say) leaves the card in its old place above it.
  const home = hydraHost.parentElement === transcript ? transcript : hydraHost;
  if(anchor){if(anchor.nextElementSibling!==view)anchor.after(view);}else if(view.nextElementSibling!==home)home.before(view);
  const items = actions && turn ? actions.turnActions(conversation, turn) : [];
  const signature = JSON.stringify([conversation?.id,progress,items.map(item=>[item.id,item.status,item.completedAt,item.durationMs,item.permissionDenied]),conversation?.messages?.some(m=>m.turnId===turn?.id&&m.streaming)]);
  if (signature === progressSignature) return;
  progressSignature = signature;
  const expanded = Boolean(view.querySelector('.progress-details')?.open);
  const thoughtExpanded = Boolean(view.querySelector('.claude-thought')?.open);
  view.replaceChildren();
  if (!progress) return;
  const nearBottom=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<120;
  view.dataset.status = progress.status;
  const live = activeStatuses.includes(progress.status), cwd = conversation.cwd;
  const heading = element('div', 'progress-heading');
  const symbol = { completed:'✓', failed:'!', interrupted:'■', uncertain:'?' }[progress.status] || '◌';
  heading.append(element('span', 'progress-symbol', symbol), element('strong', '', progress.title));
  if (actions) {
    // The request's own time: running while it runs, its length once it ends; never after an interruption.
    const work = actions.currentWork(conversation, turn), clock = element('span', 'progress-clock');
    if (live && work?.since) clock.append(elapsed(work.since));
    const total = live && progress.startedAt ? elapsed(progress.startedAt) : null, length = actions.requestSummary(conversation, turn).durationMs;
    if (total) clock.append(document.createTextNode(clock.childNodes.length ? ' · pedido ' : 'pedido '), total);
    else if (length !== null && progress.status === 'completed') clock.textContent = actions.formatDuration(length);
    if (clock.childNodes.length) heading.append(clock);
  } else {
    const counts = progress.counts;
    heading.append(element('span', 'progress-counts', [`${counts.completed} ${counts.completed === 1 ? 'ação concluída' : 'ações concluídas'}`, ...(counts.running ? [`${counts.running} em curso`] : []), ...(counts.failed ? [`${counts.failed} com erro`] : []), ...(counts.declined ? [`${counts.declined} ${counts.declined === 1 ? 'recusada' : 'recusadas'}`] : [])].join(' · ')));
  }
  view.append(heading);
  // Several actions at once are all shown, each with its own time.
  const running = actions && live ? actions.activeActions(conversation, turn) : [];
  if (running.length > 1) {
    const list = element('ul', 'progress-running');
    for (const item of running) { const entry = element('li', '', actions.actionPhrase(item, { live: true, cwd })); if (item.at) entry.append(document.createTextNode(' · '), elapsed(item.at)); list.append(entry); }
    view.append(list);
  } else if (progress.detail) view.append(element('p', 'progress-detail', progress.detail));
  if (progress.commentary && progress.status !== 'completed') view.append(element('p', 'progress-commentary', `${providerName(conversation.provider)}: ${progress.commentary}`));
  const thoughtLabel = actions?.thoughtLabel?.(conversation.provider) || '';
  const thought = thoughtLabel ? actions.latestThought(conversation, turn, Infinity) : '';
  if (thought) {
    const detail = element('details', 'claude-thought'), heading = element('summary', '', thoughtLabel);
    // A choice counts only for this request and phase: agy and Cursor open again on the next request and close at the answer.
    const choice = thoughtChoice?.turnId === turn.id ? thoughtChoice : null;
    detail.open = actions.thoughtOpen ? actions.thoughtOpen(conversation.provider, live, choice, thoughtExpanded) : thoughtExpanded;
    heading.addEventListener('click', () => { thoughtChoice = { turnId: turn.id, live, open: !detail.open }; });
    detail.append(heading, element('div', 'claude-thought-text', thought));
    view.append(detail);
  }
  const summary = actions && items.length ? actions.summaryLine(actions.requestSummary(conversation, turn)) : '';
  if (summary && !live) view.append(element('p', 'progress-summary', summary));
  const timeline = actions ? items.filter(item => item.type !== 'reasoning') : progress.actions;
  if (progress.steps.length || timeline.length) {
    const details = element('details', 'progress-details');
    details.open = expanded;
    details.append(element('summary', '', progress.steps.length ? `Plano e ações · ${progress.completedSteps} de ${progress.steps.length} passos marcados como concluídos` : `Ações deste pedido · ${timeline.length}`));
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
    if (timeline.length) {
      const list = element('ul', 'progress-actions');
      const labels = { completed:'Concluída', inProgress:'Em curso', failed:'Com erro', declined:'Recusada', unfinished:'Sem conclusão confirmada', interrupted:'Interrompida', cancelled:'Cancelada' };
      for (const action of [...timeline].reverse()) {
        const item = element('li');
        if (actions) {
          // A running action in a finished request did not finish: said so, and no time is claimed for it.
          const state = actions.actionState(action), shown = !live && state === 'inProgress' ? 'unfinished' : state, duration = actions.actionDuration(action);
          item.dataset.status = shown;
          const text = element('span', '', actions.actionPhrase(action, { cwd })), detail = element('small', '', labels[shown] || shown);
          if (duration) { const time = element('time', 'progress-duration', `${duration.measured ? '≈ ' : ''}${actions.formatDuration(duration.ms)}`); time.dataset.tip = duration.measured ? 'Medido pela HYDRAQ entre os eventos recebidos' : 'Duração indicada pelo cliente'; detail.prepend(time, document.createTextNode(' · ')); }
          else if (live && state === 'inProgress' && action.at) detail.prepend(elapsed(action.at), document.createTextNode(' · '));
          item.append(text, detail);
        } else {
          item.dataset.status = action.status;
          item.append(element('span', '', action.detail || action.type), element('small', '', labels[action.status] || action.status));
        }
        list.append(item);
      }
      details.append(element('h4', '', 'Ações observadas'), list);
      // Clients keep their latest 200 actions per conversation: a longer request has lost its first ones, and says so.
      if (actions && conversation.items.length >= 200 && conversation.items[0]?.turnId === turn.id) details.append(element('p', 'progress-detail', 'As primeiras ações deste pedido já não estão guardadas: o cliente guarda as últimas 200 por conversa.'));
    }
    view.append(details);
  }
  if(nearBottom)transcript.scrollTop=transcript.scrollHeight;
}

/** A running time, kept current by the clock below; only live things carry one. */
function elapsed(since) {
  const time = element('time', 'progress-elapsed');
  time.dataset.elapsedSince = since; time.dateTime = since;
  time.textContent = actions ? actions.formatDuration(Math.max(0, Date.now() - Date.parse(since))) : '';
  return time;
}
setInterval(() => { if (!actions) return; for (const time of document.querySelectorAll('[data-elapsed-since]')) time.textContent = actions.formatDuration(Math.max(0, Date.now() - Date.parse(time.dataset.elapsedSince))); }, 1000);

function formatTokens(value) { return new Intl.NumberFormat('pt-PT').format(value); }

function compactTokens(value) {
  if (!Number.isFinite(value)) return '—';
  return value >= 10000 ? `${new Intl.NumberFormat('pt-PT', { maximumFractionDigits: value >= 100000 ? 0 : 1 }).format(value / 1000)} mil` : formatTokens(value);
}
function usageHeading(title, tip) {
  const heading = element('div', 'usage-heading');
  const info = element('span', 'info-dot', 'i');
  info.tabIndex = 0; info.dataset.tip = tip; info.setAttribute('aria-label', tip);
  heading.append(element('h3', '', title), info);
  return heading;
}
/** Wall time of a finished request, from the client's own start and end marks. */
function turnDuration(turn) {
  const ms = Date.parse(turn?.completedAt) - Date.parse(turn?.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${String(minutes % 60).padStart(2, '0')} min` : minutes ? `${minutes} min ${String(seconds % 60).padStart(2, '0')} s` : `${seconds} s`;
}
function usageMetrics(rows) {
  const metrics = element('dl', 'usage-grid');
  for (const [label, value, tip] of rows) {
    const cell = element('div');
    if (tip) cell.dataset.tip = tip;
    cell.append(element('dt', '', label), element('dd', '', compactTokens(value)));
    cell.lastChild.title = formatTokens(value ?? 0);
    metrics.append(cell);
  }
  return metrics;
}
function renderTurnUsage(conversation) {
  const turn = conversation?.turns?.at(-1);
  const view = $('#turn-usage');
  view.classList.toggle('hidden', !conversation);
  const name = providerName(conversation?.provider);
  view.replaceChildren(usageHeading('Último pedido', conversation?.provider === 'opencode' ? 'Tokens e custo nativos do OpenCode; não equivalem à quota de outras subscrições.' : conversation?.provider === 'claude' ? 'Tokens comunicados pelo Claude Code. Não equivalem diretamente aos limites da subscrição Claude.' : conversation?.provider === 'antigravity' ? 'Contadores nativos do agy, sem conversão para a cache de outros clientes.' : conversation?.provider === 'cursor' ? 'O protocolo ACP do Cursor não comunica contadores de tokens nem de cache.' : 'Tokens comunicados pelo Codex. Não equivalem diretamente à quota ChatGPT.'));
  const duration = turnDuration(turn);
  if (duration) { const line = element('p', 'usage-duration'); line.append(element('span', '', 'Duração'), element('strong', '', duration)); line.dataset.tip = 'Tempo entre o início e o fim do pedido no cliente.'; view.append(line); }
  if (conversation?.provider === 'antigravity') {
    const usage = turn?.nativeUsage || conversation.nativeUsage;
    if (!usage) { view.append(element('p','usage-empty','A aguardar os contadores do agy…')); return; }
    if (turn?.nativeTurnUsage) view.append(usageMetrics([['Entrada',turn.nativeTurnUsage.input_tokens],['Cache lida',turn.nativeTurnUsage.cache_read_tokens],['Saída',turn.nativeTurnUsage.output_tokens],['Raciocínio',turn.nativeTurnUsage.thinking_tokens]]));
    const session = element('details','usage-session');
    session.append(element('summary','','Totais da sessão'), usageMetrics([['Entrada',usage.input_tokens],['Cache lida',usage.cache_read_tokens],['Saída',usage.output_tokens],['Raciocínio',usage.thinking_tokens]]));
    view.append(session); return;
  }
  if(conversation?.provider==='opencode'){
    if(turn?.usage)view.append(usageMetrics([['Entrada',turn.usage.inputTokens],['Cache lida',turn.usage.cachedInputTokens],['Cache escrita',turn.usage.cacheWriteInputTokens],['Saída',turn.usage.outputTokens],['Raciocínio',turn.usage.reasoningOutputTokens]]));
    view.append(element('p','usage-empty',`Custo comunicado: ${Number.isFinite(turn?.costUSD)?new Intl.NumberFormat('pt-PT',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(turn.costUSD):'não medido'}. Só modelos gratuitos OpenCode. Contadores de cache nativos quando disponíveis; subagentes desativados nesta versão.`));return;
  }
  if (conversation?.provider === 'cursor') { view.append(element('p','usage-empty','Contadores de tokens e cache indisponíveis neste protocolo.')); return; }
  if (!turn?.usage) {
    view.append(element('p', 'usage-empty', turn && activeStatuses.includes(turn.status) ? `A aguardar os contadores do ${name}…` : 'Sem medição separada para este pedido.'));
    return;
  }
  const usage = turn.usage;
  const metrics = usageMetrics([['Entrada', usage.inputTokens, 'Tokens de entrada deste pedido, incluindo o histórico da sessão.'], ['Da cache', usage.cachedInputTokens, 'Entrada reutilizada da cache do servidor: mais rápida e mais barata.'], ['Sem cache', usage.uncachedInputTokens, 'Entrada processada de novo neste pedido.'], ['Saída', usage.outputTokens, 'Tokens escritos pelo modelo, incluindo raciocínio quando comunicado.']]);
  if (Number.isFinite(usage.cachePercent) && usage.inputTokens > 0) {
    const headline = element('p', 'cache-headline');
    headline.append(element('strong', '', `${usage.cachePercent}%`), element('span', '', ' da entrada reutilizada'));
    view.append(headline);
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
  view.append(metrics);
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

const activityFilters = [
  ['all', 'Tudo', 'Todas as ações observadas.', () => true],
  ['commands', 'Comandos', 'Comandos executados no terminal.', item => item.type === 'commandExecution'],
  ['files', 'Ficheiros', 'Alterações de ficheiros.', item => item.type === 'fileChange'],
  ['web', 'Web', 'Pesquisas e páginas consultadas.', item => item.type === 'webSearch'],
  ['tools', 'Ferramentas', 'Ferramentas MCP e subagentes.', item => ['mcpToolCall', 'subagent'].includes(item.type)],
  ['errors', 'Erros', 'Ações com erro ou recusadas.', item => item.permissionDenied || ['failed', 'declined'].includes(item.status)],
];
let activityFilter = 'all';
function renderActivityFilter(items) {
  const signature = JSON.stringify([activityFilter, activityFilters.map(([id,,,match]) => items.filter(match).length)]);
  const view = $('#activity-filter');
  if (view.dataset.signature === signature) return;
  view.dataset.signature = signature;
  if (!items.length) { view.replaceChildren(); return; }
  view.replaceChildren(...activityFilters.map(([id, label, tip, match]) => {
    const count = items.filter(match).length;
    const chip = element('button', 'filter-chip', label);
    chip.type = 'button'; chip.dataset.tip = tip;
    chip.setAttribute('aria-pressed', String(activityFilter === id));
    if (id !== 'all') chip.append(element('span', '', String(count)));
    chip.hidden = id !== 'all' && !count && activityFilter !== id;
    chip.addEventListener('click', () => { activityFilter = id; activitySignature = ''; renderActivity(focusConversation()); });
    return chip;
  }));
}
function turnHeading(item, owners) {
  const owner = owners.find(entry => entry.provider === item.provider && entry.turns?.some(turn => turn.id === item.turnId));
  const turn = owner?.turns.find(entry => entry.id === item.turnId);
  const request = owner?.messages.find(message => message.role === 'user' && !message.internal && (message.requestId === turn?.requestId || message.turnId === item.turnId));
  const time = turn?.startedAt ? new Date(turn.startedAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : '';
  const text = request?.text?.replace(/\s+/g, ' ').trim() || (turn?.internal ? 'Pedido interno do HYDRAQ' : 'Pedido');
  const heading = element('div', 'activity-turn');
  heading.append(element('span', '', `${providerName(item.provider)}${time ? ` · ${time}` : ''}`), element('strong', '', text.length > 90 ? `${text.slice(0, 90)}…` : text));
  heading.dataset.tip = text.slice(0, 600);
  return heading;
}
function renderActivity(conversation) {
  const owners = members(conversation);
  const all = owners.flatMap(owner => owner.items.map(item=>({...item,provider:owner.provider}))).sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  const match = activityFilters.find(([id]) => id === activityFilter)?.[3] || (() => true);
  const items = all.filter(match);
  renderActivityFilter(all);
  const signature = JSON.stringify([conversation?.id,activityFilter,all]);
  if (signature !== activitySignature) {
    activitySignature = signature;
    const open = new Set([...$('#activity').querySelectorAll('details[open]')].map(node => node.dataset.id));
    $('#activity-count').textContent = String(all.length).padStart(2,'0');
    const view = $('#activity');
    view.replaceChildren();
    if (!items.length) {
      const empty = element('div','empty-activity');
      empty.append(icon(),element('p','',all.length ? 'Nenhuma ação neste filtro.' : 'O trabalho aparece aqui.'),element('small','',all.length ? 'Escolhe “Tudo” para ver todas as ações.' : 'Comandos, ferramentas e alterações, à medida que acontecem.'));
      view.append(empty);
    }
    let previousTurn;
    for (const item of [...items].reverse()) {
      const turnKey = `${item.provider}:${item.turnId || ''}`;
      if (turnKey !== previousTurn) { previousTurn = turnKey; if (item.turnId) view.append(turnHeading(item, owners)); }
      const details = element('details','activity-item');
      details.dataset.id = item.id;
      details.dataset.status = item.status || 'inProgress';
      details.open = open.has(item.id);
      const owner = owners.find(entry => entry.items.some(own => own.id === item.id)), duration = actions?.actionDuration(item);
      details.append(element('summary','',`${providerName(item.provider)}${item.parentToolUseId ? ' · Subagente' : ''} · ${actions ? actions.actionPhrase(item, { cwd: owner?.cwd }) : itemDescription(item)}`));
      const statusText = item.permissionDenied ? (item.provider === 'antigravity' ? 'Recusada pelo agy' : 'Recusada') : (statusLabels[item.status] || item.status || 'Em execução');
      details.append(element('small','',`${statusText}${item.exitCode !== undefined && item.exitCode !== null ? ` · saída ${item.exitCode}` : ''}${duration ? ` · ${duration.measured ? '≈ ' : ''}${actions.formatDuration(duration.ms)}` : ''}`));
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
      const client=providerName(request.id.split(':')[0]);
      card.append(element('h3','',`${client} precisa da tua autorização`), element('pre','',request.params.toolCall?.title || `Ferramenta do ${client}`));
      const tool = request.params.toolCall || {};
      const item = approvalItem(request), input = tool.rawInput || item?.parameters;
      const locations = tool.locations || item?.locations;
      if (input) card.append(element('pre','',typeof input === 'string' ? input : JSON.stringify(input,null,2)));
      if (locations?.length) card.append(element('p','',`Caminhos: ${locations.map(location=>location.path).join(', ')}`));
      for (const block of tool.content || []) if (block.type === 'diff') card.append(element('pre','',`${block.path}\nAntes:\n${block.oldText || ''}\nDepois:\n${block.newText || ''}`));
      if (!(tool.content || []).some(block=>block.type==='diff') && item?.changes?.length) card.append(element('pre','',item.changes.map(change=>`${change.path}\n${change.diff || ''}`).join('\n\n')));
      const labels={allow_once:'Permitir desta vez',allow_always:'Permitir sempre',reject_once:'Recusar',reject_always:'Recusar sempre'};
      if (client === 'Cursor' && (request.params.options || []).some(option => option.kind === 'allow_always')) {
        card.append(element('p','', 'Permitir sempre pode guardar a autorização na configuração do Cursor para pedidos futuros.'));
      }
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
      const owner=state.conversations.find(c=>c.id===request.conversationId),document=owner?.turns.find(t=>t.id===request.params.turnId)?.planDocuments?.find(d=>d.id===request.params.planDocumentId||request.params.toolCallId&&d.toolCallId===request.params.toolCallId);if(document){const file=element('button','secondary-button','Abrir ficheiro do plano');file.type='button';file.addEventListener('click',()=>openPlanDocument(owner,document.id));card.append(file);}
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
      if (request.params.toolName === 'ExitPlanMode') card.append(element('p','','Aprovar o plano tira o Claude de Planear até ao fim deste pedido: pode começar a implementar, pedindo autorização para cada alteração. No pedido seguinte volta ao modo escolhido na caixa de mensagens.'));
      if (request.params.description) card.append(element('p','',request.params.description));
      const preview = input.command || input.plan || (input.file_path ? `${input.file_path}\n${input.content ?? input.new_string ?? ''}` : JSON.stringify(input,null,2));
      card.append(element('pre','',String(preview).slice(0,8000)));
      if (request.params.blockedPath) card.append(element('p','',`Caminho: ${request.params.blockedPath}`));
      card.append(approvalButton('Permitir desta vez',()=>respond({decision:'accept'})),approvalButton('Recusar',()=>respond({decision:'decline'}),true),approvalButton('Parar tarefa',()=>respond({decision:'cancel'}),true));
    } else if (request.method === 'claude/askUserQuestion') {
      card.append(element('h3','','O Claude Code tem perguntas'));
      const fields=[];
      for (const [index,question] of request.params.questions.entries()) {
        const group=element('fieldset','cursor-question'); group.append(element('legend','',question.header ? `${question.header} · ${question.question}` : question.question));
        const choices=[];
        for (const option of question.options) {
          const label=element('label','toggle-field'), input=element('input');
          input.type=question.multiSelect?'checkbox':'radio';input.name=`claude-${request.id}-${index}`;input.value=option.label;
          label.append(input,document.createTextNode(option.description ? `${option.label} — ${option.description}` : option.label));group.append(label);choices.push(input);
        }
        const other=element('input');other.type='text';other.placeholder='Ou escreve a tua resposta';other.setAttribute('aria-label',`Outra resposta: ${question.question}`);
        group.append(other);fields.push({question,choices,other});card.append(group);
      }
      const answers=()=>Object.fromEntries(fields.map(({question,choices,other})=>[question.question,other.value.trim()?[...choices.filter(input=>input.checked&&question.multiSelect).map(input=>input.value),other.value.trim()]:choices.filter(input=>input.checked).map(input=>input.value)]));
      card.append(approvalButton('Responder',()=>respond({decision:'accept',answers:answers()})),approvalButton('Não responder',()=>respond({decision:'decline'}),true),approvalButton('Parar tarefa',()=>respond({decision:'cancel'}),true));
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
      card.append(element('h3','',`Pedido de uma ferramenta ligada ao ${providerName(request.id.split(':')[0])}`));
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

function renderFollowupQueue(conversation) {
  const panel=$('#followup-queue');
  const records=members(conversation).flatMap(owner=>(owner.followups||[]).filter(r=>!['delivered','cancelled'].includes(r.status)).map(record=>({owner,record})));
  panel.classList.toggle('hidden',!records.length);
  const signature=JSON.stringify(records.map(({owner,record})=>[owner.id,record]));
  if(panel.dataset.signature===signature)return;
  panel.dataset.signature=signature;panel.replaceChildren();
  for(const {owner,record} of records){
    const row=element('div','followup-record'),label={saving:'A guardar',queued:'Em fila',stopping:'A confirmar a paragem',dispatching:'A enviar',blocked:'Envio suspenso',uncertain:'Entrega incerta'}[record.status]||record.status;
    row.append(element('strong','',`${providerName(owner.provider)} · ${label}`));
    const detail=element('details','');detail.append(element('summary','',record.text.slice(0,100)),element('p','',record.text));row.append(detail);
    if(record.error)row.append(element('p','followup-error',record.error));
    if(record.status!=='dispatching'){
      const cancel=element('button','secondary-button',record.status==='uncertain'?'Dispensar aviso':'Cancelar mensagem');cancel.type='button';cancel.addEventListener('click',async()=>{try{await api(`/api/conversations/${owner.id}/steer`,{cancelId:record.id});accept(await api('/api/state'));render();}catch(e){toast(e.message);}});row.append(cancel);
      if(record.status==='blocked'){
        const edit=element('button','secondary-button','Editar e enviar como novo pedido');edit.type='button';edit.addEventListener('click',async()=>{if($('#prompt').value.trim()){toast('Guarda ou limpa primeiro o texto da caixa de mensagens.');return;}try{await api(`/api/conversations/${owner.id}/steer`,{cancelId:record.id});choose(owner.id,selectedProject,false,true);$('#prompt').value=record.text;composerIntent={kind:'send'};saveComposerDraft();renderSend();$('#prompt').focus();}catch(e){toast(e.message);}});row.append(edit);
      }
    }
    panel.append(row);
  }
}

function checkpointMode() {
  const selected = project();
  if (!gitPanel || !state?.claudex?.gitCheckpoints || !selected || selected.archived || selected.available === false || projectOverview ||
      nativeUI.session() || claudeUI.session() || openCodeUI.session() || agyUI.session()) return null;
  if (hydraOn()) {
    const { running, canResume } = claudexUI.view;
    return !running && !canResume && claudexUI.controls.requestMode.value === 'auto' ? 'hydra' : null;
  }
  return !dualRead?.(sandboxValue()) ? 'normal' : null;
}

function draftCheckpoint(selected, key) {
  const saved = checkpointDrafts.get(key);
  return saved?.projectId === selected?.id && typeof saved?.commit === 'string' ? saved : null;
}

function renderSend() {
  const busy = anyBusy();
  const conversation = current();
  const focus = focusConversation(conversation);
  const moving = switching(conversation);
  const dual = dualUI?.record(conversation), pendingDual = dualUI?.pendingFor();
  if (dual && composerIntent?.kind === 'steer') composerIntent = { kind: 'send' };
  const mode = draftMode(composerIntent, steerTarget(conversation));
  const steering = mode === 'steer';
  const expired = mode === 'expired-steer';
  const pending = conversation?.messages.some(message => message.kind === 'steer' && ['sending','preparing'].includes(message.delivery));
  const deliveryOptions=followupOptions(conversation),deliverySelect=$('#followup-mode');
  const signature=JSON.stringify(deliveryOptions);
  if(deliverySelect.dataset.signature!==signature){deliverySelect.replaceChildren(...deliveryOptions.map(value=>{const o=element('option','',followupDescriptions[value]?.[0]||value);o.value=value;return o;}));deliverySelect.dataset.signature=signature;}
  const delivery=composerIntent?.deliveryMode||deliveryPreferences[conversation?.provider]||deliveryOptions[0];
  if(deliveryOptions.includes(delivery))deliverySelect.value=delivery;
  deliverySelect.disabled=Boolean(sending||expired);
  deliverySelect.dataset.tip=followupDescriptions[delivery]?.[1]||'Escolhe quando entregar esta mensagem.';
  deliverySelect.classList.toggle('hidden',expired);
  renderFollowupQueue(conversation);
  const hasImages=imageAttachments.list().length>0;
  const openCodeNoImage=(providerId()==='opencode'&&!providerState().models?.find(m=>m.id===$('#model').value)?.images)||Boolean(dualUI?.imagesBlocked(conversation));
  imageAttachments.render(busy || sending || openCodeNoImage || providerState().capabilities?.images===false);
  const dualIncomplete = Boolean((dual || pendingDual) && dualUI?.incomplete(conversation));
  const dualChanging = Boolean((dual || pendingDual) && dualUI?.memberBusy);
  $('#send').disabled = Boolean(nativeUI.session() || claudeUI.session() || openCodeUI.session() || agyUI.session()) || !state || Boolean(state?.projectCatalog?.error || project()?.archived || current()?.organization?.archived || project()?.available===false) || !providerState().models?.some(m=>m.id===$('#model').value) || providerState().connection !== 'connected' || expired || (busy && (!steering || hasImages)) || sending || pending || (!$('#prompt').value.trim() && !hasImages) || (hasImages && (openCodeNoImage || providerState().capabilities?.images===false)) || members(conversation).some(needsUncertaintyReview) || (!moving && conversation?.status === 'uncertain') || (moving && targetMember(conversation)?.status === 'uncertain') || Boolean(dual && dualUI.unavailable(conversation)) || dualIncomplete || dualChanging;
  const passing = state?.handoff && members(conversation).some(entry => entry.id === state.handoff.conversationId);
  $('#stop').classList.toggle('hidden', !passing && !activeStatuses.includes(focus?.status));
  $('#send').textContent = sending ? 'A enviar…' : dualChanging ? 'A atualizar participantes…' : dualIncomplete ? 'Escolhe mais um cliente ↗' : dual && busy ? 'Aguarda o fim da ronda' : dual ? dualSendLabel(dual, { writing: !dualRead(sandboxValue()) }) : pendingDual ? `Enviar a ${1+(pendingDual.participants||[pendingDual]).length} participantes ↗` : expired ? 'Turno terminado' : steering ? (followupDescriptions[delivery]?.[0]||'Orientar')+' ↗' : moving ? `Continuar no ${providerName()} ↗` : 'Enviar ↗';
  $('#steer-mode').classList.toggle('hidden', !steering && !expired);
  $('#steer-title').textContent = expired ? 'O turno desta orientação já terminou.' : '↳ Mensagem durante a execução';
  $('#steer-description').textContent = expired ? 'O texto foi guardado. Escolhe usá-lo como novo pedido ou limpa-o.' : followupDescriptions[delivery]?.[1]||'A orientação mantém o pedido atual.';
  $('#use-as-request').classList.toggle('hidden', !expired);
  $('#use-as-request').disabled = sending;
  $('#composer').classList.toggle('steering', steering || expired);
  $('#prompt').placeholder = steering ? 'Acrescenta uma orientação para a tarefa em curso…' : 'Descreve o que queres fazer…';
  $('#composer-hint').textContent = openCodeUI.session() ? 'Esta conversa está no OpenCode original. Fecha o terminal e usa Continuar na HYDRAQ, aqui ao lado.' : nativeUI.session() ? 'Esta conversa está no terminal. Usa Continuar na HYDRAQ, aqui ao lado.' : claudeUI.session() ? 'Esta conversa está no Claude original. Sai do Claude no terminal e usa Continuar na HYDRAQ, aqui ao lado.' : agyUI.session() ? 'Esta conversa está no Antigravity original. Sai do agy (/exit) e usa Continuar na HYDRAQ, aqui ao lado.' : !steering&&workBlock() ? workReason(workBlock())+' · Este projeto/pasta ou cliente está reservado.' : passing ? 'Passagem entre clientes em curso. Aguarda ou usa Parar.' : !followupOptions(focus).length && busy ? `O ${providerName(focus.provider)} não suporta orientar durante o turno. Aguarda ou usa Parar.` : moving ? `Enter para continuar no ${providerName()} · a passagem segue com este pedido` : expired ? 'A orientação não foi enviada.' : steering ? (conversation.status === 'waiting' ? 'Orientar não aprova as ações pendentes.' : 'Enter para '+(followupDescriptions[delivery]?.[0]||'orientar').toLowerCase()) : 'Enter para enviar · Shift + Enter para nova linha';
  if ((dual || pendingDual) && !nativeUI.session() && !claudeUI.session() && !openCodeUI.session() && !agyUI.session()) {
    const name = key => providerName(dual.members[key].provider);
    $('#composer-hint').textContent = dualChanging ? 'A aguardar a confirmação da composição do Multi.' : dualIncomplete ? 'Seleciona pelo menos dois clientes na barra acima para enviar no Multi.'
      : dual && busy ? (dualUI.running(conversation) ? 'Ronda em curso · o rascunho fica guardado até terminar. Podes parar cada modelo.' : workReason(workBlock()) + ' · Este projeto/pasta ou cliente está reservado.')
      : !dual || multiTargets(dual).length > 1 ? 'Enter para enviar aos participantes selecionados · respostas independentes nesta ronda'
      : `Enter para enviar só ao ${name(multiTargets(dual)[0])} · os restantes recebem esta troca quando voltares a falar com eles`;
    // Said before sending: a synthesis meant for the next round that is still being written does not go with it.
    if (dual && !busy && dualUI.pendingSynthesis(conversation)) $('#composer-hint').textContent += ' · A síntese ainda está a ser escrita: se enviares agora, esta ronda segue sem ela.';
  }
  $('#stop').textContent = '■ Parar';
  if (hydraOn()) renderHydraSend();
  const checkpoint = $('#git-checkpoint-trigger'), checkpointType = checkpointMode();
  const savedPoint = checkpointType === 'hydra' && draftCheckpoint(project(), composerKey());
  checkpoint.hidden = !checkpointType;
  checkpoint.disabled = sending || busy || Boolean(claudexUI?.sending) || steering || expired;
  checkpoint.textContent = savedPoint ? 'Ponto de segurança · ' + savedPoint.commit.slice(0, 8) : 'Criar ponto de segurança';
  dictationUI?.sync();
  if(dictationUI?.active)$('#send').disabled=true;
}
// In Hydra the composer sends to the task: start, update the request of both, or resume.
function renderHydraSend() {
  const view = claudexUI.view || {}, text = $('#prompt').value.trim();
  $('#send').textContent = sending || claudexUI.sending ? 'A enviar…' : `${claudexUI.send.textContent} ↗`;
  $('#send').disabled = sending || claudexUI.send.disabled || (!text && !view.canResume) || imageAttachments.list().length > 0;
  $('#stop').classList.toggle('hidden', !view.running);
  $('#stop').textContent = `■ ${view.stopLabel || 'Pausar todos'}`;
  $('#stop').disabled = Boolean(view.stopDisabled);
  $('#steer-mode').classList.add('hidden');
  $('#composer').classList.remove('steering');
  $('#prompt').placeholder = claudexUI.prompt.placeholder;
  $('#composer-hint').textContent = claudexUI.hint.textContent;
  imageAttachments.render(true);
  // The topbar names the task's state, not the member session's (a paused task leaves both interrupted).
  if (current()?.claudexTask && claudexUI.badge.textContent) {
    $('#session-badge').textContent = claudexUI.badge.textContent;
    $('#session-badge').dataset.status = view.running ? 'running' : ['completed', 'uncertain'].includes(view.status) ? view.status : '';
  }
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
          accept(await api('/api/state')); $('#handoff-mode').value = 'quick'; render();
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
  const label=element('label','','Resumo revisto por ti');
  const input=element('textarea');input.rows=5;input.placeholder='Objetivo, restrições, trabalho feito, resultados por confirmar e próximos passos…';input.value=recoveryDrafts.get(owner.id)||'';input.addEventListener('input',()=>recoveryDrafts.set(owner.id,input.value));label.append(input);view.append(label);
  view.append(approvalButton('Usar este resumo na próxima passagem',async()=>{
    await api(`/api/conversations/${owner.id}/handoff-recovery`,{expectedRecoveryId:owner.handoffRecovery.id,summary:input.value});
    recoveryDrafts.delete(owner.id);
    accept(await api('/api/state'));render();toast('Resumo guardado. Revê e envia o próximo pedido; o original continua no histórico.');
  }));
}

// The conversation stays in view; the task card sits in it, after the person's requests (see renderMessages).
// The composer and the Modo panel drive the task.
function renderHydra(conversation) {
  const on = hydraOn(), pair = on ? hydraPair(conversation) : null, task = on ? hydraTask(conversation) : null;
  if (on) document.body.dataset.hydra = pairName(pair); else delete document.body.dataset.hydra;
  // The pair's two colours, side by side: composer, chip and task card take them in a gradient.
  for (const [index, name] of ['--pair-a', '--pair-b'].entries()) { if (on) document.body.style.setProperty(name, `var(--c-${pair[index]})`); else document.body.style.removeProperty(name); }
  hydraHost.classList.toggle('hidden', !on);
  $('#hydra-chip').hidden = !on;
  if (!claudexUI) return;
  if (!on) { claudexUI.inline(null); return; }
  // While a request is being sent, the selection it creates must survive the state updates it causes.
  if (task) { if (!sending && claudexUI.selected !== task.id) claudexUI.choose(task.id, { show: false }); }
  else if (!sending) { if (claudexUI.selected) claudexUI.choose(null, { show: false }); claudexUI.setPair(pair); }
  claudexUI.inline(hydraHost);
  $('#hydra-chip').textContent = `Hydra · ${pairName(pair)}`;
  $('#hydra-chip').dataset.tip = task ? 'Tarefa Hydra desta conversa. Os participantes, os modelos e as proteções estão no painel Modo.' : 'Escolher a dupla, os modelos e as proteções no painel Modo.';
}

function render() {
  $('#git-panel-trigger').hidden = !gitPanel || !project() || Boolean(project()?.archived);
  if (!state) return;
  if (selected && !state.conversations.some(conversation => conversation.id === selected)) selected = null;
  const conversation = current();
  if(conversation)selectedProject=conversation.organization?.projectId||null;
  if(selectedProject&&!state.projectCatalog?.projects.some(p=>p.id===selectedProject)){selectedProject=null;projectOverview=false;}
  $('.workspace').classList.toggle('hidden',projectOverview);
  projectMemory.render();
  nativeUI.render();
  claudeUI.render();
  openCodeUI.render();
  agyUI.render();
  renderTerminal();
  opinionUI.renderAutomatic();
  const connection = providerState().connection;
  const account = providerState().account;
  const name = providerName();
  document.body.dataset.provider = providerId();
  $('#connection-state').dataset.connected = String(connection === 'connected');
  $('#provider-label').textContent = name;
  renderClientGlyph(providerId());
  $('#prompt-label').textContent = `Pedido para o ${name}`;
  $('#approvals').setAttribute('aria-label',`Pedidos do ${name}`);
  $('#connection-state').textContent = {connected:`● ${name} ligado`,connecting:`◌ A ligar ao ${name}…`,disconnected:`○ ${name} desligado`}[connection];
  $('#connection-dot').classList.toggle('connected',connection === 'connected');
  $('#account-label').textContent = account ? ({ opencode: 'OpenCode · apenas modelos gratuitos', cursor: 'Conta do Cursor · autenticação privada', antigravity: 'Sessão do agy · quota do plano', claude: `Claude · ${account.planType}` }[providerId()] || `ChatGPT · ${account.planType}`) : (connection === 'connecting' ? 'A verificar sessão…' : 'Sessão por verificar');
  $('#client-status').dataset.connection=connection;
  $('#client-status').dataset.tip=`${name} · ${connection==='connected'?'ligado':connection==='connecting'?'a ligar':'desligado'} · ${$('#account-label').textContent}. Ver ligação e detalhes.`;
  $('#reconnect').classList.toggle('hidden',connection !== 'disconnected');
  const visibleTitle=conversation?conversationGroups(state).find(g=>g.id===conversation.group)?.title||conversation.title:'';
  renderTopbar(conversation, visibleTitle);
  const focus = focusConversation(conversation);
  const notice = (project()?.archived?'Projeto arquivado. Restaura-o nas definições para continuar.':current()?.organization?.archived?'Conversa arquivada. Restaura-a no menu da conversa para continuar.':project()?.available===false?project().folderError:null) || providerState().connectionError || focus?.error || conversation?.error;
  $('#notice').textContent = notice || '';
  $('#notice').classList.toggle('hidden',!notice);
  renderSettings(conversation);
  syncNextRequest();
  renderAgentDock();
  renderSidebar();
  renderMessages(conversation);
  renderHydra(conversation);
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
  const review=state.opinions?.automatic?.cycles.find(r=>['waiting-main','preparing','reviewing','delivering','assessing'].includes(r.status));
  if(review&&(!conversation||conversation.group!==review.groupId)){banner.classList.remove('hidden');banner.textContent=`Revisão automática · ${review.title} · ${review.status==='reviewing'?'Revisor em curso ou decisão pendente':'Ciclo em curso'} — Abrir`;banner.onclick=()=>choose(review.conversationId);}
  renderProjectSuggestion();
  const collaboration=state.collaboration?.sessions.find(s=>s.id===state.collaboration.activeId);
  if(collaboration&&collaborationUI.view!=='collaboration'){banner.classList.remove('hidden');banner.textContent=`Colaboração · ${collaboration.title} · ${collaboration.pendingDecisions?'Aguarda a tua decisão':'Em curso'} — Abrir`;banner.onclick=()=>{collaborationUI.choose(collaboration.id);collaborationUI.show('collaboration');};}
  collaborationUI.render();
  claudexUI?.render();
  syncModePanel();
  providerStatus?.render();
  companionUI?.sync();
}
function renderTopbar(conversation, visibleTitle) {
  const title = conversation ? visibleTitle : projectOverview ? (project()?.name || 'Sem projeto') : 'Nova conversa';
  $('#project-name').textContent = title;
  $('#project-name').dataset.tip = conversation ? `Conversa: ${visibleTitle}` : projectOverview ? 'Visão geral do projeto' : 'Conversa nova: o título surge do primeiro pedido.';
  const folder = conversationFolder(conversation) || project()?.root || '';
  const editable = !conversation && !project() && !projectOverview;
  $('#cwd').classList.toggle('hidden', !editable);
  $('#choose-cwd').classList.toggle('hidden', !editable);
  $('#folder-chip').classList.toggle('hidden', editable || !folder);
  $('#folder-label').textContent = project() ? `${project().name} · ${shortPath(folder)}` : shortPath(folder);
  $('#folder-chip').dataset.tip = `${project() ? `Projeto ${project().name}. ` : 'Conversa sem projeto. '}Pasta: ${folder}. ${conversation ? 'A pasta fica fixa nesta conversa.' : 'A pasta do projeto é fixa.'}`;
  const status = conversation ? focusConversation(conversation)?.status || conversation.status : null;
  $('#session-badge').classList.toggle('hidden', !conversation);
  $('#session-badge').dataset.status = status || '';
  $('#session-badge').textContent = status ? statusLabels[status] || status : '';
  $('#session-badge').dataset.tip = conversation ? `Estado da conversa · ${providerName(focusConversation(conversation)?.provider)}` : '';
}
function renderProjectSuggestion(){
  const view=$('#project-suggestion');view.replaceChildren();const folder=$('#cwd').value.replace(/\/$/,'');
  const suggestion=!current()&&!project()?state.projectCatalog?.projects.filter(p=>!p.archived&&(folder===p.root||folder.startsWith(p.root==='/'?'/':p.root+'/'))).sort((a,b)=>b.root.length-a.root.length)[0]:null;
  view.classList.toggle('hidden',!suggestion);if(!suggestion)return;
  const button=element('button','',`Usar projeto ${suggestion.name}`);button.type='button';button.addEventListener('click',()=>choose(null,suggestion.id));view.append(button,element('small','','O novo pedido usará a pasta raiz deste projeto. Podes manter esta conversa solta.'));
}

$('#provider').addEventListener('change',()=> {
  if (dualUI?.record(current())) { const wanted = $('#provider').value; $('#provider').value = providerId(); dualUI.chooseClient(wanted); return; }
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
  renderSwitchNote(current());
});
$('#effort').addEventListener('change',()=> {
  saveSettingsDraft();
  renderCacheInfo(current());
});
document.addEventListener('change',event=>{if(event.target.matches('#model, #effort, [id^=cx-]'))providerStatus?.render();});
$('#context').addEventListener('change',()=>saveSettingsDraft());
$('#fast').addEventListener('change',()=>saveSettingsDraft());
$('#sandbox').addEventListener('change',()=> { renderPermissionTips(); saveSettingsDraft(); renderCacheInfo(current()); dualUI?.enforceWrite(!dualRead(sandboxValue())); renderSend(); });
$('#plan-toggle').addEventListener('click',()=> {
  if (!planSupport[providerId()]) return;
  planMode = !planMode;
  renderPermissionTips(); saveSettingsDraft();
  dualUI?.enforceWrite(!dualRead(sandboxValue()));
  renderSend();
  syncModePanel();
});
$('#prompt').addEventListener('input',()=> {
  composerIntent = captureDraftIntent(composerIntent, $('#prompt').value, steerTarget(), chosenDelivery());
  saveComposerDraft();renderSend();
});
$('#cwd').addEventListener('input',()=>{saveComposerDraft();renderProjectSuggestion();});
$('#followup-mode').addEventListener('change',()=>{
  const c=current(),deliveryMode=$('#followup-mode').value;
  if(!c?.turnId||!['running','waiting'].includes(c.status)||!followupOptions(c).includes(deliveryMode))return;
  deliveryPreferences[c.provider]=deliveryMode;
  if($('#prompt').value.trim())composerIntent={kind:'steer',conversationId:c.id,turnId:c.turnId,deliveryMode};
  saveComposerDraft();renderSend();
});
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
$('#sidebar-toggle').addEventListener('click',()=>layout.toggle('sidebar'));
$('#inspector-toggle').addEventListener('click',()=>layout.toggle('inspector'));
$('#client-status').addEventListener('click',()=>{layout.toggle('inspector',true);$('#inspector-tabs [data-inspector-view=system]')?.click();$('#settings-details').open=true;$('#settings-details > summary')?.focus({preventScroll:true});$('#settings-details').scrollIntoView({block:'nearest'});});
$('#sidebar-scrim').addEventListener('click',()=>layout.closeDrawers());
$('#inspector-scrim').addEventListener('click',()=>layout.closeDrawers());
for (const resizer of document.querySelectorAll('.panel-resizer')) layout.bindResizer(resizer);
document.addEventListener('keydown',event=>{if(event.key==='Escape')layout.closeDrawers();});
$('#reset-layout').addEventListener('click',()=>{layout.reset();toast('Disposição dos painéis reposta.');});
$('#prose-width').addEventListener('click',()=>layout.setProse(layout.state.prose==='full'?'comfortable':'full'));
$('#text-size').addEventListener('input', event => layout.setTextSize(Number(event.target.value)));
$('#reset-text').addEventListener('click', () => { layout.resetText(); toast('Tamanho do texto reposto: 15 px.'); });
const appearanceName = entry => entry.name;
const appearanceMenu = new AppearanceMenu({ layout, trigger: $('#theme-toggle'), inline: $('#appearance-choices'), onChange: entry => toast(`Aparência: ${appearanceName(entry)}.`) });
const chooseAppearance = entry => { layout.setTheme(entry.theme); appearanceMenu.render(); toast(`Aparência: ${appearanceName(entry)}.`); };
new ClientColors({ layout, container: $('#client-colors') });
$('#reset-colors').addEventListener('click', () => { layout.resetColors(); toast('Cores dos clientes repostas.'); });
const chooseColumn = value => { layout.setColumn(value); toast(`Largura da conversa: ${COLUMNS.find(entry => entry.value === value).name}.`); };
$('#column-choices').replaceChildren(...COLUMNS.map(entry => {
  const button = element('button', 'column-option');
  button.type = 'button';
  button.dataset.column = entry.value;
  button.setAttribute('role', 'radio');
  button.dataset.tip = entry.description;
  const preview = element('span', 'column-preview');
  preview.setAttribute('aria-hidden', 'true');
  preview.append(element('i'));
  button.append(preview, element('span', '', entry.name));
  button.addEventListener('click', () => chooseColumn(entry.value));
  return button;
}));
$('#column-choices').addEventListener('keydown', event => {
  const buttons = [...$('#column-choices').querySelectorAll('.column-option')], index = buttons.indexOf(document.activeElement);
  const next = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
  if (next === undefined || index < 0) return;
  event.preventDefault();
  const target = buttons[(next + buttons.length) % buttons.length];
  layout.setColumn(target.dataset.column);
  target.focus();
});

// The settings repeat the composer's next-request controls. The composer stays the source
// of truth: a change here sets the original control and replays its own change handling.
const nextRequest = [];
function mirrorSelect(label, source) {
  const row = element('div', 'next-request-row'), caption = element('label', '', label), select = element('select', 'pill-select');
  select.id = `next-${source.id}`; caption.htmlFor = select.id;
  select.addEventListener('change', () => { source.value = select.value; source.dispatchEvent(new Event('change', { bubbles: true })); });
  row.append(caption, select);
  nextRequest.push({ row, sync() {
    const options = [...source.options].map(option => [option.value, option.textContent, option.disabled]), signature = JSON.stringify(options);
    if (signature !== select.dataset.signature) {
      select.dataset.signature = signature;
      select.replaceChildren(...options.map(([value, text, disabled]) => { const option = element('option', '', text); option.value = value; option.disabled = disabled; return option; }));
    }
    select.value = source.value;
    select.disabled = source.disabled;
    select.dataset.tip = source.dataset.tip || '';
    row.hidden = Boolean(source.closest('.hidden'));
  } });
}
function mirrorToggle(label, source) {
  const row = element('div', 'next-request-row'), caption = element('span', '', label), toggle = element('button', 'pill-toggle next-request-toggle');
  toggle.type = 'button'; toggle.id = `next-${source.id}`; toggle.setAttribute('aria-labelledby', `${toggle.id}-label`); caption.id = `${toggle.id}-label`;
  const checkbox = source.matches('input[type="checkbox"]');
  toggle.addEventListener('click', () => {
    if (checkbox) { source.checked = !source.checked; source.dispatchEvent(new Event('change', { bubbles: true })); }
    else source.click();
    syncNextRequest();
  });
  row.append(caption, toggle);
  nextRequest.push({ row, sync() {
    const on = checkbox ? source.checked : source.getAttribute('aria-pressed') === 'true';
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = source.id==='review-toggle' ? (on?source.textContent.replace('Revisor · ',''):'Desligado') : on ? 'Ativo' : 'Desligado';
    toggle.disabled = source.disabled;
    toggle.dataset.tip = (checkbox ? source.closest('[data-tip]') : source)?.dataset.tip || '';
    row.hidden = Boolean(source.closest('.hidden'));
  } });
}
mirrorSelect('Cliente', $('#provider'));
mirrorSelect('Modelo', $('#model'));
mirrorSelect('Raciocínio', $('#effort'));
mirrorSelect('Contexto', $('#context'));
mirrorToggle('Fast', $('#fast'));
mirrorToggle('Planear', $('#plan-toggle'));
mirrorToggle('Revisor', $('#review-toggle'));
mirrorToggle('Multi', $('#dual-toggle'));
mirrorSelect('Permissões', $('#sandbox'));
$('#next-request-grid').replaceChildren(...nextRequest.map(entry => entry.row));
function syncNextRequest() {
  for (const entry of nextRequest) entry.sync();
  // The sidebar badge names the model and reasoning of the next request, not just the client.
  const chosen = select => select.selectedOptions[0]?.textContent || '';
  const cursorExtras = providerId() === 'cursor' ? [!$('#context-field').classList.contains('hidden') && chosen($('#context')), !$('#fast-field').classList.contains('hidden') && $('#fast').checked && 'Fast'] : [];
  $('#model-label').textContent = [chosen($('#model')), chosen($('#effort')), ...cursorExtras,opinionUI.automaticSummary()].filter(Boolean).join(' · ') || 'Modelo por escolher';
  $('#model-label').dataset.tip = opinionUI.automaticSummary() ? $('#review-toggle').dataset.tip : '';
}
$('#composer').addEventListener('change', () => { syncNextRequest(); syncModePanel(); });

// Modo: the inspector card chooses how the next request runs (Normal, Dual, Revisor or Hydra) and
// repeats the client and model as chips. As above, the composer and the Hydra task view stay the
// source of truth: a chip sets their control and replays its change handling.
const shortClients = { codex: 'Codex', antigravity: 'Antigravity', claude: 'Claude', cursor: 'Cursor', opencode: 'OpenCode' };
const hydraClients = { codex: 'Codex', claude: 'Claude', antigravity: 'Gemini' };
function chipGroup(label, source, { collapse = false, clients = false, text = option => option.textContent, pick, blocked = () => source.disabled } = {}) {
  const group = element('div', 'mode-field'), caption = element('span', 'mode-field-label', label), list = element('div', 'mode-chips');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', label);
  let open = false;
  const head = collapse ? element('button', 'mode-chip mode-current') : null;
  if (head) { head.type = 'button'; head.addEventListener('click', () => { open = !open; sync(); }); }
  group.append(caption, ...(head ? [head] : []), list);
  list.addEventListener('click', event => {
    const chip = event.target.closest('.mode-chip');
    if (!chip || chip.disabled) return;
    open = false;
    if (pick) pick(chip.dataset.value);
    else if (chip.dataset.value !== source.value) { source.value = chip.dataset.value; source.dispatchEvent(new Event('change', { bubbles: true })); }
    syncModePanel();
  });
  function sync() {
    const options = [...source.options], signature = JSON.stringify(options.map(option => [option.value, text(option)]));
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren(...options.map(option => {
        const chip = element('button', 'mode-chip');
        chip.type = 'button'; chip.dataset.value = option.value;
        if (clients) { chip.dataset.client = option.value; chip.append(element('span', 'mode-dot')); }
        chip.append(document.createTextNode(text(option)));
        return chip;
      }));
    }
    const disabled = blocked();
    const activeClients = clients && (dualUI?.record(current()) || dualUI?.pendingFor()) ? dualUI.activeProviders(current()) : null;
    for (const chip of list.children) {
      chip.setAttribute('aria-pressed', String(activeClients ? activeClients.includes(chip.dataset.value) : chip.dataset.value === source.value));
      chip.disabled = disabled || Boolean(clients && activeClients && dualUI?.memberBusy) || Boolean(options.find(option => option.value === chip.dataset.value)?.disabled);
      if (clients) {
        const connection = state?.providers?.[chip.dataset.value]?.connection || 'disconnected';
        chip.dataset.connection = connection;
        chip.dataset.tip = `${providerNames[chip.dataset.value] || chip.dataset.value} · ${connection === 'connected' ? 'ligado' : connection === 'connecting' ? 'a ligar' : 'desligado'}${activeClients ? (activeClients.includes(chip.dataset.value) ? ' · participa no Multi (clica para desligar)' : ' · fora do Multi (clica para ligar)') : ''}`;
      }
    }
    group.hidden = Boolean(source.closest('.hidden')) || !options.length;
    if (head) {
      const chosen = source.selectedOptions[0];
      head.textContent = chosen ? text(chosen) : 'Escolher';
      head.disabled = disabled;
      head.setAttribute('aria-expanded', String(open));
      head.setAttribute('aria-label', `${label}: ${head.textContent}. Mostrar as opções`);
      head.dataset.tip = source.dataset.tip || `${label}: mostrar as opções`;
      list.hidden = !open;
    }
  }
  return { element: group, sync };
}
function toggleField(label, chipLabel, source) {
  const group = element('div', 'mode-field'), chip = element('button', 'mode-chip', chipLabel);
  chip.type = 'button';
  chip.addEventListener('click', () => { source.checked = !source.checked; source.dispatchEvent(new Event('change', { bubbles: true })); syncModePanel(); });
  group.append(element('span', 'mode-field-label', label), chip);
  return { element: group, sync() {
    chip.setAttribute('aria-pressed', String(source.checked));
    chip.disabled = source.disabled;
    chip.dataset.tip = source.closest('[data-tip]')?.dataset.tip || '';
    group.hidden = Boolean(source.closest('.hidden'));
  } };
}
function numberField(label, source, unit) {
  const wrap = element('label', 'mode-number'), input = element('input');
  input.type = 'number'; input.min = '0'; input.step = '1'; input.inputMode = 'numeric';
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => { source.value = input.value; });
  wrap.append(input, element('span', '', unit));
  return { element: wrap, sync() { if (document.activeElement !== input) input.value = source.value; input.disabled = source.disabled; } };
}
function setupView(className, entries) {
  const view = element('div', className);
  view.append(...entries.map(entry => entry.element));
  return { element: view, sync: () => { for (const entry of entries) entry.sync(); } };
}
// In a Dual, how its rounds are synthesized; the dialog holds the choices.
const dualSynthesisField = (() => {
  const field = element('div', 'mode-field mode-synthesis'), value = element('span', 'mode-synthesis-value'), button = element('button', 'mode-chip', 'Configurar…');
  button.type = 'button';
  button.addEventListener('click', () => { const record = dualUI?.record(current()); if (record) dualUI.synthesisDialog(record); });
  field.append(element('span', 'mode-field-label', 'Síntese do Multi'), value, button);
  return { element: field, sync() {
    const record = dualUI?.record(current()), settings = record?.synthesis;
    field.hidden = !record;
    if (!record) return;
    value.textContent = (settings?.auto ? `Automática · ${providerName(settings.provider)} · ${dualUI.modelLabel(settings.provider, settings)}` : 'Manual · botão em cada ronda') + (settings?.context ? ' · entra na ronda seguinte' : '');
    button.disabled = sending;
  } };
})();
const normalSetup = setupView('mode-normal', [
  chipGroup('Cliente', $('#provider'), { clients: true, text: option => shortClients[option.value] || option.textContent,
    blocked: () => sending || ($('#provider').disabled && !dualUI?.record(current()) && !dualUI?.pendingFor()),
    pick: id => { if (dualUI?.dockClick(id)) return; if ($('#provider').disabled) return; $('#provider').value = id; $('#provider').dispatchEvent(new Event('change', { bubbles: true })); } }),
  chipGroup('Modelo', $('#model'), { collapse: true }),
  chipGroup('Raciocínio', $('#effort')),
  chipGroup('Contexto', $('#context')),
  toggleField('Velocidade', 'Fast', $('#fast')),
  dualSynthesisField,
]);
const hydraSetups = new Map();
function hydraSetup(pair) {
  const key = pair.join('+');
  if (hydraSetups.has(key)) return hydraSetups.get(key);
  const controls = claudexUI.controls, entries = [];
  for (const role of pair) {
    const model = chipGroup('Modelo', controls[`${role}Model`], { collapse: true });
    const effort = chipGroup('Raciocínio', controls[`${role}Effort`], { text: option => effortLabels[option.value] || option.textContent });
    const card = element('section', 'mode-participant');
    card.dataset.client = role;
    card.setAttribute('aria-label', `Participante ${providerNames[role]}`);
    const head = element('div', 'mode-participant-head');
    head.append(element('span', 'mode-dot'), element('strong', '', providerNames[role]));
    card.append(head, model.element, effort.element);
    entries.push({ element: card, sync() { model.sync(); effort.sync(); } });
  }
  entries.push(chipGroup('Principal · coordena o plano e a conclusão', controls.author, { text: option => providerNames[option.value] || option.textContent }));
  entries.push(chipGroup('Decisão', controls.consensus));
  entries.push(chipGroup('Tipo de pedido', controls.requestMode));
  const workspace=chipGroup('Local de trabalho',controls.workspace),workspaceHint=element('p','cx-hint mode-workspace-hint');
  workspaceHint.id='mode-workspace-hint-'+key.replaceAll('+','-');workspace.element.setAttribute('aria-describedby',workspaceHint.id);
  entries.push(workspace,{element:workspaceHint,sync(){workspaceHint.textContent=claudexUI.workspaceHint.textContent;}});
  for(const [name,label] of [['writers','Implementadores autorizados · só na cópia privada'],['implementationPreferences','Preferências de distribuição'],['externalEnabled','Ferramentas externas (MCP)'],['externalServers','Servidores externos'],['externalScope','Quem usa ferramentas externas'],['externalRisk','Autorização de ações externas']]){
    const source=controls[name],wrap=element('label','mode-field'),input=document.createElement(source.tagName.toLowerCase());input.setAttribute('aria-label',label);if(source.multiple){input.multiple=true;input.size=source.size;}if(source.maxLength>0)input.maxLength=source.maxLength;input.placeholder=source.placeholder||'';
    wrap.append(element('span','mode-field-label',label),input);input.addEventListener('change',()=>{if(source.multiple){for(const o of source.options)o.selected=[...input.selectedOptions].some(s=>s.value===o.value);}else source.value=input.value;source.dispatchEvent(new Event('change',{bubbles:true}));});
    entries.push({element:wrap,sync(){wrap.hidden=source.parentElement.hidden;input.disabled=source.disabled;if(source.tagName==='SELECT'){const sig=source.innerHTML;if(input.dataset.options!==sig){input.innerHTML=sig;input.dataset.options=sig;}for(const o of input.options)o.selected=[...source.selectedOptions].some(s=>s.value===o.value);}else if(document.activeElement!==input)input.value=source.value;}});
  }
  entries.push({element:element('p','cx-hint'),sync(){this.element.hidden=claudexUI.externalHint.hidden;this.element.textContent=claudexUI.externalHint.textContent;}});
  const guards = element('div', 'mode-field mode-guards'), turns = numberField('Proteção · turnos por participante', controls.guardTurns, 'turnos'), minutes = numberField('Proteção · minutos ativos', controls.guardMinutes, 'min');
  guards.append(element('span', 'mode-field-label', 'Proteções · 0 desativa'), turns.element, minutes.element);
  guards.dataset.tip = claudexUI.guardHint.textContent;
  entries.push({ element: guards, sync() { turns.sync(); minutes.sync(); } });
  const setup = setupView('mode-hydra', entries);
  hydraSetups.set(key, setup);
  return setup;
}
// Each tile starts with its subtitle, so its name never equals a topbar tab (the Hydra tab).
const modeTiles = Object.fromEntries([
  ['normal', 'Normal', 'Um cliente', 1, 'Um cliente responde. Podes trocar de cliente a meio da conversa, com passagem de contexto.'],
  ['dual', 'Multi', 'Até 4 modelos', 4, 'Dois a quatro clientes, todos, um ou um grupo. Respostas independentes por ronda; só o principal implementa.'],
  ['review', 'Revisor', 'Automático', 2, 'Outros modelos reveem automaticamente a resposta ou o código do principal.'],
  ['hydra', 'Hydra', 'Em diálogo', 3, 'Dois ou três modelos planeiam juntos. Se pedires alterações, os implementadores autorizados executam por etapas; todos reveem e testam, na mesma tarefa.'],
].map(([mode, label, subtitle, heads, tip]) => {
  const tile = element('button', 'mode-tile');
  tile.type = 'button'; tile.dataset.mode = mode; tile.dataset.tip = tip;
  const glyph = element('span', 'mode-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < heads; index++) glyph.append(element('i'));
  tile.append(glyph, element('strong', '', label), element('small', '', subtitle));
  tile.addEventListener('click', () => chooseMode(mode));
  return [mode, tile];
}));
$('#mode-choices').replaceChildren(...Object.values(modeTiles));
const pairButtons = HYDRA_PAIRS.map(pair => {
  const button = element('button', 'hydra-pair'), dots = element('span', 'hydra-pair-dots');
  button.type = 'button'; button.dataset.pair = pair.join('+');
  dots.setAttribute('aria-hidden', 'true');
  for (const role of pair) { const dot = element('span', 'mode-dot'); dot.dataset.client = role; dots.append(dot); }
  button.append(dots, element('strong', '', pairName(pair)), element('small', '', pair.map(role => hydraClients[role]).join(' + ')));
  button.addEventListener('click', () => {
    if (hydraTask() || button.getAttribute('aria-pressed') === 'true') return;
    hydraDrafts.set(composerKey(), pair);
    const record=dualUI?.record(current());if(record)claudexUI?.preset(Object.fromEntries(multiKeys(record).filter(k=>pair.includes(record.members[k].provider)).map(k=>[record.members[k].provider,dualMemberSettings(record,k)])));
    try { localStorage.setItem('hydraq.hydraPair', JSON.stringify(pair)); } catch { /* The choice still applies to this conversation. */ }
    render();
  });
  return button;
});
$('#hydra-pairs').replaceChildren(...pairButtons);
/** Hydra starts in this conversation, with its sessions. Leaving a task that runs here stops it and gives the conversation back; an older task keeps its own conversations. */
/**
 * Dual → Hydra: the two clients' squares meet over the composer and become the Hydra mark, in the pair's colours.
 * About a second, on top of the page and never in the way; skipped with reduced motion.
 */
function playFusion(pair) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#composer').getBoundingClientRect(), fusion = element('div', 'hydra-fusion'), mark = welcomeTemplate.querySelector('.hydra-mark')?.cloneNode(true);
  fusion.setAttribute('aria-hidden', 'true');
  fusion.style.left = `${box.left + box.width / 2}px`;
  fusion.style.top = `${box.top}px`;
  fusion.style.setProperty('--pair-a', `var(--c-${pair[0]})`);
  fusion.style.setProperty('--pair-b', `var(--c-${pair[1]})`);
  fusion.append(element('i', 'hydra-fusion-a'), element('i', 'hydra-fusion-b'), element('i', 'hydra-fusion-core'), element('i', 'hydra-fusion-ring'));
  if (mark) { mark.removeAttribute('hidden'); fusion.append(mark); }
  document.body.querySelector(':scope > .hydra-fusion')?.remove();
  document.body.append(fusion);
  setTimeout(() => fusion.remove(), 1400);
}
/** The Hydra pair of a Dual, when its two clients make one: Codex, Claude and Gemini only. */
function dualHydraPair(record) {
  const clients = record ? multiKeys(record).filter(k=>k!==record.vacant).map(k=>record.members[k].provider) : [];
  const eligible = HYDRA_PAIRS.filter(pair => pair.every(role => clients.includes(role))).sort((a,b)=>b.length-a.length);
  return eligible.find(pair=>pair.includes(record?.members[record.principal]?.provider)) || eligible[0] || null;
}
function chooseMode(mode) {
  const conversation = current(), task = hydraTask(conversation), pair = hydraPair(conversation);
  const dual = !pair && Boolean(dualUI?.record(conversation) || dualUI?.pendingFor()), review = !pair && Boolean(opinionUI.automaticSetting());
  if (mode === 'hydra') {
    if (pair) return;
    // From a Dual, Hydra keeps its pair and the models and reasoning in use, in the same conversation.
    const record = dualUI?.record(conversation), fromDual = dualHydraPair(record);
    if (record && dualUI.running(conversation)) { toast('Aguarda o fim da ronda do Multi para passar ao Hydra.'); return; }
    hydraDrafts.set(composerKey(), fromDual || lastHydraPair());
    claudexUI?.preset(fromDual ? Object.fromEntries(multiKeys(record).filter(key=>fromDual.includes(record.members[key].provider)).map(key => [record.members[key].provider, dualMemberSettings(record, key)])) : null);
    render();
    const principal=record?.members[record.principal]?.provider||conversation?.provider;
    if(principal&&claudexUI.roles().includes(principal)){claudexUI.controls.author.value=principal;syncModePanel();}
    // Measured after the switch: the composer is laid out for Hydra by then.
    if (fromDual) playFusion(fromDual);
    return;
  }
  if (task?.inPlace) { leaveHydra(task, mode); return; }
  if (task) choose(null, selectedProject);
  else if (pair) hydraDrafts.delete(composerKey());
  render();
  if (mode === 'normal') { if (!task && dual) $('#dual-toggle').click(); else if (!task && review) $('#review-toggle').click(); return; }
  const source = $(mode === 'dual' ? '#dual-toggle' : '#review-toggle');
  // A pair still working in this folder keeps its clients reserved: say so instead of doing nothing.
  if (source.disabled) { toast(mode === 'dual' ? `O Multi fica disponível quando terminar o trabalho em curso${workBlock() ? ': ' + workReason(workBlock()) : ''}.` : source.dataset.tip || 'O Revisor não está disponível agora.'); return; }
  source.click();
}
// The conversation comes back once both participants have stopped; then the chosen mode applies as usual.
async function leaveHydra(task, mode) {
  const id = selected;
  if (!task.released) {
    try { await api(`/api/claudex/${task.id}/stop`, {}); } catch (error) { toast(error.message); return; }
    toast(`${pairName(task.roles || HYDRA_PAIRS[0])} parado. A conversa volta ao modo anterior quando todos terminarem.`);
  }
  for (const deadline = Date.now() + 20000; Date.now() < deadline && state.conversations.find(c => c.id === id)?.claudexTask === task.id;) await new Promise(resolve => setTimeout(resolve, 250));
  if (selected !== id || current()?.claudexTask) { render(); return; }
  chooseMode(mode);
}
permissionControls = PermissionControls ? new PermissionControls({host:$('#permission-controls'),state:()=>state,key:composerKey,plan:()=>planMode,changed:()=>{renderSend();syncModePanel();}}) : null;
function syncModePanel() {
  if (!state) return;
  const conversation = current(), task = hydraTask(conversation), pair = hydraPair(conversation);
  const record = pair ? null : dualUI?.record(conversation), pending = pair || conversation ? null : dualUI?.pendingFor();
  const dualPair = (record || pending) ? dualUI.activeProviders(conversation) : null;
  const review = !pair && Boolean(opinionUI.automaticSetting());
  const active = { normal: !pair && !dualPair && !review, dual: Boolean(dualPair), review, hydra: Boolean(pair) };
  const subtitles = {
    normal: active.normal ? providerName() : 'Um cliente',
    dual: dualPair ? dualPair.map(id => shortClients[id] || id).join(' + ') : 'Até 4 modelos',
    review: review ? [$('#review-toggle').textContent.replace(/^Revisor · /, ''), opinionUI.automaticSummary().replace(/^Revisores: /, '')].filter(Boolean).join(' · ') : 'Automático',
    hydra: pair ? pairName(pair) : 'Em diálogo',
  };
  for (const [mode, tile] of Object.entries(modeTiles)) {
    tile.setAttribute('aria-pressed', String(active[mode]));
    tile.querySelector('small').textContent = subtitles[mode];
    tile.disabled = sending || (mode === 'dual' && (!dualUI || (!pair && $('#dual-toggle').disabled))) || (mode === 'review' && !pair && $('#review-toggle').disabled) || (mode === 'hydra' && (!claudexUI || !state.claudex || (!pair && Boolean(record) && dualUI.running(conversation))));
    const heads = mode === 'normal' ? [providerId()] : mode === 'dual' ? dualPair : mode === 'hydra' && pair ? pair.length===3?pair:[pair[0], null, pair[1]] : null;
    tile.querySelectorAll('.mode-glyph i').forEach((dot, index) => { if (heads?.[index]) dot.dataset.client = heads[index]; else delete dot.dataset.client; });
  }
  $('#mode-panel').dataset.mode = pair ? 'hydra' : dualPair ? 'dual' : review ? 'review' : 'normal';
  // The quick way from the Dual to Hydra, beside the Dual chip: same pair, models and conversation.
  const quick = $('#dual-hydra'), fromDual = dualHydraPair(record);
  quick.hidden = !record || !claudexUI || !state.claudex;
  quick.disabled = sending || !fromDual || dualUI.running(conversation);
  quick.textContent = fromDual ? `⇢ ${pairName(fromDual)}` : '⇢ Hydra';
  quick.dataset.tip = !fromDual ? 'O Hydra junta o Codex, o Claude e o Gemini. Este Multi não contém uma dupla compatível.' : dualUI.running(conversation) ? 'Aguarda o fim da ronda para passar ao Hydra.' : `Passar ao Hydra ${pairName(fromDual)} com os mesmos modelos, nesta conversa. Escreves tu o pedido seguinte.`;
  $('#mode-panel-status').textContent = task && claudexUI ? claudexUI.badge.textContent : '';
  $('#hydra-pairs').hidden = !pair;
  for (const button of pairButtons) {
    const on = Boolean(pair) && button.dataset.pair === pair.join('+');
    button.setAttribute('aria-pressed', String(on));
    button.disabled = sending || Boolean(task && !on);
    button.dataset.tip = task ? (task.inPlace ? 'A dupla fica fixa até a tarefa terminar. Para outra dupla, volta a Normal ou Multi e escolhe Hydra outra vez.' : 'A dupla fica fixa depois de iniciar. Para outra dupla, escolhe Hydra numa conversa nova.') : `${button.querySelector('strong').textContent}: ${button.querySelector('small').textContent} em diálogo, com uma resposta comum.`;
  }
  const setup = pair && claudexUI ? hydraSetup(pair) : normalSetup;
  if ($('#mode-setup').firstElementChild !== setup.element) $('#mode-setup').replaceChildren(setup.element);
  setup.sync();
  permissionControls?.render({multi:Boolean(record||pending),lastTurn:targetMember(conversation)?.turns?.at(-1),busy:sending,fixedPolicy:task?.permissionPolicy,providers:pair||dualPair||[providerId()]});
  $('#sandbox').hidden=Boolean(permissionControls?.value()?.profile&&permissionControls.value().profile!=='native');
  const access = $('#mode-access');
  const terminal = nativeUI.session() ? 'codex' : claudeUI.session() ? 'claude' : openCodeUI.session() ? 'opencode' : agyUI.session() ? 'antigravity' : null;
  const targets = record ? multiTargets(record) : [];
  const clients = pair || (record ? targets.map(key => record.members[key].provider) : dualPair) || [providerId()];
  const rows = terminal ? [[terminal, 'Terminal original', 'O cliente aplica as suas permissões no terminal.']] : clients.map((id, index) => {
    const mode = clients.length > 1 ? mapSandbox(sandboxValue(), id) : sandboxValue();
    const policy=permissionControls?.value();
    if(policy&&!pair) {
      const requested=policy.profile==='project'&&clients.length>1?{...policy,profile:'read-only'}:policy;
      const effective=effectivePolicy(id,requested,permissionControls?.roundMode()==='mixed');
      return [id,policyLabel(effective.policy),effective.supported?'Perfil do próximo pedido. O servidor verifica os limites antes de enviar.':permissionControls?.roundMode()==='mixed'?'Este participante entra com as permissões nativas nesta ronda mista.':'Este cliente não aplica o perfil. A ronda estrita será recusada antes do envio.'];
    }
    if (pair) return [id, policy?policyLabel(policy):'Proteções Hydra', 'O coordenador limita as ferramentas e reserva a escrita ao implementador autorizado. Os MCP externos dependem da autorização da tarefa.'];
    if (id === 'codex') {
      const readOnly = mode === 'read-only';
      const protectedRead = readOnly && providerState(id).capabilities?.protectedReadOnly;
      return [id, readOnly ? 'Sandbox de leitura' : 'Sandbox de projeto', protectedRead
        ? 'As escaladas são recusadas e os MCP externos herdados ficam desativados.'
        : 'O Codex aplica o sandbox nativo. As ferramentas e a rede têm regras próprias.'];
    }
    if (id === 'claude' && mode === 'plan' && (clients.length > 1 || (record && targets[index] !== record.principal)) && providerState(id).capabilities?.protectedConsultation) {
      return [id, 'Consulta limitada', 'A ronda limita as ferramentas do Claude. Os hooks e os MCP externos ficam desativados.'];
    }
    if (id === 'antigravity' && mode === 'plan') return [id, 'Proteção de planeamento', 'O HYDRAQ aplica um hook às ferramentas em modo Planear.'];
    return [id, 'Nativo', 'O cliente aplica as suas permissões e confirmações.'];
  });
  const signature = JSON.stringify(rows);
  if (access.dataset.signature !== signature) {
    access.dataset.signature = signature;
    access.replaceChildren(...rows.map(([id, label, hint]) => {
      const item = element('li','',providerName(id) + ' · ' + label);
      item.title = hint;
      return item;
    }));
  }
}
// The live Hydra card follows its updates only while the person is reading the end of the conversation.
$('#messages').addEventListener('scroll', () => { const view = $('#messages'); transcriptPinned = view.scrollHeight - view.scrollTop - view.clientHeight < 120; });
$('#hydra-chip').addEventListener('click', () => {
  layout.toggle('inspector', true);
  if (['activity', 'telemetry'].includes($('#inspector').dataset.inspectorTab)) $('#inspector-tabs [data-inspector-view=all]')?.click();
  $('#mode-panel').scrollIntoView({ block: 'nearest' });
  $('#hydra-pairs [aria-pressed="true"]')?.focus({ preventScroll: true });
});
$('#plan-toggle').addEventListener('click', () => syncNextRequest());
$('#dual-hydra').addEventListener('click', () => chooseMode('hydra'));
for (const pill of document.querySelectorAll('#agent-dock [data-agent]')) {
  pill.addEventListener('click', () => {
    if (dualUI?.dockClick(pill.dataset.agent)) return;
    if ($('#provider').disabled) return;
    $('#provider').value = pill.dataset.agent;
    $('#provider').dispatchEvent(new Event('change'));
    $('#prompt').focus();
  });
}
for (const tab of document.querySelectorAll('#inspector-tabs [data-inspector-view]')) {
  tab.addEventListener('click', () => {
    const view = tab.dataset.inspectorView;
    $('#inspector').dataset.inspectorTab = view;
    for (const item of document.querySelectorAll('#inspector-tabs [data-inspector-view]')) {
      item.setAttribute('aria-selected', String(item === tab));
    }
    if (view === 'system') $('#settings-details').open = true;
    if (view === 'telemetry' && !$('#diff-panel').classList.contains('hidden')) $('#diff-panel').open = true;
    $('#inspector-content').scrollTop = 0;
  });
}

// Interactive Command Palette (Ctrl+K / Cmd+K)
const paletteDialog = $('#command-palette');
const paletteInput = $('#command-palette-input');
const paletteList = $('#command-palette-list');
let paletteItems = [];
let paletteIndex = 0;

function buildPaletteCommands(query = '') {
  const q = query.trim().toLocaleLowerCase('pt');
  const entries = [];
  const add = (group, title, subtitle, badge, action) => {
    const hay = `${group} ${title} ${subtitle} ${badge}`.toLocaleLowerCase('pt');
    if (!q || hay.includes(q)) entries.push({ group, title, subtitle, badge, action });
  };
  for (const [id, label] of Object.entries(providerNames)) {
    const connected = state?.providers?.[id]?.connection === 'connected';
    add('Clientes Locais', `Usar ${label}`, connected ? 'Ligado · mudar para este motor' : 'Desligado · selecionar motor', id === providerId() ? 'Ativo' : label, () => {
      collaborationUI.show('conversations');
      if (!$('#provider').disabled) { $('#provider').value = id; $('#provider').dispatchEvent(new Event('change')); }
      $('#prompt').focus();
    });
  }
  add('Ações Rápidas', 'Nova conversa', 'Começar um pedido limpo no projeto atual', 'N', () => choose(null));
  add('Ações Rápidas', 'Novo projeto', 'Criar um projeto com pasta fixa e memória própria', 'Projeto', () => $('#new-project').click());
  if (planSupport[providerId()]) {
    add('Ações Rápidas', planMode ? 'Desativar modo Planear' : 'Ativar modo Planear', `Modo de planeamento nativo do ${providerName()}`, 'Plan', () => $('#plan-toggle').click());
  }
  add('Ações Rápidas', collaborationUI.view === 'collaboration' ? 'Ir para Conversas individuais' : 'Ir para Colaboração em equipa', 'Alternar entre chat individual e equipa Sol + Grok + Claude', 'Vista', () => {
    collaborationUI.show(collaborationUI.view === 'collaboration' ? 'conversations' : 'collaboration');
  });
  const currentAppearance = layout.appearance();
  for (const entry of APPEARANCES) add('Aparência', `Aparência ${appearanceName(entry)}`, entry.description, entry === currentAppearance ? 'Ativa' : 'Tema', () => chooseAppearance(entry));
  for (const entry of COLUMNS) add('Aparência', `Largura da conversa: ${entry.name}`, entry.description, entry.value === layout.state.column ? 'Ativa' : 'Largura', () => chooseColumn(entry.value));
  add('Ações Rápidas', 'Alternar painel de projetos', 'Mostrar ou esconder a barra lateral esquerda', 'Painel', () => layout.toggle('sidebar'));
  add('Ações Rápidas', 'Alternar painel de atividade e telemetria', 'Mostrar ou esconder o painel lateral direito', 'Painel', () => layout.toggle('inspector'));
  if (companionUI && companionProject()) {
    add('Ações Rápidas', 'Abrir mascote do projeto (Live)', `Assistente de voz e memória de ${companionProject().name}`, 'Voz', () => companionUI.togglePanel(true));
  }

  for (const proj of state?.projectCatalog?.projects || []) {
    if (proj.archived) continue;
    add('Projetos', proj.name, proj.root, 'Abrir projeto', () => choose(null, proj.id, true));
  }
  if (state?.conversations) {
    for (const grp of conversationGroups(state).slice(0, 24)) {
      if (grp.organization?.archived) continue;
      const providers = [...new Set(grp.members.map(m => providerNames[m.provider] || m.provider))].join(' → ');
      add('Conversas', grp.title, conversationFolder(grp.latest), providers, () => choose(grp.latest.id));
    }
  }
  return entries;
}

function renderPalette() {
  if (!paletteList) return;
  paletteItems = buildPaletteCommands(paletteInput?.value || '');
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  paletteList.replaceChildren();
  if (!paletteItems.length) {
    paletteList.append(element('p', 'command-empty', 'Nenhum comando, projeto ou conversa encontrado.'));
    return;
  }
  let currentGroup = '';
  paletteItems.forEach((item, idx) => {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      paletteList.append(element('div', 'command-group-title', currentGroup));
    }
    const row = element('button', `command-item${idx === paletteIndex ? ' is-selected' : ''}`);
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(idx === paletteIndex));
    const main = element('div', 'command-item-main');
    main.append(element('strong', '', item.title));
    if (item.subtitle) main.append(element('small', '', item.subtitle));
    row.append(main);
    if (item.badge) row.append(element('span', 'command-item-badge', item.badge));
    row.addEventListener('pointerenter', () => {
      paletteIndex = idx;
      for (const [i, node] of [...paletteList.querySelectorAll('.command-item')].entries()) {
        node.classList.toggle('is-selected', i === paletteIndex);
        node.setAttribute('aria-selected', String(i === paletteIndex));
      }
    });
    row.addEventListener('click', () => {
      paletteDialog?.close();
      item.action();
    });
    paletteList.append(row);
  });
  paletteList.querySelector('.command-item.is-selected')?.scrollIntoView({ block: 'nearest' });
}

function openCommandPalette() {
  if (!paletteDialog) return;
  if (paletteDialog.open) { paletteDialog.close(); return; }
  paletteInput.value = '';
  paletteIndex = 0;
  renderPalette();
  paletteDialog.showModal();
  paletteInput.focus();
}

$('#command-palette-trigger')?.addEventListener('click', openCommandPalette);
$('#command-palette-close')?.addEventListener('click', () => paletteDialog?.close());
paletteDialog?.addEventListener('click', event => { if (event.target === paletteDialog) paletteDialog.close(); });
paletteInput?.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
paletteInput?.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = (paletteIndex + 1) % Math.max(1, paletteItems.length); renderPalette(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = (paletteIndex - 1 + Math.max(1, paletteItems.length)) % Math.max(1, paletteItems.length); renderPalette(); }
  else if (event.key === 'Enter' && paletteItems[paletteIndex]) { event.preventDefault(); const chosen = paletteItems[paletteIndex]; paletteDialog.close(); chosen.action(); }
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandPalette();
  }
});
layout.onChange(state=>{
  $('#text-size').value = String(state.textSize);
  $('#text-size').setAttribute('aria-valuetext', `${state.textSize} píxeis`);
  $('#text-size-value').value = `${state.textSize} px`;
  for (const button of document.querySelectorAll('#column-choices .column-option')) { const on = button.dataset.column === state.column; button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1; }
  $('#prose-width').setAttribute('aria-pressed',String(state.prose==='full'));
  $('#prose-width').textContent=state.prose==='full'?'Largura confortável do texto':'Largura total do texto';
});
layout.apply();
$('#new-chat').addEventListener('click',()=>choose(null));
$('#new-loose-chat').addEventListener('click',()=>choose(null,null));
$('#choose-cwd').addEventListener('click',()=>chooseFolder({api,initial:$('#cwd').value||undefined,onChoose:value=>{$('#cwd').value=value;saveComposerDraft();renderProjectSuggestion();},toast}));
async function newConversationFolder() {
  if (selectedProject || $('#cwd').value.trim()) return $('#cwd').value.trim();
  return (await api('/api/folders/loose',{})).path;
}
document.addEventListener('keydown',event=> {
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); choose(null); }
});
// One request to the chosen recipients of a dual conversation; a new conversation starts dual first.
async function submitDual({ text, draftImages, imageDraftKey, importedContext, conversationAtSubmit, record, pending }) {
  if (dualUI.memberBusy || dualUI.incomplete(conversationAtSubmit)) return;
  if (importedContext) { toast('A importação de contexto ainda não segue nas perguntas Multi. Envia-a com o Multi desligado.'); return; }
  const target = record ? (record.target==='both'?'all':record.target) : 'all', roster = record?.members || dualUI.pendingMembers(), keys = multiTargets({members:roster,target},target);
  // Read now, while the composer still shows these choices.
  const settings = Object.fromEntries(keys.map(key => {
    const provider = roster[key].provider;
    const base = record ? dualMemberSettings(record, key) : roster[key];
    return [key, { model:base.model,effort:base.effort,...(provider==='cursor'?{context:base.context??null,fast:base.fast===true}:{}),sandbox: keys.length > 1 ? mapSandbox(sandboxValue(), provider) : sandboxValue() }];
  }));
  const autoReview = opinionUI.automaticSetting();
  sending = true;
  renderSend();
  renderSettings(current());
  try {
    let conversation = conversationAtSubmit;
    if (!conversation) {
      conversation = await api('/api/conversations', { provider: providerId(), cwd: await newConversationFolder(), ...settings.a, ...(selectedProject ? { projectId: selectedProject, revision: state.projectCatalog.revision } : {}) });
      const createdIndex = state.conversations.findIndex(entry => entry.id === conversation.id);
      if (createdIndex < 0) state.conversations.unshift(conversation); else state.conversations[createdIndex] = conversation;
      saveComposerDraft();
      for (const store of [composerDrafts, imageAttachments, projectMemory]) store.move(imageDraftKey, draftKey(conversation, selectedProject));
      opinionUI.moveAutomatic(imageDraftKey, draftKey(conversation, selectedProject));
      choose(conversation.id, selectedProject, false, true);
      composerDrafts.records.delete(imageDraftKey);
      dualUI.pending.set(draftKey(conversation, selectedProject), pending);
    }
    if (!record) {
      try { record = (await api(`/api/conversations/${conversation.id}/dual`, pending)).dual; }
      catch (error) { throw new Error(`O Multi não foi ativado: ${error.message} Nada foi enviado.`); }
      dualUI.consumePending(imageDraftKey);
      dualUI.consumePending(draftKey(conversation, selectedProject));
    }
    const attachments = await imageAttachments.upload(draftImages, conversation);
    const revision=record.revision||0;
    const signature=JSON.stringify([record.id,text,target,settings,attachments]);
    if(dualUI.pendingSend?.signature!==signature)dualUI.pendingSend={signature,requestId:crypto.randomUUID()};
    const result = await api(`/api/dual/${record.id}/send`, { permissionPolicy:permissionControls?.value(),permissionMode:permissionControls?.roundMode(),text, requestId: dualUI.pendingSend.requestId, multiVersion:2, revision, target, settings, ...(attachments.length ? { attachments } : {}), ...(keys.length === 1 ? { autoReview } : {}) });
    dualUI.pendingSend=null;
    if (checkpointDrafts.has(imageDraftKey)) checkpointDrafts.delete(imageDraftKey);
    // One recipient failed: the other already has the question, so the draft is not kept; the panel offers a resend.
    const failed = Object.keys(result.errors || {});
    if (failed.length) {
      const sent = keys.filter(key => !failed.includes(key)).map(key => providerName(record.members[key].provider));
      toast(`Enviado ao ${sent.join(' e ')}. Falhou no ${failed.map(key => `${providerName(record.members[key].provider)}: ${String(result.errors[key]).replace(/[.!?]?$/, '.')}`).join(' ')} Usa «Reenviar» no painel quando a outra resposta terminar.`);
    }
    const key = draftKey(conversation, selectedProject);
    opinionUI.consumeAutomatic(imageDraftKey);
    opinionUI.consumeAutomatic(key);
    imageAttachments.consume(draftImages);
    for (const member of keys) settingDrafts.delete(`${key}:${record.members[member].provider}`);
    composerDrafts.clear(key, text);
    if (selected === conversation.id && $('#prompt').value === text) { $('#prompt').value = ''; composerIntent = null; }
  } catch (error) { if(error.status)dualUI.pendingSend=null;toast(error.message); }
  finally { sending = false; try { accept(await api('/api/state')); } catch { /* SSE reconnect handles transport loss; do not replay writes. */ } render(); }
}
async function submitHydra() {
  renderSend();
  if ($('#send').disabled) return;
  const text = $('#prompt').value, key = composerKey(), conversationAtSubmit = current();
  const point = checkpointMode() === 'hydra' && draftCheckpoint(project(), key);
  sending = true;
  renderSend();
  try {
    // Hydra owns its pending request and keeps an automatic folder across retries.
    const cwd = conversationAtSubmit?.cwd || $('#cwd').value.trim();
    const task = await claudexUI.requestInline(text.trim(), { projectId: selectedProject, cwd, conversationId: conversationAtSubmit?.id,
      gitCheckpoint: point || undefined,permissionPolicy:permissionControls?.value() });
    if (!task) return;
    if (checkpointDrafts.has(key)) checkpointDrafts.delete(key);
    composerDrafts.clear(key, text);
    if (composerKey() === key && $('#prompt').value === text) { $('#prompt').value = ''; composerIntent = null; }
    // A task from a conversation stays in it. One from a new conversation has a conversation per participant,
    // in one group: open it here.
    if (task.id && task.id !== hydraTask(conversationAtSubmit)?.id) {
      accept(await api('/api/state'));
      const member = !task.inPlace && (task.roles || HYDRA_PAIRS[0]).map(role => task.members?.[role]?.conversationId).find(id => state.conversations.some(c => c.id === id));
      if (member) choose(member, selectedProject, false, true);
      hydraDrafts.delete(key);
    }
  } catch (error) { toast(error.message); } finally { sending = false; try { accept(await api('/api/state')); } catch { /* SSE reconnect handles transport loss; do not replay writes. */ } render(); }
}
$('#composer').addEventListener('submit',async event=> {
  event.preventDefault();
  if(dictationUI?.active){toast('Termina ou cancela o ditado antes de enviar.');return;}
  if (hydraOn()) { await submitHydra(); return; }
  composerIntent = captureDraftIntent(composerIntent, $('#prompt').value, steerTarget(), chosenDelivery());
  renderSend();
  if ($('#send').disabled) return;
  const text = $('#prompt').value;
  const draftImages=[...imageAttachments.list()];
  const imageDraftKey=composerKey();
  const importedContext=projectMemory.pending.get(imageDraftKey);
  const conversationAtSubmit = current();
  const steeringTarget = draftMode(composerIntent, steerTarget(conversationAtSubmit)) === 'steer' ? composerIntent.turnId : null;
  const settings = { permissionPolicy:permissionControls?.value(), autoReview:opinionUI.automaticSetting(), model: $('#model').value, effort: $('#effort').value, sandbox: sandboxValue(), ...(providerId()==='cursor' ? {context:$('#context').value || null,fast:$('#fast').checked} : {}) };
  const settingsDraftKey = settingsKey(conversationAtSubmit);
  const handoff = switching(conversationAtSubmit) ? { provider: providerId(), handoffMode: $('#handoff-mode').value, sandbox: sandboxValue() } : {};
  const dualAtSubmit = dualUI?.record(conversationAtSubmit), dualPending = dualUI?.pendingFor();
  if (!steeringTarget && (dualAtSubmit || dualPending)) { await submitDual({ text, draftImages, imageDraftKey, importedContext, conversationAtSubmit, record: dualAtSubmit, pending: dualPending }); return; }
  sending = true;
  renderSend();
  renderSettings(current());
  try {
    let conversation = current();
    if (steeringTarget) {
      if(importedContext)throw new Error('A importação só pode seguir num pedido novo, depois de terminar o turno.');
      const result = await api(`/api/conversations/${conversationAtSubmit.id}/steer`, { text, requestId: crypto.randomUUID(), expectedTurnId: steeringTarget, mode:composerIntent.deliveryMode||chosenDelivery() });
      if (!result.accepted) throw new Error('Não foi possível guardar a mensagem. Nada foi reenviado.');
      if (selected === conversationAtSubmit.id && $('#prompt').value === text) { $('#prompt').value = ''; composerIntent = null; }
      return;
    }
    if (!conversation) {
      conversation = await api('/api/conversations',{provider:providerId(),cwd:await newConversationFolder(),...settings,sandbox:sandboxValue(),...(selectedProject?{projectId:selectedProject,revision:state.projectCatalog.revision}:{})});
      const createdIndex=state.conversations.findIndex(entry=>entry.id===conversation.id);
      if(createdIndex<0)state.conversations.unshift(conversation);else state.conversations[createdIndex]=conversation;
      saveComposerDraft();
      composerDrafts.move(imageDraftKey,draftKey(conversation,selectedProject));
      imageAttachments.move(imageDraftKey,draftKey(conversation,selectedProject));
      projectMemory.move(imageDraftKey,draftKey(conversation,selectedProject));
      opinionUI.moveAutomatic(imageDraftKey,draftKey(conversation,selectedProject));
      choose(conversation.id,selectedProject,false,true);
      composerDrafts.records.delete(imageDraftKey);
    }
    const attachments=await imageAttachments.upload(draftImages,conversation);
    const result = await api(`/api/conversations/${conversation.id}/send`,{text,requestId:crypto.randomUUID(),...settings,...handoff,...(attachments.length?{attachments}:{}),...(importedContext?{importId:importedContext.previewId}:{})});
    if (checkpointDrafts.has(imageDraftKey)) checkpointDrafts.delete(imageDraftKey);
    opinionUI.consumeAutomatic(imageDraftKey);
    opinionUI.consumeAutomatic(draftKey(conversation,selectedProject));
    imageAttachments.consume(draftImages);
    projectMemory.consume(draftKey(conversation,selectedProject),importedContext);
    settingDrafts.delete(settingsDraftKey);
    composerDrafts.clear(draftKey(conversation,selectedProject),text);
    if (selected === conversation.id && $('#prompt').value === text) { $('#prompt').value = ''; composerIntent = null; }
    if (result.conversationId && result.conversationId !== conversation.id) {
      switchTargets.delete(conversation.id);
      if (!state.conversations.some(entry => entry.id === result.conversationId)) accept(await api('/api/state'));
      choose(result.conversationId,selectedProject,false,true);
    }
  } catch (error) { if(error.code==='REVIEW_UNAVAILABLE'&&error.beforeSend)opinionUI.offerWithoutReview(error);else toast(error.message); }
  finally { sending = false; try { accept(await api('/api/state')); } catch { /* SSE reconnect handles transport loss; do not replay writes. */ } render(); }
});
$('#stop').addEventListener('click',async()=> {
  if (hydraOn()) { claudexUI.stop.click(); return; }
  $('#stop').disabled = true;
  try { const dual = dualUI?.record(current()); if (dual) await api(`/api/dual/${dual.id}/interrupt`,{}); else await api(`/api/conversations/${focusConversation()?.id || selected}/interrupt`,{}); }
  catch (error) { toast(error.message); }
  finally { $('#stop').disabled = false; }
});
$('#reconnect').addEventListener('click',async()=> {
  $('#reconnect').disabled = true;
  try { accept(await api('/api/connect',{provider:providerId()})); render(); }
  catch (error) { toast(error.message); }
  finally { $('#reconnect').disabled = false; }
});

function listen() {
  events?.close();
  events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener('state',event=> {
    recoveryDelay = 1000;
    accept(JSON.parse(event.data));
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
    const response = await fetch('/api/bootstrap', { headers: { 'X-HYDRAQ-Bootstrap': '1' } });
    if (!response.ok) throw new Error('Não foi possível abrir a sessão local.');
    const initial = await response.json();
    token = initial.token;
    state = initial.state;
    if(!recovering&&!current()&&selectedProject)selectedProvider=state.projectCatalog?.projects.find(p=>p.id===selectedProject)?.defaults?.provider||selectedProvider;
    if(!recovering){const draft=composerDrafts.get(composerKey());$('#prompt').value=draft.text;composerIntent=draft.intent;$('#cwd').value=conversationFolder(current())||project()?.root||draft.cwd||'';}
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

window.addEventListener('hydraq-draft-storage-error',()=>toast('Não foi possível guardar o rascunho neste navegador. Mantém esta página aberta.'));
window.addEventListener('pagehide',saveComposerDraft);
let loadedPageVersion=null;
async function showRuntimeVersion(){
 try { const response=await fetch('/health');if(!response.ok)return;const info=await response.json();
 loadedPageVersion??=info.pageVersion;
 let badge=document.querySelector('#runtime-version');if(!badge){badge=element('span','status-chip');badge.id='runtime-version';document.querySelector('.topbar-context').append(badge);}
 const reload=loadedPageVersion!==info.pageVersion;
 badge.textContent=!info.startedAt?'Servidor anterior · Reiniciar servidor':`v${info.version}${info.restartRequired?' · Reiniciar servidor':reload?' · Recarregar página':''}`;
 badge.title=`Servidor iniciado em ${info.startedAt||'data desconhecida'}${info.sourceVersion?' · Ficheiros: v'+info.sourceVersion:''}`;
 }catch{}
}
showRuntimeVersion();setInterval(showRuntimeVersion,60000);
