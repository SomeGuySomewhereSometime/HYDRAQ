import {spawnSync} from 'node:child_process';

// Inside a Hydra test sandbox bubblewrap cannot start another one. Tests that need it are skipped there with this reason,
// which the suite reports: a skipped test has not been validated. Run them outside to validate them.
const probe=spawnSync('bwrap',['--ro-bind','/','/','--dev','/dev','--proc','/proc','/bin/true'],{encoding:'utf8'});
export const noBwrap=probe.status===0?false:'exige bubblewrap, indisponível neste ambiente: '+String(probe.stderr||probe.error?.message||'').trim().slice(0,120);
