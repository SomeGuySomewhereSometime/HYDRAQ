import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProgress } from '../lib/progress.mjs';

test('progresso não mistura ações antigas nem apresenta comandos com erro como sucesso',()=> {
  const conversation={status:'running',turns:[{id:'current',status:'running',plan:{steps:[{step:'Ler',status:'completed'},{step:'Validar',status:'inProgress'}]}}],messages:[],items:[
    {id:'old',turnId:'old',type:'commandExecution',status:'completed',exitCode:0},
    {id:'current-error',turnId:'current',type:'commandExecution',status:'completed',exitCode:1},
    {id:'current-active',turnId:'current',type:'commandExecution',status:'inProgress',command:'node teste.mjs'},
  ]};
  const summary=summarizeProgress(conversation);
  assert.equal(summary.counts.completed,0);
  assert.equal(summary.counts.failed,1);
  assert.equal(summary.counts.running,1);
  assert.equal(summary.actions.length,2);
  assert.equal(summary.title,'A correr node teste.mjs');
  assert.equal(summary.completedSteps,1);
  assert.equal('percentage' in summary,false);
});

test('interrupção não marca ações ou passos pendentes como concluídos',()=> {
  const summary=summarizeProgress({turns:[{id:'turn',status:'interrupted',plan:{steps:[{step:'Ação',status:'inProgress'}]}}],messages:[],items:[{id:'cmd',turnId:'turn',type:'commandExecution',status:'inProgress'}]});
  assert.equal(summary.completedSteps,0);
  assert.equal(summary.counts.completed,0);
  assert.equal(summary.counts.running,0);
  assert.equal(summary.actions[0].status,'unfinished');
  assert.equal(summary.title,'Pedido interrompido');
});

test('só apresenta como comentário os textos públicos identificados como commentary',()=> {
  const summary=summarizeProgress({turns:[{id:'turn',status:'running'}],items:[],messages:[
    {role:'assistant',turnId:'old',phase:'commentary',text:'Comentário anterior'},
    {role:'assistant',turnId:'turn',phase:'commentary',text:'Vou executar os testes.'},
    {role:'assistant',turnId:'turn',phase:'final_answer',text:'Resultado final'},
  ]});
  assert.equal(summary.commentary,'Vou executar os testes.');
});

test('sem ação em curso não se deduz «a pensar»: texto a chegar, decisão pendente ou trabalho sem detalhe',()=> {
 const base={cwd:'/p',items:[],messages:[]};
 assert.equal(summarizeProgress({...base,turns:[{id:'t',status:'running'}]}).title,'Codex a trabalhar · sem atividade detalhada');
 assert.equal(summarizeProgress({...base,turns:[{id:'t',status:'running'}],messages:[{role:'assistant',turnId:'t',streaming:true,text:'Olá'}]}).title,'A escrever a resposta');
 assert.equal(summarizeProgress({...base,turns:[{id:'t',status:'waiting'}]}).title,'A aguardar a tua decisão');
 // Only a reasoning event the client sent itself counts as thinking.
 assert.equal(summarizeProgress({...base,turns:[{id:'t',status:'running'}],items:[{id:'r',turnId:'t',type:'reasoning',status:'inProgress'}]}).title,'A pensar');
 const parallel=summarizeProgress({...base,turns:[{id:'t',status:'running',startedAt:'2026-10-28T10:00:00Z'}],items:[{id:'a',turnId:'t',type:'mcpToolCall',server:'Claude Code',tool:'Read',parameters:{file_path:'/p/a.js'},status:'inProgress'},{id:'b',turnId:'t',type:'commandExecution',command:'npm test',status:'inProgress'}]});
 assert.equal(parallel.title,'2 ações em curso');assert.equal(parallel.detail,'A ler a.js · A correr npm test');assert.equal(parallel.startedAt,'2026-10-28T10:00:00Z');
});
