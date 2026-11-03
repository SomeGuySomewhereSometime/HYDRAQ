// Read-only native catalog/quota trial. No model turns; no production HYDRAQ state.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Providers } from '../lib/providers.mjs';
import { Hydraq } from '../lib/hydraq.mjs';
import { ClaudeCode } from '../lib/claude.mjs';
import { Antigravity } from '../lib/antigravity.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'hydraq-native-catalogs-'));
const out = path.resolve(process.argv[2] || '/tmp/hydraq-native-catalogs-result'); await mkdir(out, { recursive: true });
const defaultCwd = process.cwd(), clients = {
  codex: new Hydraq({ dataDir: path.join(root, 'codex'), defaultCwd }),
  claude: new ClaudeCode({ dataDir: path.join(root, 'claude'), defaultCwd }),
  antigravity: new Antigravity({ dataDir: path.join(root, 'agy'), defaultCwd }),
};
const hub = new Providers({ dataDir: path.join(root, 'hub'), defaultCwd, clients, git: async () => [] });
const result = {};
try {
  await hub.load(); const connected = await hub.connectAll();
  const snapshot = hub.snapshot();
  for (const [i, [id, client]] of Object.entries(clients).entries()) {
    const provider = snapshot.providers[id];
    result[id] = { connected: connected[i].status === 'fulfilled', connection: provider.connection,
      models: provider.models.map(m => ({ id: m.id, name: m.name, efforts: m.efforts, contextWindow: m.contextWindow, inputModalities: m.inputModalities })),
      catalog: provider.catalog, quotas: provider.quotas, conversations: client.conversations.length };
    console.log(id, JSON.stringify({ connected: result[id].connected, models: provider.models.length, terra: provider.models.find(m => m.id === 'gpt-6.1-terra')?.efforts,
      quotaStatus: provider.quotas.status, windows: provider.quotas.windows.map(w => ({ group: w.group, label: w.label, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt })), conversations: client.conversations.length }));
  }
  if (Object.values(result).some(r => !r.connected || r.quotas.status !== 'ready' || r.conversations !== 0) || !result.codex.models.some(m => m.id === 'gpt-6.1-terra')) process.exitCode = 1;
} finally { await hub.close(); await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); await rm(root, { recursive: true, force: true }); }
