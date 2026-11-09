import { t as uiText } from './i18n.js';
const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt');
export function searchConversations(conversations,{query='',provider='',projectId='',since='',file=''}={}){
 const words=normalize(query).trim().split(/\s+/).filter(Boolean),results=[];
 for(const c of conversations){
  if(provider&&c.provider!==provider||projectId&&(c.organization?.projectId||'loose')!==projectId)continue;
  const files=(c.items||[]).filter(i=>/file|patch|change/.test(i.type||'')).map(i=>JSON.stringify(i)).join(' ');
  if(file&&!normalize(files).includes(normalize(file)))continue;
  for(const m of c.messages||[]){
   if(m.internal||typeof m.text!=='string'||!m.text.trim())continue;
   const date=m.createdAt||m.at||c.updatedAt||'';if(since&&date.slice(0,10)<since)continue;
   const body=normalize(m.text);if(!words.every(word=>body.includes(word)))continue;
   const at=Math.max(0,words.length?body.indexOf(words[0])-80:0);
   results.push({conversationId:c.id,title:c.organization?.title||c.title||uiText('Conversa'),provider:c.provider,date,excerpt:(at?'…':'')+m.text.slice(at,at+300)+(m.text.length>at+300?'…':'')});
  }
 }
 return results.sort((a,b)=>b.date.localeCompare(a.date));
}
