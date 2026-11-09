import { locale as uiLocale } from './i18n.js';
import { t as uiText } from './i18n.js';
const saved=key=>{try{const v=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.startsWith('opencode/')).slice(0,50):[];}catch{return [];}};
export function filterModels(models,query='',favorites=[],recent=[]){
  const words=query.toLocaleLowerCase('pt').trim().split(/\s+/).filter(Boolean),rank=id=>favorites.includes(id)?0:recent.includes(id)?1:2;
  return models.filter(m=>m.providerID==='opencode'&&m.free===true&&words.every(w=>(m.name+' '+m.id).toLocaleLowerCase('pt').includes(w))).sort((a,b)=>rank(a.id)-rank(b.id)||a.name.localeCompare(b.name));
}
export class ModelPicker {
  constructor({select,getCatalog,refresh,toast}){
    Object.assign(this,{select,getCatalog,refresh,toast});this.favorites=saved('hydraq.opencode.favorites');this.recent=saved('hydraq.opencode.recent');
    this.trigger=document.createElement('button');this.trigger.type='button';this.trigger.className='model-picker-trigger pill-select';this.trigger.setAttribute('aria-haspopup','dialog');this.trigger.setAttribute('aria-label',uiText('Escolher modelo gratuito OpenCode'));this.trigger.dataset.tip=uiText('Pesquisar modelos gratuitos do fornecedor OpenCode, ver capacidades e verificar novidades.');select.after(this.trigger);
    this.dialog=document.createElement('dialog');this.dialog.className='model-picker project-dialog';this.dialog.id='opencode-model-picker';this.dialog.setAttribute('aria-label',uiText('Modelos OpenCode gratuitos'));this.trigger.setAttribute('aria-controls',this.dialog.id);
    const header=document.createElement('header'),title=document.createElement('h2');title.textContent=uiText('Modelos OpenCode');const close=document.createElement('button');close.type='button';close.textContent=uiText('Fechar');close.addEventListener('click',()=>this.dialog.close());header.append(title,close);
    const subtitle=document.createElement('p');subtitle.textContent=uiText('Só o fornecedor OpenCode · apenas preços confirmados a zero');
    this.search=document.createElement('input');this.search.type='search';this.search.placeholder=uiText('Pesquisar modelo…');this.search.setAttribute('aria-label',uiText('Pesquisar modelos OpenCode'));
    const toolbar=document.createElement('div');toolbar.className='model-picker-toolbar';this.status=document.createElement('p');this.status.setAttribute('role','status');this.check=document.createElement('button');this.check.type='button';this.check.textContent=uiText('↻ Verificar modelos');this.check.dataset.tip=uiText('Consulta o catálogo atual, sem inferência, sem mudar de modelo nem recarregar sessões.');toolbar.append(this.status,this.check);
    this.list=document.createElement('div');this.list.className='model-picker-list';this.list.setAttribute('aria-label',uiText('Modelos disponíveis'));
    this.dialog.append(header,subtitle,this.search,toolbar,this.list);document.body.append(this.dialog);
    this.trigger.addEventListener('click',()=>{this.search.value='';this.render();this.dialog.showModal();this.trigger.setAttribute('aria-expanded','true');this.search.focus();this.checkModels(false);});
    this.search.addEventListener('input',()=>this.renderList());this.search.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();this.list.querySelector('button')?.focus();}});
    this.check.addEventListener('click',()=>this.checkModels(true));this.dialog.addEventListener('close',()=>{this.trigger.setAttribute('aria-expanded','false');this.trigger.focus()});this.sync(false);
  }
  save(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}
  sync(enabled){this.enabled=enabled;this.select.hidden=enabled;this.trigger.hidden=!enabled;this.trigger.disabled=this.select.disabled;const label=this.select.selectedOptions[0]?.textContent||uiText('Escolher modelo');this.trigger.textContent=label+' ▾';this.trigger.setAttribute('aria-label',uiText('Modelo OpenCode: ')+label);this.trigger.dataset.tip=label+uiText(' · OpenCode gratuito. Clica para pesquisar, escolher favoritos ou verificar modelos.');if(this.dialog.open&&(!enabled||this.select.disabled))this.dialog.close();else if(this.dialog.open)this.render();}
  render(){const c=this.getCatalog()||{};this.status.textContent=c.error?uiText`Verificação falhou: ${c.error}${c.checkedAt?uiText(' · lista anterior conservada'):''}`:c.checkedAt?uiText`Verificado às ${new Date(c.checkedAt).toLocaleTimeString(uiLocale(),{hour:'2-digit',minute:'2-digit'})}`:uiText('Catálogo por verificar');this.renderList();}
  renderList(){
    this.list.replaceChildren();let last;
    for(const m of filterModels(this.getCatalog()?.models||[],this.search.value,this.favorites,this.recent)){
      const group=this.favorites.includes(m.id)?uiText('Favoritos'):this.recent.includes(m.id)?uiText('Recentes'):uiText('OpenCode · gratuitos');if(group!==last){const heading=document.createElement('h3');heading.textContent=group;this.list.append(heading);last=group;}
      const row=document.createElement('div');row.className='model-picker-row';const pick=document.createElement('button');pick.type='button';pick.className='model-picker-choice';pick.setAttribute('aria-pressed',String(this.select.value===m.id));const name=document.createElement('strong');name.textContent=m.name;const meta=document.createElement('small');meta.textContent=uiText`${m.id} · Grátis${m.images?uiText(' · Imagens'):''}${m.contextWindow?' · '+Math.round(m.contextWindow/1000)+'K':''}`;pick.append(name,meta);
      pick.addEventListener('click',()=>{this.select.value=m.id;this.recent=[m.id,...this.recent.filter(id=>id!==m.id)].slice(0,8);this.save('hydraq.opencode.recent',this.recent);this.select.dispatchEvent(new Event('change',{bubbles:true}));this.dialog.close();this.sync(true);});
      const star=document.createElement('button');star.type='button';star.textContent=this.favorites.includes(m.id)?'★':'☆';star.setAttribute('aria-label',uiText`Favorito: ${m.name}`);star.setAttribute('aria-pressed',String(this.favorites.includes(m.id)));star.addEventListener('click',()=>{this.favorites=this.favorites.includes(m.id)?this.favorites.filter(id=>id!==m.id):[...this.favorites,m.id];this.save('hydraq.opencode.favorites',this.favorites);this.renderList();this.search.focus();});row.append(pick,star);this.list.append(row);
    }
    if(!this.list.children.length){const empty=document.createElement('p');empty.textContent=uiText('Não há modelos gratuitos correspondentes. Verifica o catálogo ou altera a pesquisa.');this.list.append(empty);}
  }
  async checkModels(force){if(this.checking)return;this.checking=true;this.check.disabled=true;this.status.textContent=uiText('A verificar modelos…');try{await this.refresh(force);}catch(e){this.toast(e.message);}finally{this.checking=false;this.check.disabled=false;this.render();}}
}
