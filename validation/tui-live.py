import pathlib,json,os,pexpect,time,re,sys
root=pathlib.Path(pathlib.Path('/tmp/hydraq-native-live-current').read_text());info=json.loads((root/'info.json').read_text())
home=root/'tui-home';home.mkdir(exist_ok=True)
(home/'config.toml').write_text('[analytics]\nenabled=false\n[feedback]\nenabled=false\n[tui]\nscreen_reader_detection_done=true\n')
env=os.environ.copy();env['TERM']='xterm-256color';env['CODEX_HOME']=str(home)
prompt='Usa a ferramenta get_project_memory e responde apenas com o marcador de memória deste projeto. Não alteres ficheiros.'
child=pexpect.spawn('codex',['resume','--remote','unix://'+info['socket'],'--no-alt-screen','-C',str(root),info['threadId'],prompt],env=env,encoding='utf-8',timeout=2,dimensions=(36,120))
text='';deadline=time.time()+120;done=False;trust=False
try:
 while time.time()<deadline:
  try:text+=child.read_nonblocking(8192,timeout=.3)
  except pexpect.TIMEOUT:pass
  except pexpect.EOF:break
  (root/'tui-output-current.txt').write_text(text)
  clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text[-18000:])
  if not trust and ('trust this folder' in clean.lower() or 'trustthisfolder?' in clean.lower() or 'Trust and continue' in clean):child.send('\r');trust=True
  if 'Press Enter to continue' in clean:child.send('\r')
  if (root/'observation.json').exists():
   try:
    state=json.loads((root/'observation.json').read_text())
    if len(state['turns'])>=2 and state['status']=='completed':done=True;time.sleep(.5);break
   except Exception:pass
finally:
 child.sendcontrol('c');time.sleep(.3)
 if child.isalive():child.sendcontrol('c');time.sleep(.3)
 if child.isalive():child.terminate(force=True)
 (root/'tui-output.txt').write_text(text)
 print(json.dumps({'completed':done,'trustAccepted':trust,'capturedChars':len(text),'tail':re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text[-3500:])},ensure_ascii=False))
 sys.exit(0 if done else 1)
