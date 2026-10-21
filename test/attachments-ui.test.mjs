import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { ImageAttachments } from '../public/attachments.js';

class Element {
  constructor(){this.children=[];this.events={};this.attrs={};this.classList={toggle(){}};}
  append(...children){this.children.push(...children);}
  prepend(...children){this.children.unshift(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attrs[key]=value;}
  addEventListener(name,handler){this.events[name]=handler;}
  querySelector(){return this.footer ||= new Element();}
}
const file=()=>new File(['fixture'],'image.png',{type:'image/png'});
function setup(){
  const old=globalThis.document;
  globalThis.document={createElement:()=>new Element(),body:new Element()};
  let key='new',busy=false;const notices=[],composer=new Element();
  const ui=new ImageAttachments({composer,getKey:()=>key,getToken:()=>'test-token',isBusy:()=>busy,changed(){},toast:message=>notices.push(message)});
  return {ui,composer,notices,key:value=>{key=value;},busy:value=>{busy=value;},restore:()=>{for(const records of ui.drafts.values())for(const r of records)URL.revokeObjectURL(r.url);globalThis.document=old;}};
}

test('seleção, colagem e drop convergem no rascunho; trocar de conversa não mistura anexos',()=>{
  const {ui,composer,notices,key,busy,restore}=setup();
  try{
    ui.input.files=[file()];ui.input.events.change();
    let prevented=false;composer.events.paste({clipboardData:{files:[file()]},preventDefault(){prevented=true;}});
    assert.equal(prevented,true);assert.equal(ui.list().length,2);
    composer.events.drop({dataTransfer:{files:[file()]},preventDefault(){}});assert.equal(ui.list().length,3);
    ui.add([file(),file()]);assert.equal(ui.list().length,3);assert.match(notices.at(-1),/quatro/);
    key('other');assert.equal(ui.list().length,0);ui.add([file()]);assert.equal(ui.list().length,1);
    ui.move('new','created');key('created');assert.equal(ui.list().length,3);
    busy(true);ui.add([file()]);assert.equal(ui.list().length,3);assert.match(notices.at(-1),/Aguarda/);
  }finally{restore();}
});

test('upload falhado conserva rascunhos; só consumo explícito remove os anexos enviados',async()=>{
  const {ui,restore}=setup(),oldFetch=globalThis.fetch;
  try{
    ui.add([file()]);const records=[...ui.list()];
    globalThis.fetch=async()=>({ok:false,json:async()=>({error:'Falha de teste'})});
    await assert.rejects(ui.upload(records,{id:'conversation',group:'group'}),/Falha de teste/);
    assert.equal(ui.list().length,1);
    let requests=0;
    globalThis.fetch=async(url,options)=>{requests++;assert.match(url,/conversation\/attachments/);assert.equal(options.headers['x-hydraq-token'],'test-token');return {ok:true,json:async()=>({id:'uploaded'})};};
    assert.deepEqual(await ui.upload(records,{id:'conversation',group:'group'}),['uploaded']);
    assert.deepEqual(await ui.upload(records,{id:'conversation',group:'group'}),['uploaded']);assert.equal(requests,1);
    ui.add([file()]);ui.consume(records);assert.equal(ui.list().length,1);
  }finally{globalThis.fetch=oldFetch;restore();}
});
