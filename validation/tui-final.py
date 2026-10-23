"""Exercise the original TUI against validation/native-live.mjs (real model turn)."""
import pathlib, json, os, pexpect, time, re, sys, uuid
root = pathlib.Path(os.environ.get('NATIVE_TEST_DIR') or pathlib.Path('/tmp/hydraq-native-live-current').read_text().strip())
info = json.loads((root / 'info.json').read_text())
home = root / 'tui-home'; home.mkdir(exist_ok=True)
(home / 'config.toml').write_text('log_dir=' + json.dumps(str(root / 'tui-logs')) + '\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[tui]\nscreen_reader_detection_done=true\n')
env = os.environ.copy(); env.update(TERM='xterm-256color', CODEX_HOME=str(home), RUST_LOG='warn')
marker = os.environ.get('NATIVE_EXPECTED', 'TUI_' + uuid.uuid4().hex[:10])
prompt = os.environ.get('NATIVE_PROMPT', f'Responde apenas {marker}. Não uses ferramentas nem alteres ficheiros.')
before = json.loads((root / 'state/state.json').read_text())['conversations'][0]
count = len(before['turns'])
history_only = bool(os.environ.get('NATIVE_HISTORY_ONLY'))
if history_only: marker = before['messages'][-1]['text'].strip()
child = pexpect.spawn('codex', ['resume', '--remote', 'unix://' + info['socket'], '--no-alt-screen', '-C', str(root), info['threadId']] + ([] if history_only else [prompt]), env=env, encoding='utf-8', timeout=2, dimensions=(36, 120))
text = ''; deadline = time.time() + 120; completed_at = None; done = False; trust = False
try:
    while time.time() < deadline:
        try: text += child.read_nonblocking(65536, timeout=.3)
        except pexpect.TIMEOUT: pass
        except pexpect.EOF: break
        clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
        if not trust and ('trust this folder' in clean.lower() or 'trustthisfolder?' in clean.lower() or 'Trust and continue' in clean):
            child.send('\r'); trust = True
        if 'Press Enter to continue' in clean: child.send('\r')
        try:
            state = json.loads((root / 'observation.json').read_text())
            final = state['messages'][-1].get('text', '').strip()
            if len(state['turns']) == count + (0 if history_only else 1) and state['status'] == 'completed' and final == marker and '• ' + marker in clean:
                completed_at = completed_at or time.time()
                if time.time() - completed_at >= 3:
                    done = 'Connection lost' not in clean and 'Reconnected.' not in clean
                    break
        except (FileNotFoundError, json.JSONDecodeError): pass
finally:
    child.sendcontrol('c'); time.sleep(.3)
    if child.isalive(): child.sendcontrol('c'); time.sleep(.3)
    if child.isalive(): child.terminate(force=True)
    (root / 'tui-final-output.txt').write_text(text)
    result = dict(completed=done, historyOnly=history_only, marker=marker, trustAccepted=trust, capturedChars=len(text), noReconnect='Connection lost' not in text and 'Reconnected.' not in text)
    if not done: result['tail'] = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text[-3500:])
    (root / 'tui-final-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if done else 1)
