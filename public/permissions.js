import { t as uiText } from './i18n.js';
import { translateStatic } from './i18n.js';
const names={'read-only':uiText('Só leitura'),project:uiText('Projeto confinado'),native:uiText('Nativo')};
export function policyLabel(policy) {
  if(!policy)return '';
  return names[policy.profile]+(policy.profile==='native'?'':(policy.network?uiText(' + rede'):uiText(' · sem rede'))+(policy.externalMcp?uiText(' + MCP externos'):uiText(' · sem MCP externos')));
}
export function effectivePolicy(provider,policy,mixed=false) {
  if(!policy||policy.profile==='native')return {policy,supported:true};
  if(['codex','claude','antigravity'].includes(provider))return {policy,supported:true};
  return {policy:mixed?{...policy,profile:'native'}:policy,supported:false};
}
export class PermissionControls {
  constructor({host,state,key,changed,plan}) {
    Object.assign(this,{host,state,key,changed,plan});
    this.records=new Map();
    try{this.records=new Map(JSON.parse(localStorage.getItem('hydraq.permission-drafts')||'[]'));}catch{}
    host.innerHTML='<label>Perfil de permissões<select data-profile><option value="native">Nativo</option><option value="read-only">Só leitura</option><option value="project">Projeto confinado</option></select></label><div class="permission-switches"><label><input type="checkbox" data-network>Rede dos comandos e pesquisa</label><label><input type="checkbox" data-mcp>MCP externos</label></div><label data-round-label>Ronda Multi<select data-round><option value="strict">Estrita</option><option value="mixed">Mista</option></select></label><p data-note></p><p data-last aria-live="polite"></p><details data-validation><summary>Validação dos perfis</summary><p>Os ensaios listados usam rede e MCP externos desligados. Os percursos por verificar continuam identificados.</p><table><thead><tr><th>Cliente</th><th>Percurso</th><th>Perfil</th><th>Teste real</th></tr></thead><tbody></tbody></table></details>';
    translateStatic(host);
    this.profile=host.querySelector('[data-profile]');
    this.network=host.querySelector('[data-network]');
    this.mcp=host.querySelector('[data-mcp]');
    this.round=host.querySelector('[data-round]');
    host.addEventListener('change',()=>{
      this.records.set(this.key(),{profile:this.profile.value,network:this.network.checked,externalMcp:this.mcp.checked,round:this.round.value});
      localStorage.setItem('hydraq.permission-drafts',JSON.stringify([...this.records].slice(-200)));
      this.changed();
    });
  }
  value() {
    if(!this.state()?.permissions)return undefined;
    if(this.fixedPolicy)return {...this.fixedPolicy};
    const saved=this.records.get(this.key())||{profile:'native',network:false,externalMcp:false,round:'strict'};
    return {profile:saved.profile,network:saved.network,externalMcp:saved.externalMcp,plan:this.plan()};
  }
  roundMode(){return this.records.get(this.key())?.round||'strict';}
  render({multi=false,lastTurn=null,busy=false,fixedPolicy=null,providers=[]}={}) {
    this.fixedPolicy=fixedPolicy;busy=busy||Boolean(fixedPolicy);
    const policy=this.value();
    this.host.hidden=!policy;
    if(!policy)return;
    this.profile.value=policy.profile;this.network.checked=policy.network;this.mcp.checked=policy.externalMcp;
    this.round.value=this.roundMode();
    this.profile.disabled=busy;this.round.disabled=busy;
    this.network.disabled=this.mcp.disabled=busy||policy.profile==='native';
    this.host.querySelector('[data-round-label]').hidden=!multi;
    this.host.querySelector('[data-note]').textContent=policy.profile==='native'
      ? uiText('As permissões de rede e ferramentas são geridas pelo cliente. Planear pode ser escolhido no compositor.')
      : policy.externalMcp?uiText('Os MCP externos podem atuar fora do projeto. No Hydra, escolhe também os servidores e os participantes autorizados na configuração da tarefa.')
      : uiText('Planear é independente do perfil. Cada turno protegido é auditado ao terminar.');
    const body=this.host.querySelector('tbody');
    const routes={normal:uiText('Envio'),multi:'Multi',hydra:'Hydra',delegation:uiText('Delegação'),resume:uiText('Retoma'),switch:uiText('Troca'),restart:uiText('Após reinício')};
    const rows=providers.flatMap(provider=>(this.state()?.permissions.clients[provider]?.validation||[]).map(result=>[provider,routes[result.route],names[result.profile],result.status==='tested'&&!policy.network&&!policy.externalMcp?uiText('Passou neste ensaio'):uiText('Por verificar')]));
    const signature=JSON.stringify(rows);
    if(body.dataset.signature!==signature){
      body.dataset.signature=signature;
      body.replaceChildren(...rows.map(row=>{
        const tr=document.createElement('tr');
        for(const value of row){const td=document.createElement('td');td.textContent=value;tr.append(td);}
        return tr;
      }));
    }
    const previous=lastTurn?.permissionPolicy;
    this.host.querySelector('[data-last]').textContent=previous
      ? uiText('Último pedido · ')+policyLabel(previous)+(lastTurn.permissionAudit?' · '+({pending:uiText('auditoria pendente'),passed:uiText('auditoria concluída'),violation:uiText('alterações fora do perfil'),incomplete:uiText('auditoria incompleta'),failed:uiText('falha de auditoria'),interrupted:uiText('auditoria interrompida')}[lastTurn.permissionAudit.status]||lastTurn.permissionAudit.status):''):'';
  }
}
