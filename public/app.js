import * as ort from 'onnxruntime-web';

const $=s=>document.querySelector(s),video=$('#video'),canvas=$('#canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
const countInput=$('#diceCount'),countValue=$('#countValue');let stream,loopTimer,busy=false,lastRequestId=null,stableKey='',stableFrames=0;
let detector=null,detectorLoading=null;
const MODEL_SIZE=384,CONFIDENCE_THRESHOLD=.22,IOU_THRESHOLD=.45;
const modelCanvas=document.createElement('canvas'),modelCtx=modelCanvas.getContext('2d',{willReadFrequently:true});modelCanvas.width=MODEL_SIZE;modelCanvas.height=MODEL_SIZE;

async function loadDetector(){
  if(detector)return detector;if(detectorLoading)return detectorLoading;
  $('#cameraStatus').textContent='↓ YOLO…';
  ort.env.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
  detectorLoading=ort.InferenceSession.create('/models/dice-yolo26n.onnx',{executionProviders:['wasm']})
    .then(model=>{detector=model;$('#cameraStatus').textContent='● YOLO PRÊT';return model;})
    .catch(error=>{console.error('YOLO26n:',error);detectorLoading=null;$('#cameraStatus').textContent='YOLO INDISPONIBLE';return null;});
  return detectorLoading;
}
function setCount(n){countInput.value=Math.max(1,Math.min(8,n));countValue.value=countInput.value;countValue.textContent=countInput.value;}
$('#minus').onclick=()=>setCount(+countInput.value-1);$('#plus').onclick=()=>setCount(+countInput.value+1);

$('#cameraButton').onclick=async()=>{
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;clearTimeout(loopTimer);video.srcObject=null;$('#emptyState').classList.remove('hidden');$('#cameraButton span').textContent='ACTIVER LA CAMÉRA';$('#captureButton').disabled=true;$('#cameraStatus').textContent='CAMÉRA ÉTEINTE';return;}
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});video.srcObject=stream;await video.play();$('#emptyState').classList.add('hidden');$('#cameraButton span').textContent='COUPER LA CAMÉRA';$('#captureButton').disabled=false;$('#cameraStatus').textContent='↓ YOLO…';$('#message').textContent='Chargement du détecteur de dés…';loadDetector();loop();}catch{$('#message').textContent='Accès caméra refusé. HTTPS est obligatoire hors localhost.';}
};

function overlap(a,b){const left=Math.max(a.minX,b.minX),top=Math.max(a.minY,b.minY),right=Math.min(a.maxX,b.maxX),bottom=Math.min(a.maxY,b.maxY),intersection=Math.max(0,right-left)*Math.max(0,bottom-top);return intersection/(Math.max(0,a.maxX-a.minX)*Math.max(0,a.maxY-a.minY)+Math.max(0,b.maxX-b.minX)*Math.max(0,b.maxY-b.minY)-intersection||1);}
function suppressOverlaps(candidates){const kept=[];for(const candidate of candidates.sort((a,b)=>b.confidence-a.confidence)){if(kept.every(other=>overlap(candidate,other)<IOU_THRESHOLD))kept.push(candidate);}return kept.sort((a,b)=>a.cx-b.cx||a.cy-b.cy);}
async function detectDice(){
  const model=await loadDetector();if(!model)return[];
  const w=canvas.width,h=canvas.height,scale=Math.min(MODEL_SIZE/w,MODEL_SIZE/h),scaledW=Math.round(w*scale),scaledH=Math.round(h*scale),padX=Math.floor((MODEL_SIZE-scaledW)/2),padY=Math.floor((MODEL_SIZE-scaledH)/2);
  modelCtx.fillStyle='rgb(114,114,114)';modelCtx.fillRect(0,0,MODEL_SIZE,MODEL_SIZE);modelCtx.drawImage(canvas,0,0,w,h,padX,padY,scaledW,scaledH);
  const pixels=modelCtx.getImageData(0,0,MODEL_SIZE,MODEL_SIZE).data,input=new Float32Array(3*MODEL_SIZE*MODEL_SIZE),plane=MODEL_SIZE*MODEL_SIZE;
  for(let i=0;i<plane;i++){const p=i*4;input[i]=pixels[p]/255;input[plane+i]=pixels[p+1]/255;input[2*plane+i]=pixels[p+2]/255;}
  const tensor=new ort.Tensor('float32',input,[1,3,MODEL_SIZE,MODEL_SIZE]),output=await model.run({[model.inputNames[0]]:tensor}),values=output[model.outputNames[0]].data,candidates=[];
  for(let i=0;i<values.length;i+=6){const confidence=values[i+4],cls=Math.round(values[i+5]);if(confidence<CONFIDENCE_THRESHOLD||cls<0||cls>5)continue;const minX=Math.max(0,(values[i]-padX)/scale),minY=Math.max(0,(values[i+1]-padY)/scale),maxX=Math.min(w,(values[i+2]-padX)/scale),maxY=Math.min(h,(values[i+3]-padY)/scale);if(maxX<=minX||maxY<=minY)continue;candidates.push({minX,minY,maxX,maxY,cx:(minX+maxX)/2,cy:(minY+maxY)/2,value:cls+1,confidence});}
  return suppressOverlaps(candidates);
}
function jpegBlob(){return new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.62));}
function renderZones(zones){ctx.lineWidth=3;ctx.strokeStyle='#eaff45';ctx.fillStyle='#eaff45';ctx.font='bold 18px monospace';zones.forEach(z=>{ctx.strokeRect(z.minX,z.minY,z.maxX-z.minX,z.maxY-z.minY);ctx.fillText(`${z.value} ${Math.round(z.confidence*100)}%`,z.minX+4,z.minY+21);});}
async function loop(){if(!stream)return;try{if(!busy&&video.videoWidth){busy=true;const w=480,h=Math.round(w*video.videoHeight/video.videoWidth);canvas.width=w;canvas.height=h;ctx.drawImage(video,0,0,w,h);let pending=null;try{const r=await fetch('/api/roll/pending',{cache:'no-store'});pending=(await r.json()).request;}catch{}
      if(pending){setCount(pending.count);const detected=await detectDice(),values=detected.map(z=>z.value),key=values.join(',');renderZones(detected);$('#message').textContent=`Demande : ${pending.count} dé(s) · détectés ${values.length}`;if(lastRequestId!==pending.id){lastRequestId=pending.id;stableKey='';stableFrames=0;}if(values.length===pending.count&&key===stableKey)stableFrames++;else{stableKey=key;stableFrames=values.length===pending.count?1:0;}if(stableFrames>=3){const r=await fetch('/api/roll/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:pending.id,values})});if(r.ok){const roll=await r.json();renderResult(roll);$('#message').textContent='Tirage envoyé. En attente de la prochaine requête…';stableFrames=0;}}}else{$('#message').textContent=detector?'Flux publié. YOLO prêt, en attente d’une requête API…':'Chargement de YOLO…';stableFrames=0;lastRequestId=null;}
      const blob=await jpegBlob();if(blob)fetch('/api/stream/frame',{method:'POST',headers:{'content-type':'image/jpeg'},body:blob}).catch(()=>{});busy=false;}}catch{busy=false;}loopTimer=setTimeout(loop,700);}
function renderResult(roll){$('#resultDice').innerHTML=roll.values.map(v=>`<span class="result-die">${v}</span>`).join('');$('#jsonOutput').textContent=JSON.stringify(roll.values);$('#resultMeta').textContent=`${roll.values.length} dé(s) · ${new Date(roll.capturedAt).toLocaleTimeString('fr-FR')}`;$('#copyButton').disabled=false;}
$('#copyButton').onclick=async()=>{await navigator.clipboard.writeText($('#jsonOutput').textContent);$('#copyButton').textContent='COPIÉ';setTimeout(()=>$('#copyButton').textContent='COPIER',1200);};
