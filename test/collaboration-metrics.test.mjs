import test from 'node:test';import assert from 'node:assert/strict';import{observeTiming,cycleMetrics}from'../lib/collaboration-metrics.mjs';
test('trabalho e espera são intervalos distintos, sem duplicar decisões simultâneas',()=>{
 const c={id:'a',startedAt:new Date(1000).toISOString(),principalTurns:0,timing:{observedAt:1000,workMs:0,waitMs:0,waiting:false}};
 observeTiming(c,true,1100);observeTiming(c,true,1300);observeTiming(c,false,1500);observeTiming(c,false,1800,true);
 const m=cycleMetrics(c,null,false,1800);assert.equal(m.workMs,400);assert.equal(m.waitMs,400);assert.equal(m.complete,true);assert.equal(m.elapsedMs,800);observeTiming(c,false,5000);assert.equal(c.timing.observedAt,1800);
});
test('métrica viva não altera o estado e retoma incerta não conta tempo offline',()=>{
 const c={id:'a',startedAt:new Date(1000).toISOString(),principalTurns:0,timing:{observedAt:1200,workMs:100,waitMs:100,waiting:true}},raw=JSON.stringify(c);
 assert.equal(cycleMetrics(c,null,true,1400).waitMs,300);assert.equal(JSON.stringify(c),raw);c.timing.stoppedAt=1200;c.timing.incomplete=true;
 const m=cycleMetrics(c,null,false,999999);assert.equal(m.waitMs,100);assert.equal(m.complete,false);
});
test('consumo soma só os turnos do pedido e explicita os contadores em falta',()=>{
 const c={id:'abc',startedAt:new Date(0).toISOString(),principalTurns:3};
 const p={turns:[{requestId:'col-abc',usage:{inputTokens:100,cachedInputTokens:70,outputTokens:10,totalTokens:110}},{requestId:'col-result-abc-1',usage:{inputTokens:200,cachedInputTokens:150,outputTokens:20,totalTokens:220}},{requestId:'col-result-abc-2',usage:null},{requestId:'col-other',usage:{inputTokens:999,cachedInputTokens:0,outputTokens:999}}]};
 const m=cycleMetrics(c,p,false,1000);assert.equal(m.principalUsage.inputTokens,300);assert.equal(m.principalUsage.cachedInputTokens,220);assert.equal(m.principalUsage.outputTokens,30);assert.equal(m.principalUsage.totalTokens,330);assert.equal(m.principalUsage.measuredTurns,2);assert.equal(m.principalUsage.expectedTurns,3);assert.equal(m.principalUsage.complete,false);assert.equal(m.workMs,null);assert.equal(m.waitMs,null);
});

test('subtotal inclui todas as revisões Claude e explicita Grok não medido',()=>{
 const c={id:'a',principalTurns:1},p={turns:[{requestId:'col-a',usage:{inputTokens:10,cachedInputTokens:5,outputTokens:2}}]};
 const r=[{cycleId:'a',usage:{inputTokens:20,cachedInputTokens:7,outputTokens:3}},{cycleId:'a',usage:{inputTokens:30,cachedInputTokens:8,outputTokens:4}},{cycleId:'b',usage:{inputTokens:999,outputTokens:999}}];
 const m=cycleMetrics(c,p,false,0,r,[{cycleId:'a',requestId:'worker'}]);assert.equal(m.reviewerUsage.inputTokens,50);assert.equal(m.measuredUsage.inputTokens,60);assert.equal(m.measuredUsage.outputTokens,9);assert.equal(m.executorUsage.available,false);assert.equal(m.executorUsage.expectedTurns,1);assert.equal(m.measuredUsage.complete,false);
});
