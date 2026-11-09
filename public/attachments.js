import { t as uiText } from './i18n.js';
const node = (tag, className, text) => {
  const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;
};

export class ImageAttachments {
  constructor({composer,getKey,getToken,isBusy,changed,toast}) {
    Object.assign(this,{getKey,getToken,isBusy,changed,toast});this.drafts=new Map();this.urls=new Map();
    this.tray=node('div','attachment-tray hidden');this.tray.setAttribute('aria-label','Imagens a enviar');composer.prepend(this.tray);
    this.input=node('input','sr-only');this.input.type='file';this.input.accept='image/png,image/jpeg,image/webp';this.input.multiple=true;this.input.id='image-input';this.input.setAttribute('aria-label',uiText('Selecionar imagens'));
    this.button=node('button','attach-image',uiText('＋ Imagem'));this.button.type='button';this.button.id='attach-image';this.button.title=uiText('Anexar imagens · até 4 imagens de 5 MB · também podes colar ou arrastar');
    (composer.querySelector('.composer-controls')||composer.querySelector('.composer-footer')).prepend(this.button);composer.append(this.input);
    this.button.addEventListener('click',()=>this.input.click());
    this.input.addEventListener('change',()=>{this.add([...this.input.files]);this.input.value='';});
    composer.addEventListener('paste',event=>{
      const files=[...(event.clipboardData?.files || [])];
      if(files.length){event.preventDefault();this.add(files);}
    });
    composer.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
    composer.addEventListener('drop',event=>{if(event.dataTransfer.files.length){event.preventDefault();this.add([...event.dataTransfer.files]);}});
    this.dialog=node('dialog','image-dialog');const close=node('button','','Fechar imagem');close.type='button';close.addEventListener('click',()=>this.dialog.close());
    this.large=node('img');this.caption=node('p');this.dialog.append(close,this.large,this.caption);document.body.append(this.dialog);
    this.observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){this.observer.unobserve(entry.target);entry.target.loadImage?.();}},{rootMargin:'100px'}):null;
  }
  list(){return this.drafts.get(this.getKey()) || [];}
  add(files){
    if(this.isBusy()){this.toast(uiText('Aguarda o fim do pedido para anexar imagens. As orientações em curso aceitam apenas texto.'));return;}
    const current=this.list();
    if(current.length+files.length>4){this.toast(uiText('Podes anexar até quatro imagens por mensagem.'));return;}
    for(const file of files){
      if(!['image/png','image/jpeg','image/webp'].includes(file.type) || !file.size || file.size>5*1024*1024){this.toast(uiText('Usa PNG, JPEG ou WebP estático, até 5 MB por imagem.'));return;}
    }
    this.drafts.set(this.getKey(),[...current,...files.map(file=>({file,url:URL.createObjectURL(file),uploaded:new Map()}))]);this.changed();
  }
  move(from,to){if(from!==to&&this.drafts.has(from)){this.drafts.set(to,this.drafts.get(from));this.drafts.delete(from);}}
  remove(record){for(const [key,records] of this.drafts)this.drafts.set(key,records.filter(item=>item!==record));URL.revokeObjectURL(record.url);this.changed();}
  consume(records){for(const record of records)this.remove(record);}
  open(url,name){this.large.src=url;this.large.alt=name;this.caption.textContent=name;this.dialog.showModal();}
  render(disabled=false){
    this.button.disabled=disabled;this.input.disabled=disabled;
    for(const button of this.tray.querySelectorAll('.remove-image'))button.disabled=this.isBusy();
    const records=this.list(),signature=records.map(record=>record.url).join('|');
    this.tray.classList.toggle('hidden',!records.length);
    if(this.signature===signature)return;this.signature=signature;this.tray.replaceChildren();
    for(const record of records){
      const item=node('div','attachment-draft'),preview=node('button','image-preview'),image=node('img');
      preview.type='button';preview.setAttribute('aria-label',`Ampliar ${record.file.name}`);image.src=record.url;image.alt=record.file.name;preview.append(image);preview.addEventListener('click',()=>this.open(record.url,record.file.name));
      const remove=node('button','remove-image','×');remove.type='button';remove.setAttribute('aria-label',`Remover ${record.file.name}`);remove.addEventListener('click',()=>{if(!this.isBusy())this.remove(record);});
      item.append(preview,remove);this.tray.append(item);
    }
  }
  async upload(records,conversation){
    const group=conversation.group || conversation.id,ids=[];
    for(const record of records){
      let meta=record.uploaded.get(group);
      if(!meta){
        const response=await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}/attachments?name=${encodeURIComponent(record.file.name)}`,{method:'POST',headers:{'x-hydraq-token':this.getToken(),'Content-Type':record.file.type},body:record.file});
        const result=await response.json();if(!response.ok)throw new Error(result.error || uiText('Não foi possível guardar a imagem.'));
        meta=result;record.uploaded.set(group,meta);
      }
      ids.push(meta.id);
    }
    return ids;
  }
  resetObservers(){this.observer?.disconnect();}
  renderMessage(target,images){
    if(!images?.length)return;
    const tray=node('div','message-images');
    for(const meta of images){
      const button=node('button','image-preview'),img=node('img');button.type='button';button.setAttribute('aria-label',`Ampliar ${meta.name}`);img.alt=meta.name;img.loading='lazy';button.append(img);
      const url=`/api/attachments/${encodeURIComponent(meta.group)}/${encodeURIComponent(meta.id)}`;
      button.loadImage=()=>{
        if(!this.urls.has(url))this.urls.set(url,fetch(url,{headers:{'x-hydraq-token':this.getToken()}}).then(async response=>{if(!response.ok)throw new Error(uiText('Imagem indisponível ou alterada.'));return URL.createObjectURL(await response.blob());}));
        this.urls.get(url).then(src=>{img.src=src;}).catch(()=>{button.textContent=uiText('Imagem indisponível');});
      };
      button.addEventListener('click',async()=>{try{button.loadImage();this.open(await this.urls.get(url),meta.name);}catch{this.toast(uiText('Não foi possível abrir esta imagem.'));}});
      tray.append(button);if(this.observer)this.observer.observe(button);else button.loadImage();
    }
    target.append(tray);
  }
}
