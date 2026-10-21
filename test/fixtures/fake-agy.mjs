import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
const emit=event=>process.stdout.write(JSON.stringify(event)+'\n');
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
  if(text==='hold')return;
  if(text==='multi-partial-hold') {
    emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'DONE',step_type:'agent_response',text_delta:'Primeiro bloco parcial.'}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+2,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'echo primeiro'},output:'primeiro'}}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+3,state:'ACTIVE',step_type:'agent_response',text_delta:'Segundo bloco parcial.'}});
    return;
  }
  if(text==='many-tools') {
    emit({event:'step_update',step_update:{...step,step_index:1,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{parameters:{TargetFile:'first.txt'},output:'ok'}}});
    for(let i=0;i<205;i++)emit({event:'step_update',step_update:{...step,step_index:i+2,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:`command-${i}`},output:'ok',...(i===0?{error:{message:'exit 42'}}:{})}}});
  }
  if(text==='rich-tools') {
    emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'DONE',step_type:'agent_response',text_delta:'Passo 1.'}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+2,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{parameters:{TargetFile:'/tmp/exemplo.js',CodeContent:'console.log(1);'},output:'ok'}}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+3,state:'DONE',step_type:'tool',tool_name:'search_web',tool_info:{parameters:{query:'antigravity docs'},output:'resultados'}}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+4,state:'DONE',step_type:'subagent',subagent_info:{subagents:[{type_name:'research',role:'Codebase Researcher',conversation_id:'sub-1'}]}}});
    emit({event:'step_update',step_update:{...step,step_index:count*10+5,state:'DONE',step_type:'agent_response',text_delta:'Passo 2.'}});
    setTimeout(()=>emit({event:'result',result:{conversation_id:nativeId,status:'SUCCESS',response:'Passo 1.\n\nPasso 2.',usage:{input_tokens:count*100,output_tokens:count*10,cache_read_tokens:count*50,thinking_tokens:count*5,total_tokens:count*110}}}),10);
    return;
  }
  emit({event:'step_update',step_update:{...step,step_index:count*10+8,state:'DONE',step_type:'agent_response'}});
  emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'ACTIVE',step_type:'agent_response',text_delta:'A inspecionar. '}});
  if(text==='partial-hold')return;
  emit({event:'step_update',step_update:{...step,step_index:count*10+1,state:'DONE',step_type:'agent_response',text_delta:'Concluído.'}});
  emit({event:'step_update',step_update:{...step,step_index:count*10+2,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'echo test'},output:'recusado',error:{message:'Aprovação indisponível no modo headless'}}}});
  setTimeout(()=>emit({event:'result',result:{conversation_id:text==='native-error'?'':text==='foreign-result'?'other-native-session':nativeId,status:text==='native-error'?'ERROR':'SUCCESS',error:text==='native-error'?'Quota nativa esgotada':undefined,response:text==='bad-response'?123:text==='native-error'?'':`Resposta ${count} processo ${startedAt} modelo ${model} modo ${mode}`,usage:{input_tokens:count*100,output_tokens:count*10,cache_read_tokens:count*50,thinking_tokens:count*5,total_tokens:count*110}}}),10);
});
