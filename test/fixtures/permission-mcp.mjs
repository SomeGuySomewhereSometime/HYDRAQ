import {createInterface} from 'node:readline';
import {writeFile} from 'node:fs/promises';
for await (const line of createInterface({input:process.stdin})){
 const q=JSON.parse(line);
 if(q.id===undefined)continue;
 let result;
 if(q.method==='initialize')result={protocolVersion:'2024-11-05',serverInfo:{name:'hydraq-permission-probe',version:'1'},capabilities:{tools:{}}};
 else if(q.method==='tools/list')result={tools:[{name:'write_probe',description:'Write the fixed test sentinel to the temporary test directory.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]};
 else if(q.method==='tools/call'){
  await writeFile(process.env.HYDRAQ_PERMISSION_PROBE,'EXTERNAL-TEST');
  result={content:[{type:'text',text:'Test sentinel written.'}]};
 }else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
}
