import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
const emit=event=>process.stdout.write(JSON.stringify(event)+'\n');
// Like agy: every PreToolUse hook in FAKE_AGY_HOOKS runs before a tool; a failure or any deny refuses it.
function refusal(nativeId,step) {
  if(!process.env.FAKE_AGY_HOOKS||process.env.FAKE_AGY_SKIP_HOOKS===step.tool_name)return null;
  let hooks;try{hooks=JSON.parse(readFileSync(process.env.FAKE_AGY_HOOKS,'utf8'));}catch{return null;}
  for(const spec of Object.values(hooks))for(const group of spec.PreToolUse||[])for(const hook of group.hooks||[]) {
    const run=spawnSync('sh',['-c',hook.command],{input:JSON.stringify({conversationId:nativeId,stepIdx:step.step_index,toolCall:{name:step.tool_name,args:step.tool_info.parameters},artifactDirectoryPath:'/fake-agy/brain/'+nativeId}),encoding:'utf8'});
    let answer;try{answer=JSON.parse(run.stdout);}catch{}
    if(run.status!==0||!answer?.decision||answer.decision==='deny')return answer?.reason||'tool call denied by pre-tool hook';
  }
  return null;
}
const tool=(nativeId,step)=>{const denied=refusal(nativeId,step);emit({event:'step_update',step_update:denied?{...step,state:'ERROR',tool_info:{parameters:step.tool_info.parameters,error:{message:'Encountered error in tool execution: '+denied}}}:step});return !denied;};
if(args[0]==='models') {
  console.log('\r⠋ Fetching available models...\r\x1b[32mgemini-4-argon-low\x1b[0m\tGemini 4 Argon (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\ncustom-paid\tCustom API');
  process.exit(0);
}
if(args.includes('--dangerously-skip-permissions'))process.exit(9);
if(!args.includes('--sandbox') || !args.includes('--disable-slash-commands'))process.exit(8);
if(process.env.GEMINI_API_KEY||process.env.ANTHROPIC_API_KEY)process.exit(7);
const nativeId=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:'native-'+process.pid;
const model=args[args.indexOf('--model')+1];
const mode=args.includes('--mode')?args[args.indexOf('--mode')+1]:'request-review';
let count=0;
process.on('SIGINT',()=>{if(process.env.FAKE_AGY_STOP==='native'){emit({event:'result',result:{conversation_id:nativeId,status:'ERROR',error:'interrupted',response:''}});process.exit(1);}if(process.env.FAKE_AGY_STOP!=='confirmed')process.exit(1);emit({event:'result',result:{conversation_id:nativeId,status:'CANCELED',response:''}});process.exit(0);});
try{count=JSON.parse(readFileSync('.fake-agy-'+nativeId,'utf8')).count;}catch{}
const startedAt=process.pid;
emit({event:'init',conversation_id:nativeId,init:{model,cwd:process.cwd(),permission_mode:mode}});
createInterface({input:process.stdin}).on('line',line=> {
  const input=JSON.parse(line);
  if(input.event!=='user')process.exit(5);
  const raw=input.message.content;
  const text=raw.split('Novo pedido do utilizador:\n').at(-1);
  if(text==='disconnect')process.exit(1);
  count++;
  writeFileSync('.fake-agy-'+nativeId,JSON.stringify({count}));
  writeFileSync('.fake-agy-last-'+nativeId,raw);
  const step={conversation_id:nativeId,step_index:count*10};
  emit({event:'step_update',step_update:{...step,state:'DONE',step_type:'user_input'}});
  if(text.startsWith('diagnostic-')) {
    const refused=text==='diagnostic-refused-empty';
    if(refused)tool(nativeId,{...step,step_index:count*10+1,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'git status --short'},error:{type:'PERMISSION_DENIED',message:'Approval unavailable in headless mode'}}});
    if(text==='diagnostic-stderr-warning')process.stderr.write('Warning: run_command soft-denied; approval required in headless mode\n');
    if(text==='diagnostic-stderr-quota')process.stderr.write('ERROR: RESOURCE_EXHAUSTED: quota exceeded for this model\n');
    if(text==='diagnostic-stderr-secrets')process.stderr.write('ERROR: quota exceeded API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    const empty=['diagnostic-empty','diagnostic-refused-empty'].includes(text);
    const error=text==='diagnostic-quota-structured'?{type:'QUOTA_EXCEEDED',message:'Limite da conta'}:text==='diagnostic-resource-busy'?{type:'RESOURCE_EXHAUSTED',message:'Server capacity temporarily unavailable'}:text==='diagnostic-stderr-quota'?'Request failed':null;
    setTimeout(()=>emit({event:'result',result:{conversation_id:nativeId,status:error?'ERROR':'SUCCESS',error,response:empty||error?'':text==='diagnostic-prose'?'O manual explica a mensagem quota exceeded; a minha resposta não indica um limite atingido.':'Resposta recebida com aviso nativo.'}}),20);
    return;
  }
  if(text==='hold'||text==='guard-mcp-hold'||process.env.FAKE_AGY_HOLD==='1')return;
  if(text==='guard-tools'||text==='guard-hold-write'||text==='guard-mcp') {
    const calls=text==='guard-hold-write'?[['write_file',{Path:process.cwd()+'/x.txt'}]]:text==='guard-mcp'?[['call_mcp_tool',{ServerName:'hydraq',ToolName:'read_dialogue'}],['call_mcp_tool',{ServerName:'hydraq',ToolName:'other_tool'}],['call_mcp_tool',{ServerName:'other',ToolName:'read_dialogue'}],['write_file',{Path:process.cwd()+'/x.txt'}]]:[['read_file',{Path:process.cwd()+'/README.md'}],['run_command',{CommandLine:'ls -la'}],['write_file',{Path:process.cwd()+'/x.txt'}],['write_file',{Path:'/fake-agy/brain/'+nativeId+'/task.md'}],['run_command',{CommandLine:'touch y.txt'}]];
    const outcome=calls.map(([name,parameters],i)=>name+':'+(tool(nativeId,{...step,step_index:count*10+1+i,state:'DONE',step_type:'tool',tool_name:name,tool_info:{parameters,output:'ok'}})?'ok':'recusada'));
    if(text==='guard-hold-write')return;
    setTimeout(()=>emit({event:'result',result:{conversation_id:nativeId,status:'SUCCESS',response:outcome.join(' ')}}),10);
    return;
  }
  if(text==='multi-partial-hold') {
    emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'DONE',step_type:'agent_response',text_delta:'Primeiro bloco parcial.'}});
    tool(nativeId,{...step,step_index:count*10+2,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'echo primeiro'},output:'primeiro'}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+3,state:'ACTIVE',step_type:'agent_response',text_delta:'Segundo bloco parcial.'}});
    return;
  }
  if(text==='write-file-path') {
    tool(nativeId,{...step,step_index:count*10+1,state:'DONE',step_type:'tool',tool_name:'write_file',tool_info:{parameters:{Path:'/tmp/sum.mjs'},output:'ok'}});
  } else if(text==='many-tools') {
    tool(nativeId,{...step,step_index:1,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{parameters:{TargetFile:'first.txt'},output:'ok'}});
    for(let i=0;i<205;i++)tool(nativeId,{...step,step_index:i+2,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:`command-${i}`},output:'ok',...(i===0?{error:{message:'exit 42'}}:{})}});
  }
  if(text==='rich-tools') {
    emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'DONE',step_type:'agent_response',text_delta:'Passo 1.'}});
    tool(nativeId,{...step,step_index:count*10+2,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{parameters:{TargetFile:'/tmp/exemplo.js',CodeContent:'console.log(1);'},output:'ok'}});
    tool(nativeId,{...step,step_index:count*10+3,state:'DONE',step_type:'tool',tool_name:'search_web',tool_info:{parameters:{query:'antigravity docs'},output:'resultados'}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+4,state:'DONE',step_type:'subagent',subagent_info:{subagents:[{type_name:'research',role:'Codebase Researcher',conversation_id:'sub-1'}]}}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+5,state:'DONE',step_type:'agent_response',text_delta:'Passo 2.'}});
    setTimeout(()=>emit({event:'result',result:{conversation_id:nativeId,status:'SUCCESS',response:'Passo 1.\n\nPasso 2.',usage:{input_tokens:count*100,output_tokens:count*10,cache_read_tokens:count*50,thinking_tokens:count*5,total_tokens:count*110}}}),10);
    return;
  }
  emit({event:'step_update',step_update:{...step,step_index:count*10+8,state:'DONE',step_type:'agent_response'}});
  emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'ACTIVE',step_type:'agent_response',text_delta:'A inspecionar. '}});
  if(text==='partial-hold')return;
  emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'DONE',step_type:'agent_response',text_delta:'Concluído.'}});
  tool(nativeId,{...step,step_index:count*10+2,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'echo test'},output:'recusado',error:{message:'Aprovação indisponível no modo headless'}}});
  setTimeout(()=>emit({event:'result',result:{conversation_id:text==='native-error'?'':text==='foreign-result'?'other-native-session':nativeId,status:text==='native-error'?'ERROR':'SUCCESS',error:text==='native-error'?'Quota nativa esgotada':undefined,response:text==='bad-response'?123:text==='native-error'?'':`Resposta ${count} processo ${startedAt} modelo ${model} modo ${mode}`,usage:{input_tokens:count*100,output_tokens:count*10,cache_read_tokens:count*50,thinking_tokens:count*5,total_tokens:count*110}}}),10);
});
