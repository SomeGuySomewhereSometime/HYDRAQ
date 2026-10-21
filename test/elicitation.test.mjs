import test from 'node:test';
import assert from 'node:assert/strict';
import { elicitationForm } from '../public/elicitation.js';

// Small DOM stand-in: exercise the same controls and readers used by the page.
const document = { createElement: tag => ({ tag, children: [], value: '', append(...children) { this.children.push(...children); } }) };
const inputs = container => container.children.flatMap(child => [child, ...inputs(child)]).filter(child => ['input', 'select', 'textarea'].includes(child.tag));

test('autorização MCP com esquema vazio confirma sem JSON nem caixa de texto', () => {
  for (const schema of [undefined, { type: 'object', properties: {} }, { type: 'object', properties: {}, additionalProperties: false }]) {
    const form = elicitationForm(schema, document);
    assert.equal(inputs(form.container).length, 0);
    assert.deepEqual(form.read(), {});
  }
});

test('formulário MCP converte texto, opções, números e booleanos sem pedir JSON', () => {
  const form = elicitationForm({ type: 'object', required: ['text', 'enabled', 'count'], properties: {
    text: { type: 'string', title: 'Mensagem' }, enabled: { type: 'boolean' }, count: { type: 'integer', minimum: 1 },
    mode: { type: 'string', enum: ['once', 'always'] }, optional: { type: 'string' },
  } }, document);
  const [text, enabled, count, mode] = inputs(form.container);
  assert.throws(form.read, /Mensagem/);
  text.value = 'confirmo, com esta orientação';
  assert.throws(form.read, /enabled/); // An unselected boolean must not silently become false.
  enabled.value = '1'; count.value = '2.5';
  assert.throws(form.read, /integer/);
  count.value = '0'; assert.throws(form.read, /mínimo/);
  count.value = '2'; mode.value = '0';
  assert.deepEqual(form.read(), { text: 'confirmo, com esta orientação', enabled: false, count: 2, mode: 'once' });
  assert.equal(text.value, 'confirmo, com esta orientação');
});

test('respostas estruturadas inválidas conservam o texto e permitem corrigir antes de enviar', () => {
  const form = elicitationForm({ type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } } }, document);
  const [input] = inputs(form.container);
  input.value = 'confirmo';
  assert.throws(form.read, /JSON válido/);
  assert.equal(input.value, 'confirmo');
  input.value = '[]'; assert.throws(form.read, /objeto/);
  input.value = '{}'; assert.throws(form.read, /data/);
  input.value = '{"data":{"count":"2"}}'; assert.throws(form.read, /integer/);
  input.value = '{"data":{"count":2}}'; assert.deepEqual(form.read(), { data: { count: 2 } });
});

test('campos especiais conservam o nome sem alterar o protótipo da resposta', () => {
  const form = elicitationForm(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'), document);
  inputs(form.container)[0].value = 'texto';
  const result = form.read();
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, 'texto');
});
