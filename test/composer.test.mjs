import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDraftIntent, draftMode } from '../public/composer.js';

const active = { id: 'chat', turnId: 'turn-1', status: 'running' };

test('orientação escrita durante execução continua ligada ao turno mesmo depois de terminar',()=> {
  const intent = captureDraftIntent(null, 'Nova orientação', active);
  assert.equal(draftMode(intent, active), 'steer');
  const completed = { ...active, turnId: null, status: 'completed' };
  assert.equal(draftMode(intent, completed), 'expired-steer');
  assert.deepEqual(captureDraftIntent(intent, 'Nova orientação editada', completed), intent);
  assert.equal(draftMode(intent, { ...active, turnId: 'turn-2' }), 'expired-steer');
  assert.equal(draftMode(intent, { ...active, id: 'other-chat' }), 'expired-steer');
});

test('rascunho normal não se transforma em orientação quando começa outro turno',()=> {
  const intent = captureDraftIntent(null, 'Pedido seguinte', { ...active, status: 'completed' });
  assert.equal(draftMode(captureDraftIntent(intent, 'Pedido editado', active), active), 'send');
  assert.equal(draftMode(null, { ...active, status: 'waiting' }), 'steer');
  assert.equal(draftMode(null, { ...active, status: 'starting' }), 'send');
});

test('limpar ou converter explicitamente o rascunho permite um novo pedido',()=> {
  const intent = captureDraftIntent(null, 'Orientação', active);
  const completed = { ...active, turnId: null, status: 'completed' };
  assert.equal(captureDraftIntent(intent, '  ', completed), null);
  assert.equal(draftMode({ kind: 'send' }, completed), 'send');
  assert.equal(draftMode(captureDraftIntent(null, 'Novo pedido', completed), completed), 'send');
});
