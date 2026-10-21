import { constants } from 'node:fs';
import { mkdir, open, writeFile, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGES = 4;
export const MAX_DELIVERY_IMAGES = 16;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Cada imagem deve ter até 5 MB.');
  let mimeType, extension, width, height;
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') {
    mimeType = 'image/png'; extension = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length > 10 && bytes[0] === 255 && bytes[1] === 216) {
    mimeType = 'image/jpeg'; extension = 'jpg';
    let at = 2;
    while (at + 4 < bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const size = bytes.readUInt16BE(at);
      if (size < 2 || at + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
        height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break;
      }
      at += size;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    mimeType = 'image/webp'; extension = 'webp';
    const kind = bytes.toString('ascii',12,16);
    if (kind === 'VP8X') {
      if (bytes[20] & 2) throw new Error('Usa uma imagem estática; WebP animado não é suportado.');
      width = bytes.readUIntLE(24,3) + 1; height = bytes.readUIntLE(27,3) + 1;
    } else if (kind === 'VP8 ' && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) {
      width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383;
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
    }
  }
  if (!mimeType || !width || !height) throw new Error('Imagem inválida. Usa PNG, JPEG ou WebP estático.');
  if (width > 8192 || height > 8192 || width * height > 20_000_000) throw new Error('A imagem excede 8192 px por lado ou 20 megapíxeis.');
  return { mimeType, extension, width, height, size: bytes.length, sha256: hash(bytes) };
}

async function readPrivate(file, max) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('Anexo inválido ou demasiado grande.');
    return await handle.readFile();
  } finally { await handle.close(); }
}

export class AttachmentStore {
  constructor(directory) { this.directory = directory; }
  async folder(group, create = false) {
    if (typeof group !== 'string' || !group || group.length > 100) throw new Error('Grupo de anexos inválido.');
    const folder = path.join(this.directory, hash(group));
    if (create) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if((await lstat(this.directory)).isSymbolicLink())throw new Error('A pasta de anexos não pode ser um symlink.');
      await mkdir(folder, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    }
    for (const entry of [this.directory, folder]) if ((await lstat(entry)).isSymbolicLink()) throw new Error('A pasta de anexos não pode ser um symlink.');
    return folder;
  }
  async put(group, bytes, name, declaredType) {
    const info = inspectImage(bytes);
    if (declaredType?.split(';')[0] !== info.mimeType) throw new Error('O tipo indicado não corresponde ao conteúdo da imagem.');
    const folder = await this.folder(group, true), id = randomUUID();
    const meta = { id, group, name: path.basename(String(name || 'imagem')).replace(/[\x00-\x1f\x7f]/g,'').slice(0,160) || 'imagem', ...info,
      url: `/api/attachments/${encodeURIComponent(group)}/${id}` };
    await writeFile(path.join(folder, `${id}.${info.extension}`), bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(folder, `${id}.json`), JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
    return meta;
  }
  async get(group, id) {
    if (!validId(id)) throw new Error('Identificador de imagem inválido.');
    const folder = await this.folder(group);
    const meta = JSON.parse((await readPrivate(path.join(folder, `${id}.json`), 4096)).toString());
    if (meta.id !== id || meta.group !== group || !['png','jpg','webp'].includes(meta.extension)) throw new Error('Metadados de imagem inválidos.');
    const file = path.join(folder, `${id}.${meta.extension}`), bytes = await readPrivate(file, MAX_IMAGE_BYTES);
    const actual = inspectImage(bytes);
    if (actual.sha256 !== meta.sha256 || actual.mimeType !== meta.mimeType || actual.extension !== meta.extension) throw new Error('A imagem foi alterada no disco. Nada foi enviado.');
    return { ...meta, ...actual, url:`/api/attachments/${encodeURIComponent(group)}/${id}`, path: file, bytes };
  }
  async resolve(group, ids = [], limit = MAX_DELIVERY_IMAGES) {
    if (!Array.isArray(ids) || ids.length > limit || ids.some(id => !validId(id))) throw new Error(`Escolhe até ${limit} imagens válidas.`);
    const images = await Promise.all([...new Set(ids)].map(id => this.get(group, id)));
    if (images.reduce((total, image) => total + image.size, 0) > 20 * 1024 * 1024) throw new Error('As imagens desta entrega excedem 20 MB. Usa uma conversa com menos imagens.');
    return images;
  }
}

export const imageRecords = images => (images || []).map(({ bytes, path: file, ...meta }) => meta);
export const messageImages = settings => settings.ownImages ?? settings.images ?? [];
export function imageContent(images, format) {
  return (images || []).map(image => format === 'codex' ? { type: 'localImage', path: image.path }
    : format === 'claude' ? { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.bytes.toString('base64') } }
    : { type: 'image', mimeType: image.mimeType, data: image.bytes.toString('base64') });
}
export function imageText(text, images) {
  if (!images?.length) return text;
  return `${text}\n\n[Imagens anexadas pelo utilizador. Abre e inspeciona visualmente cada imagem com a ferramenta nativa de leitura de imagens (read_file/view_file) antes de responder. Se não conseguires abrir alguma, informa o utilizador; não afirmes que a viste.]\n${images.map((image,index) => `Imagem ${index + 1}: ${JSON.stringify(image.path)} (${image.mimeType})`).join('\n')}`;
}
