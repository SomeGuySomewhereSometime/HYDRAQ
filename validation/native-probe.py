"""Original TUI against native-probe.mjs. Run each scenario in its own terminal process."""
import json, os, pathlib, re, sys, time
import pexpect

root = pathlib.Path(os.environ['NATIVE_PROBE_DIR'])
scenario = sys.argv[1]
info = json.loads((root / 'info.json').read_text())
before = len(json.loads((root / 'methods.json').read_text())) if (root / 'methods.json').exists() else 0
env = os.environ.copy()
env.update(CODEX_HOME=info['home'], TERM='xterm-256color', RUST_LOG='warn')
child = pexpect.spawn('codex', ['resume', '--remote', 'unix://' + info['socket'], '--no-alt-screen', '-C', str(root), info['threadId']], env=env, encoding='utf-8', dimensions=(38, 125))
text = ''

def pump(seconds):
    global text
    end = time.time() + seconds
    while time.time() < end:
        try:
            text += child.read_nonblocking(65536, timeout=.15)
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            break
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

def type_text(value):
    # Separate keystrokes to avoid the TUI's burst-paste/newline heuristic.
    for char in value:
        child.send(char)
        time.sleep(.04)
    pump(.7)

def command(value):
    type_text(value)
    child.send('\r')

def control(action):
    (root / 'control.json').write_text(json.dumps(dict(at=time.time(), action=action)))

result = dict(scenario=scenario, version=info['version'], simulatedExecutor=True)
try:
    startup = pump(4)
    if 'Trustthisfolder?' in startup or 'Trust and continue' in startup:
        child.send('\r')
        pump(3)
    if not child.isalive():
        raise RuntimeError('TUI exited during startup')
    if scenario == 'queue':
        command('PROBE_HOLD')
        pump(3)
        type_text('PROBE_QUEUED')
        child.send('\t')
        queued = pump(3)
        result['queuedTextVisible'] = 'PROBE_QUEUED' in queued
        control('complete')
        pump(3)
    elif scenario == 'model':
        command('/model')
        menu = pump(3)
        result['modelMenuVisible'] = 'Select Model and Effort' in menu
        child.send('\x1b[B')
        pump(.7)
        child.send('\r')
        pump(2)
        child.send('s')  # Session-only; do not save global defaults.
        own = pump(3)
        updates = [row['params'] for row in json.loads((root / 'methods.json').read_text())[before:] if row['method'] == 'thread/settings/update']
        if updates:
            chosen = next((m['name'] for m in info['models'] if m['model'] == updates[-1].get('model')), updates[-1].get('model'))
            result['ownModel'] = chosen
            result['ownModelVisible'] = chosen.replace(' ', '') in re.sub(r'\s+', '', own[-5000:])
            result['ownModelError'] = bool(re.search(r'Failedto|notavailable|error', re.sub(r'\s+', '', own[-3000:])))
        control('settings')
        changed = pump(3)
        result['externalModelVisible'] = 'GPT-6-Luna' in changed[-5000:]
    elif scenario == 'external':
        control('external')
        external = pump(3)
        result['externalPromptVisible'] = 'PROBE_OTHER_INTERFACE' in external
        result['externalResultVisible'] = 'PROBE_SIMULATED_RESULT' in external
        control('disconnect')
        recovered = pump(6)
        result['reconnected'] = 'Reconnected. No input was resent' in recovered
        result['externalPromptAfterReconnect'] = 'PROBE_OTHER_INTERFACE' in recovered
    else:
        raise RuntimeError('Unknown scenario')
finally:
    child.sendcontrol('c')
    pump(.5)
    child.sendcontrol('c')
    pump(.5)
    if child.isalive():
        child.terminate(force=True)
    (root / (scenario + '-tui.txt')).write_text(text)
    methods = json.loads((root / 'methods.json').read_text())[before:]
    (root / (scenario + '-methods.json')).write_text(json.dumps(methods, indent=2))
    result['methods'] = [row['method'] for row in methods]
    if scenario == 'queue':
        result['nativeQueueMethods'] = [row['method'] for row in methods if row['method'].startswith('thread/queue/')]
        result['startedInputs'] = [row['params'].get('input') for row in methods if row['method'] == 'turn/start']
    (root / (scenario + '-result.json')).write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
