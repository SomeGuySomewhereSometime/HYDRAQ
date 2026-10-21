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
  assert.equal(summary.title,'A executar um comando');
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
