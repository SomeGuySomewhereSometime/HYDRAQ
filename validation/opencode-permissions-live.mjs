// Native permission evaluator, with private temporary data and no model requests.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {OpenCodeRuntime} from '../lib/opencode-runtime.mjs';
import {openCodePermissions} from '../lib/opencode-permissions.mjs';
const root=await mkdtemp('/tmp/hydraq-opencode-permissions-live-');await mkdir(root+'/project');
const runtime=new OpenCodeRuntime({directory:root+'/native',executable:process.env.HYDRAQ_OPENCODE_BIN||'/home/sauron/.opencode/bin/opencode',manifest:false});
const context={name:'hydraq_0123456789ab',names:['get_project_memory']},results=[];
try{
  await runtime.start();const version=(await runtime.api('/api/info')).version;
  for(const [agent,sandbox]of [['build','workspace-write'],['plan','plan']]){
    const c=(await runtime.api('/api/session',{method:'POST',body:{agent,location:{directory:root+'/project'},permissions:openCodePermissions(context,{sandbox})}})).data;
    for(const [action,resource,expected]of [
      ['read','example.mjs','allow'],['edit','example.mjs',agent==='plan'?'deny':'allow'],
      ['shell','npm test',agent==='plan'?'ask':'allow'],['shell','git status --short','allow'],
      ['execute','*','allow'],['websearch','OpenCode','allow'],['question','*','allow'],
      ['external_directory','/tmp/other/*','ask'],['read','.env','ask'],['read','.env.local','ask'],['read','.env.example','allow'],
      ['hydraq_0123456789ab_get_project_memory','*','allow'],['hydraq_ffffffffffff_get_project_memory','*','deny'],
      ['subagent','general','deny']
    ]){
      const result=(await runtime.api('/api/session/'+c.id+'/permission',{method:'POST',body:{agent,action,resources:[resource]}})).data;
      results.push({agent,action,resource,effect:result.effect});assert.equal(result.effect,expected,agent+': '+action+' '+resource);
      if(result.effect==='ask')await runtime.api('/api/session/'+c.id+'/permission/'+result.id+'/reply',{method:'POST',body:{decision:'reject'}});
    }
  }
  await writeFile(root+'/result.json',JSON.stringify({version,results},null,2),{mode:0o600});
  console.log(JSON.stringify({root,version,checks:results.length,modelRequests:0,passed:true}));
}finally{await runtime.close();}
