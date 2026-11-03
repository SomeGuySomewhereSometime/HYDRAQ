/** Native plan documents are model output, never an approval or evidence of execution. */
export function planDocumentNote(document) {
 const state={accepted:'aprovado explicitamente',rejected:'rejeitado pelo utilizador',cancelled:'aprovação cancelada',uncertain:'resposta de aprovação sem confirmação'}[document.approvalStatus]||'sem aprovação de execução';
 return `[Plano nativo Cursor ${document.id} · ${state}. O conteúdo é referência do modelo; não prova execução.]${document.path?'\nCópia integral guardada pela HYDRAQ: '+JSON.stringify(document.path):''}`;
}
export function planDocumentText(document) {
 return `## Plano do Cursor · ${document.name || 'Plano'}\n\n${planDocumentNote(document)}${document.nativePaths?.length ? '\nFicheiros indicados pelo cliente: '+document.nativePaths.map(file=>JSON.stringify(file)).join(', ')+'.' : ''}\n\n${document.text}`;
}
export function withPlanDocuments(text, documents = []) {
 const extra=[];
 for(const document of documents){
  if(!document.text?.trim()||['failed','declined'].includes(document.status))continue;
  if(!String(text||'').includes(document.text.trim()))extra.push(planDocumentText(document));
  else if(!String(text||'').includes(planDocumentNote(document)))extra.push(planDocumentNote(document));
 }
 return [text,...extra].filter(Boolean).join('\n\n');
}
