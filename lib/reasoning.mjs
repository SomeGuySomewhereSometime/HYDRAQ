import { readFile } from 'node:fs/promises';

export const CACHE_DOCS = 'https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation';

/** Read only capability fields, never prompts or authentication, from Codex's own catalog. */
export async function readReasoningCapabilities(file, clientVersion, clock = Date.now()) {
  const unknown = { models: new Map(), fetchedAt: null, verified: false };
  try {
    const cache = JSON.parse(await readFile(file, 'utf8'));
    const age = clock - Date.parse(cache.fetched_at);
    if (!clientVersion || cache.client_version !== clientVersion || !Number.isFinite(age) || age < -300_000 || age > 24 * 60 * 60 * 1000 || !Array.isArray(cache.models)) return unknown;
    return {
      fetchedAt: cache.fetched_at, verified: true,
      models: new Map(cache.models.filter(model => typeof model.slug === 'string').map(model => [model.slug,
        typeof model.supports_reasoning_effort_updates === 'boolean' ? model.supports_reasoning_effort_updates : null,
      ])),
    };
  } catch { return unknown; }
}

export const ZERO_USAGE = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

/** `last` describes an inference call, not necessarily a whole user turn. */
export function turnUsage(total, baseline) {
  if (!total || !baseline) return null;
  const delta = {};
  for (const field of Object.keys(ZERO_USAGE)) {
    const value = total[field] ?? (field === 'cacheWriteInputTokens' ? 0 : undefined);
    const before = baseline[field] ?? (field === 'cacheWriteInputTokens' ? 0 : undefined);
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(before) || value < before) return null;
    delta[field] = value - before;
  }
  if (delta.cachedInputTokens > delta.inputTokens) return null;
  return {
    ...delta,
    uncachedInputTokens: delta.inputTokens - delta.cachedInputTokens,
    cachePercent: delta.inputTokens ? Math.round(delta.cachedInputTokens / delta.inputTokens * 100) : 0,
  };
}
