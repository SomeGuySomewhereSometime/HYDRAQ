import test from 'node:test';
import assert from 'node:assert/strict';
import { readLanguage, setupLanguage, t, translateStatic, LANGUAGE_KEY, locale } from '../public/i18n.js';

const storage = value => ({ getItem: () => value });
const root = children => ({ nodeType: 1, tagName: 'DIV', childNodes: children, hasAttribute: () => false });
const document = () => ({ documentElement: root([]), querySelector: () => null });

test('English is the default; Portuguese is explicit and invalid or blocked storage is safe', () => {
  assert.equal(LANGUAGE_KEY, 'hydraq.language');
  for (const value of [null, undefined, 'en', 'invalid', 'pt-PT']) assert.equal(readLanguage(storage(value)), 'en');
  assert.equal(readLanguage(storage('pt')), 'pt');
  assert.equal(readLanguage({ getItem() { throw Error('blocked'); } }), 'en');
});

test('interface translations preserve interpolated user data exactly', () => {
  setupLanguage(document(), storage('en'));
  assert.equal(locale(), 'en-GB');
  assert.equal(t('Guardar'), 'Save');
  const name = 'Guardar ${alert(1)} <script> {0}';
  assert.equal(t`Definições de ${name}`, 'Settings for ' + name);
  assert.equal(t('unknown native output'), 'unknown native output');
  assert.equal(t('constructor'), 'constructor');
  assert.equal(t('__proto__'), '__proto__');
  setupLanguage(document(), storage('pt'));
  assert.equal(locale(), 'pt-PT');
  assert.equal(t('Guardar'), 'Guardar');
  assert.equal(t`Definições de ${name}`, 'Definições de ' + name);
});

test('static markup translates labels and placeholders without touching input values', () => {
  setupLanguage(document(), storage('en'));
  const text = { nodeType: 3, data: '  Guardar  ' };
  const attributes = { placeholder: 'Colar chave API' };
  const input = { ...root([]), tagName: 'INPUT', value: 'Guardar', hasAttribute: name => name in attributes, getAttribute: name => attributes[name], setAttribute: (name, value) => { attributes[name] = value; } };
  const scriptText = { nodeType: 3, data: 'Guardar' };
  translateStatic(root([text, input, { ...root([scriptText]), tagName: 'SCRIPT' }]));
  assert.equal(text.data, '  Save  ');
  assert.equal(attributes.placeholder, 'Paste API key');
  assert.equal(input.value, 'Guardar');
  assert.equal(scriptText.data, 'Guardar');
});
