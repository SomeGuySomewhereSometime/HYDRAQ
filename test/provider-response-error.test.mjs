import test from 'node:test';
import assert from 'node:assert/strict';
import {providerResponseError,opinionResultError} from '../lib/provider-response-error.mjs';

test('aviso de pagamento isolado do Cursor não é uma resposta válida',()=>{
  assert.match(providerResponseError('cursor','\n\nAdd a payment method to continue'),/não respondeu/);
  assert.match(providerResponseError('cursor','Usage limit exceeded'),/limite/);
  assert.equal(providerResponseError('cursor','A interface mostrou “Add a payment method to continue”. É preciso corrigir esse aviso.'),null);
  assert.equal(providerResponseError('claude','Add a payment method to continue'),null);
});
test('parecer vazio é falhado apenas depois da conclusão nativa',()=>{
  assert.match(opinionResultError({status:'completed',text:'  '}),/sem uma resposta/);
  assert.equal(opinionResultError({status:'running',text:''}),null);
  assert.equal(opinionResultError({status:'completed',text:'Sem críticas relevantes.'}),null);
});
