import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {validationSnapshot,runValidation,testStatus,removePrivate} from '../lib/hydra-validation.mjs';
import {noBwrap} from './fixtures/sandbox.mjs';

async function project(t){const root=await mkdtemp('/tmp/hydra-visual-test-'),cwd=root+'/project';t.after(()=>removePrivate(root));await mkdir(cwd);await writeFile(cwd+'/index.html','<!doctype html><body><canvas width="500" height="300"></canvas><script>window.state={x:20,dash:false,attack:null};addEventListener("keydown",e=>{if(e.key==="d")state.x+=50;if(e.key===" "){state.dash=true;state.attack="light";setTimeout(()=>{state.dash=false;state.attack=null},100)}});function draw(){const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#18303b";c.fillRect(0,0,500,300);c.fillStyle="gold";c.fillRect(state.x,100,40,40);requestAnimationFrame(draw)}draw()</script>');return {cwd,snapshot:(await validationSnapshot(cwd,root+'/snapshot')).directory};}
const script={durationMs:500,frameCount:3,width:640,height:480,probe:'window.state',actions:[{atMs:20,type:'keyDown',key:'d'},{atMs:50,type:'keyUp',key:'d'},{atMs:100,type:'keyDown',key:'Space'},{atMs:120,type:'keyUp',key:'Space'}],checks:[{name:'movimento',expression:'samples.some(s=>s.state?.x>=70)'},{name:'dash inicia e termina',expression:'samples.some(s=>s.state?.dash)&&samples.at(-1).state?.dash===false'}]};
test('guião Chrome isolado: teclas, capturas, mosaico e medições sem capturas',{skip:noBwrap},async t=>{
 const x=await project(t),r=await runValidation({...x,command:'visual',visual:script});assert.equal(testStatus(r),'passed',r.output+' '+r.error);assert.equal(r.sourceChanged,false);assert.equal(r.artifacts.length,4);const mosaic=r.artifacts.find(a=>a.name==='mosaico.png');assert.equal(mosaic.width,720);assert.equal(mosaic.height,205);assert.ok(r.visual.checks.every(c=>c.passed));assert.ok(r.visual.metrics.samples>5);assert.ok(r.visual.metrics.rafHz>0);assert.ok(r.visual.inputs.some(i=>i.key==='d'&&i.type==='keydown'));assert.ok(r.visual.durations.some(d=>d.key==='dash'&&d.startObserved&&d.endObserved&&d.ms>30));assert.ok(r.visual.durations.some(d=>d.key==='attack'&&d.value==='light'&&d.startObserved&&d.endObserved&&d.ms>30&&d.ms<200));assert.ok(r.visual.inputs.every(i=>i.t>=0));assert.equal(r.visual.frames.length,3);
});
test('um check falso não passa só porque o Chrome produziu imagens',{skip:noBwrap},async t=>{
 const x=await project(t),r=await runValidation({...x,command:'visual',visual:{...script,checks:[{name:'impossível',expression:'samples.some(s=>s.state?.x>10000)'}]}});assert.equal(testStatus(r),'failed');assert.equal(r.exitCode,1);assert.ok(r.artifacts.length);assert.equal(r.visual.checks.find(c=>c.name==='impossível').passed,false);
});
test('página inexistente e sonda inutilizável não certificam uma validação visual',{skip:noBwrap},async t=>{
 const x=await project(t);for(const visual of [{...script,page:'missing.html'},{...script,probe:'window.missing.x'}]){const r=await runValidation({...x,command:'visual',visual});assert.equal(testStatus(r),'failed',r.output);}
});
