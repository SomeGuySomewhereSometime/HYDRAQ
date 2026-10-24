"""Interactive Claude Code TUI started with the exact command HYDRAQ shows, against an isolated HYDRAQ.

full (default permission mode): memory tool without an approval prompt, HYDRAQ stopped (clear error),
HYDRAQ restarted with a new marker (same helper recovers), /exit and return with history and reads.
plan: one memory read in plan mode, /exit and return.
Makes a few small real requests (Haiku) with a temporary copy of the Claude credential, removed at the end.
"""
import atexit, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time
import pexpect

scenario = sys.argv[1] if len(sys.argv) > 1 else 'full'
root = pathlib.Path(__file__).resolve().parent.parent
directory = pathlib.Path(tempfile.mkdtemp(prefix='hydraq-claude-tui-'))
home = directory / 'claude-home'
home.mkdir(mode=0o700)
credential = home / '.credentials.json'
atexit.register(lambda: credential.unlink(missing_ok=True))
shutil.copyfile(pathlib.Path.home() / '.claude/.credentials.json', credential)
credential.chmod(0o600)
# A refresh inside the copy could rotate the person's own token: only run with a comfortably valid one.
if not json.loads(credential.read_text()).get('claudeAiOauth', {}).get('expiresAt', 0) > (time.time() + 1800) * 1000:
    sys.exit('O token Claude expira em menos de 30 minutos; tenta depois de o renovar no cliente normal.')
# Test profile only: skip the first-run theme wizard. The folder trust dialog is still answered below.
(home / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True, 'theme': 'dark'}))
# Like a terminal opened by the person: no identity of the Claude session that may be running this check
# (HYDRAQ strips the same variables from its own processes; with them the TUI does not save its turns).
inherited = {'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'}
env = {key: value for key, value in os.environ.items() if key not in inherited}
env.update(CLAUDE_CONFIG_DIR=str(home), TERM='xterm-256color')
mode = 'plan' if scenario == 'plan' else 'workspace-write'
result = dict(scenario=scenario, mode=mode, directory=str(directory), steps=[])
log = open(directory / 'tui.log', 'w', encoding='utf-8')

def controller(marker):
    process = subprocess.Popen(['node', str(root / 'validation/claude-terminal-interactive.mjs'), str(directory), mode, marker],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    return process, event(process, ('ready', 'error'), 180)

def event(process, names, timeout):
    end = time.time() + timeout
    while time.time() < end:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError('Controlador terminou sem resposta.')
        value = json.loads(line)
        if value.get('event') in names:
            if value['event'] == 'error':
                raise RuntimeError(value['message'])
            return value
    raise RuntimeError('Controlador sem resposta a tempo.')

screen = ''
def pump(seconds, child):
    global screen
    end = time.time() + seconds
    while time.time() < end:
        try:
            chunk = child.read_nonblocking(65536, timeout=.2)
            log.write(chunk)
            screen += chunk
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            break
    return flat(screen)

def flat(text):
    # The TUI repaints with cursor moves: compare without escapes and without whitespace.
    return re.sub(r'\s+', '', re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[=>78]', '', text))

def settle(child, quiet=4, limit=90):
    """Waits until the TUI stops repainting (no spinner), so the next request is not typed mid-turn."""
    end, last = time.time() + limit, len(screen)
    calm = 0
    while time.time() < end and calm < quiet:
        pump(1, child)
        calm = calm + 1 if len(screen) == last else 0
        last = len(screen)

def ask(child, text, expect, timeout=150):
    """Types a request and waits for one of the expected markers or an approval prompt."""
    global screen
    screen = ''
    for char in text:
        child.send(char)
        time.sleep(.02)
    time.sleep(.6)
    child.send('\r')
    end = time.time() + timeout
    while time.time() < end:
        seen = pump(1, child)
        if re.search(r'Doyouwanttoproceed\?|don\'taskagainfor|Yes,anddon', seen):
            child.send('\x1b')  # Refuse: the test requires no approval prompt.
            return dict(request=text, prompt=True, matched=None)
        for pattern in expect:
            # Patterns never occur in the typed request, so its echo cannot satisfy them.
            found = re.search(pattern, seen)
            if found:
                settle(child)
                return dict(request=text, prompt=False, matched=found.group(0))
        if not child.isalive():
            break
    return dict(request=text, prompt=False, matched=None, tail=flat(screen)[-600:])

hydraq = child = None
try:
    hydraq, ready = controller('TUI_MEMORY_BEFORE_5208')
    result['ready'] = {k: ready[k] for k in ('run', 'sessionId', 'server', 'seed')}
    command = ready['command']
    result['command'] = dict(allowedTools='--allowedTools' in command, mcpConfig='--mcp-config' in command, credentialInCommand='token' in command)
    child = pexpect.spawn('bash', ['-c', command], env=env, encoding='utf-8', dimensions=(50, 160), cwd=str(directory / 'project'))
    end = time.time() + 30
    while time.time() < end and 'Yes,Itrustthisfolder' not in pump(1, child) and child.isalive():
        pass
    # The dialog preselects «No, exit» and may repaint once (resetting the choice): wait until it is
    # stable, then confirm only when the latest repaint shows «Yes, I trust this folder» selected.
    settle(child, quiet=2, limit=20)
    for attempt in range(4):
        seen = flat(screen)
        if seen.rfind('❯Yes,Itrustthisfolder') > seen.rfind('❯No,exit'):
            break
        child.send('\x1b[B'); pump(1.5, child)
    else:
        raise RuntimeError('Diálogo de confiança na pasta não encontrado ou opção inesperada.')
    child.send('\r')
    end = time.time() + 40
    while time.time() < end and child.isalive() and not re.search(r'forshortcuts|shortcuts', flat(screen)[-2000:]):
        pump(1, child)
    if not child.isalive():
        raise RuntimeError('O Claude original terminou no arranque.')
    settle(child)
    result['startupTail'] = flat(screen)[-300:]
    result['transcriptSavingOff'] = 'Transcriptsavingisoff' in flat(screen)
    if scenario == 'plan':
        result['steps'].append(ask(child, 'Usa a ferramenta get_project_memory do servidor MCP hydraq e responde apenas com o marcador que lá encontrares. Não uses outras ferramentas.', [r'TUI_MEMORY_BEFORE_5208']))
    else:
        result['steps'].append(ask(child, 'Usa a ferramenta list_project_conversations do servidor MCP hydraq e responde apenas com a palavra CONTAGEM, dois pontos e o número de conversas devolvidas. Não uses outras ferramentas.', [r'CONTAGEM:\d+']))
        hydraq.send_signal(15); hydraq.wait(30)
        result['stoppedExit'] = hydraq.returncode
        result['steps'].append(ask(child, 'Usa a ferramenta search_project_conversations do servidor MCP hydraq com a pesquisa teste e responde apenas com a mensagem de erro exata que ela devolver. Não uses outras ferramentas.', [r'indisponível', r'Nãofoipossívelligar']))
        hydraq, ready = controller('TUI_MEMORY_AFTER_7741')
        result['restart'] = {k: ready[k] for k in ('run', 'restored', 'sameFile', 'terminal', 'pendingReads')}
        result['steps'].append(ask(child, 'Usa agora a ferramenta get_project_memory do servidor MCP hydraq e responde apenas com o marcador que lá encontrares. Não uses outras ferramentas.', [r'TUI_MEMORY_AFTER_7741']))
    for char in '/exit':
        child.send(char); time.sleep(.05)
    time.sleep(.5); child.send('\r')
    child.expect(pexpect.EOF, timeout=30)
    pump(1, child)
    hydraq.stdin.write('release\n'); hydraq.stdin.flush()
    result['released'] = event(hydraq, ('released', 'error'), 60)
    result['sameSession'] = result['released']['sessionId'] == result['ready']['sessionId']
    steps = result['steps']
    result['ok'] = (result['command']['allowedTools'] and not result['command']['credentialInCommand'] and all(not s['prompt'] and s['matched'] for s in steps)
        and result['sameSession'] and result['released']['imported'] == len(steps) and (scenario == 'plan' or result['restart']['restored']))
except Exception as error:
    result['error'] = str(error)
finally:
    if child is not None and child.isalive():
        child.terminate(force=True)
    if hydraq is not None and hydraq.poll() is None:
        try:
            hydraq.stdin.write('quit\n'); hydraq.stdin.flush(); hydraq.wait(30)
        except Exception:
            hydraq.kill()
    credential.unlink(missing_ok=True)
    log.close()
    (directory / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get('ok') else 1)
