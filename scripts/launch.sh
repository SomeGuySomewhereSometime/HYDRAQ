#!/usr/bin/env bash
set -euo pipefail
# The private Cursor key is read only by its adapter, never inherited by the server.
unset CURSOR_API_KEY CURSOR_AUTH_TOKEN CURSOR_API_ENDPOINT
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_port="${HYDRAQ_PORT:-4318}"
task_url="http://127.0.0.1:${task_port}"
task_node="$(command -v node || true)"
if [[ -z "$task_node" && -x "$HOME/.hermes/node/bin/node" ]]; then
  task_node="$HOME/.hermes/node/bin/node"
fi
if [[ -z "$task_node" ]]; then
  printf 'É necessário Node.js 22 ou superior para iniciar o HYDRAQ.\n' >&2
  exit 1
fi
if [[ -z "${HYDRAQ_CODEX_BIN:-}" && -x "$HOME/.local/bin/codex" ]]; then
  export HYDRAQ_CODEX_BIN="$HOME/.local/bin/codex"
fi
if [[ -z "${HYDRAQ_AGY_BIN:-}" && -x "$HOME/.local/bin/agy" ]]; then
  export HYDRAQ_AGY_BIN="$HOME/.local/bin/agy"
fi
if [[ -z "${HYDRAQ_CLAUDE_BIN:-}" && -x "$HOME/.local/bin/claude" ]]; then
  export HYDRAQ_CLAUDE_BIN="$HOME/.local/bin/claude"
fi
if [[ -z "${HYDRAQ_CURSOR_BIN:-}" && -x "$HOME/.local/bin/cursor-agent" ]]; then
  export HYDRAQ_CURSOR_BIN="$HOME/.local/bin/cursor-agent"
fi
mkdir -p "$task_root/.hydraq"
chmod 700 "$task_root/.hydraq"
if ! curl --fail --silent --max-time 2 "$task_url/health" | "$task_node" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).app==="HYDRAQ"?0:1)}catch{process.exit(1)}})'; then
  if command -v setsid > /dev/null; then
    nohup setsid --fork "$task_node" "$task_root/server.mjs" >> "$task_root/.hydraq/server.log" 2>&1 < /dev/null &
  else
    nohup "$task_node" "$task_root/server.mjs" >> "$task_root/.hydraq/server.log" 2>&1 < /dev/null &
  fi
  task_ready=false
  for task_attempt in {1..40}; do
    if curl --fail --silent --max-time 1 "$task_url/health" | "$task_node" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).app==="HYDRAQ"?0:1)}catch{process.exit(1)}})'; then task_ready=true; break; fi
    sleep 0.25
  done
  if [[ "$task_ready" != true ]]; then
    printf 'Não foi possível iniciar o HYDRAQ. Consulta %s\n' "$task_root/.hydraq/server.log" >&2
    exit 1
  fi
fi
xdg-open "$task_url" >/dev/null 2>&1 || printf 'Abre %s no browser.\n' "$task_url"
