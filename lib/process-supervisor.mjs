import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const valid = /^hydraq-col-(principal|worker)-[a-f0-9-]{36}\.scope$/;

/** Transient user scopes contain commands even when a native CLI dies first. No shell or global config. */
export class ProcessSupervisor {
  async available() {
    try {
      if (process.platform !== 'linux') throw Error('É necessário Linux com systemd de utilizador.');
      await access('/usr/bin/systemd-run');
      await exec('/usr/bin/systemctl', ['--user', 'show', '--property=Version', '--value'], { timeout: 4000 });
      return { available: true };
    } catch {
      return { available: false, reason: 'A supervisão systemd do utilizador não está disponível. As conversas normais continuam disponíveis.' };
    }
  }
  wrap(executable, args, unit, seconds) {
    if (!valid.test(unit) || !Number.isInteger(seconds) || seconds < 10 || seconds > 7200) throw Error('Supervisão inválida.');
    return { executable: '/usr/bin/systemd-run', args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, `--property=RuntimeMaxSec=${seconds}s`, '--property=TimeoutStopSec=3s', executable, ...args] };
  }
  async stop(unit) {
    if (!unit) return;
    if (!valid.test(unit)) throw Error('Grupo de processos inválido; nada foi encerrado.');
    const show = () => exec('/usr/bin/systemctl', ['--user', 'show', unit, '--property=LoadState', '--property=ActiveState'], { timeout: 4000 });
    const first = await show();
    if (/LoadState=not-found/.test(first.stdout)) return;
    await exec('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 7000 });
    const final = await show();
    if (!/ActiveState=(inactive|failed)/.test(final.stdout) && !/LoadState=not-found/.test(final.stdout)) throw Error('Não foi confirmado o fim dos processos delegados.');
  }
}
