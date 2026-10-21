import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const cursorCredentialVariables = ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT'];
export function withoutCursorCredentials(env = process.env) {
  const clean = { ...env };
  for (const key of cursorCredentialVariables) delete clean[key];
  return clean;
}
export const cursorCredentialPath = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'hydraq', 'cursor.env');

/** A literal single assignment; no shell, substitutions, or global environment writes. */
export async function readCursorCredential(filename = cursorCredentialPath()) {
  let directory, file;
  try {
    directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const folder = await directory.stat();
    if (!folder.isDirectory() || folder.uid !== process.getuid() || (folder.mode & 0o777) !== 0o700)
      throw new Error('A pasta privada tem de pertencer ao teu utilizador e ter permissões 700.');
    // Bind the file lookup to the opened directory, including across rename/symlink races.
    file = await open(`/proc/self/fd/${directory.fd}/${path.basename(filename)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1)
      throw new Error('O ficheiro privado tem de ser regular, pertencer ao teu utilizador e ter permissões 600.');
    if (!info.size || info.size > 16_384) throw new Error('O ficheiro da chave está vazio ou tem um tamanho inválido.');
    const text = await file.readFile('utf8');
    const match = /^CURSOR_API_KEY=([^\r\n\s'"\x00]+)\r?\n?$/.exec(text);
    if (!match) throw new Error('Usa uma única linha CURSOR_API_KEY=valor, sem aspas, export ou outras variáveis.');
    return match[1];
  } catch (error) {
    const reason = error.code === 'ENOENT' ? `Falta o ficheiro privado ${filename}.`
      : ['ELOOP', 'ENOTDIR'].includes(error.code) ? 'A pasta e o ficheiro da chave não podem ser ligações simbólicas.'
      : error.code ? 'Não foi possível ler o ficheiro privado da chave; verifica o acesso e as permissões.' : error.message;
    throw new Error(`Cursor precisa de configuração. ${reason}`);
  } finally { await file?.close(); await directory?.close(); }
}
