import { t as uiText } from './i18n.js';
// MCP form requests describe data, not a chat message or an executable action.
export function validateElicitation(schema, value, name = uiText('Resposta')) {
  const fail = message => { throw new Error(`${name}: ${message}`); };
  const type = schema?.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('preenche um objeto JSON.');
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) fail(`falta o campo «${key}».`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateElicitation(schema.properties[key], item, key);
      else if (schema.additionalProperties === false) fail(uiText`o campo «${key}» não é permitido.`);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) fail('preenche uma lista JSON.');
    if (schema.items) value.forEach((item, index) => validateElicitation(schema.items, item, `${name} ${index + 1}`));
  } else if (type && (type === 'integer' ? !Number.isInteger(value)
    : type === 'null' ? value !== null : typeof value !== type)) fail(`o valor deve ser do tipo ${type}.`);
  if (schema?.enum && !schema.enum.some(option => Object.is(option, value))) fail(uiText('escolhe uma das opções indicadas.'));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(uiText('introduz um número válido.'));
    if (schema.minimum !== undefined && value < schema.minimum) fail(uiText`o mínimo é ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(uiText`o máximo é ${schema.maximum}.`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`introduz pelo menos ${schema.minLength} caracteres.`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(uiText`introduz no máximo ${schema.maxLength} caracteres.`);
  }
  return value;
}

export function elicitationForm(schema, document = globalThis.document) {
  const node = (tag, text) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const container = node('div');
  const properties = Object.entries(schema?.properties || {});
  const simple = schema?.type === 'object' && properties.every(([, field]) =>
    ['string', 'boolean', 'number', 'integer'].includes(field.type) &&
    !['oneOf', 'anyOf', 'allOf', '$ref'].some(key => key in field)) &&
    !['oneOf', 'anyOf', 'allOf', '$ref'].some(key => key in schema) &&
    (schema.required || []).every(key => Object.hasOwn(schema.properties || {}, key));
  if (!schema || (simple && !properties.length)) {
    container.append(node('p', uiText('Este pedido requer apenas uma decisão. Para acrescentar instruções, usa a caixa de orientação da tarefa.')));
    return { container, read: () => ({}) };
  }
  if (!simple) {
    const label = node('label', 'Resposta estruturada (JSON)');
    const input = node('textarea');
    input.placeholder = 'Exemplo: {"campo": "valor"}';
    const details = node('details');
    details.append(node('summary', 'Ver formato pedido'), node('pre', JSON.stringify(schema, null, 2)));
    label.append(input); container.append(label, details);
    return { container, read: () => {
      let value;
      try { value = JSON.parse(input.value); }
      catch { throw new Error(uiText('A resposta exige JSON válido. O texto foi conservado; corrige o formato ou recusa o pedido.')); }
      return validateElicitation(schema, value);
    } };
  }
  const readers = [];
  for (const [key, field] of properties) {
    const required = schema.required?.includes(key);
    const label = node('label', `${field.title || key}${required ? uiText(' (obrigatório)') : ''}`);
    const options = field.enum || (field.type === 'boolean' ? [true, false] : null);
    const input = node(options ? 'select' : 'input');
    if (options) {
      const empty = node('option', 'Escolher…'); empty.value = ''; input.append(empty);
      options.forEach((value, index) => {
        const option = node('option', typeof value === 'boolean' ? (value ? uiText('Sim') : uiText('Não')) : String(value));
        option.value = String(index); input.append(option);
      });
      input.value = '';
    } else {
      input.type = ['number', 'integer'].includes(field.type) ? 'number' : 'text';
      if (input.type === 'number') input.step = field.type === 'integer' ? '1' : 'any';
    }
    input.required = Boolean(required);
    label.append(input);
    if (field.description) label.append(node('small', field.description));
    container.append(label);
    readers.push(() => {
      if (input.value === '') {
        if (required) throw new Error(`Preenche o campo «${field.title || key}».`);
        return [];
      }
      const value = options ? options[Number(input.value)] : field.type === 'string' ? input.value : Number(input.value);
      validateElicitation(field, value, field.title || key);
      return [[key, value]];
    });
  }
  return { container, read: () => validateElicitation(schema, Object.fromEntries(readers.flatMap(read => read()))) };
}
