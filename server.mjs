import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.API_KEY || '';
const maxJsonBody = 32_768;
const maxFrameBody = 600_000;
let latestRoll = null;
let latestFrame = null;
let frameCapturedAt = 0;
let latestCropDebug = [];

const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8' };

export function validateRoll(body) {
  const diceType=String(body?.diceType||'').toLowerCase(), values=body?.values;
  if(!/^d\d+$/.test(diceType)) return 'diceType invalide';
  const sides=Number(diceType.slice(1));
  if(!Array.isArray(values)||values.length<1||values.length>30) return 'values doit contenir 1 à 30 résultats';
  if(values.some(v=>!Number.isInteger(v)||v<1||v>sides)) return `Chaque valeur doit être comprise entre 1 et ${sides}`;
  return null;
}

export class RollCoordinator {
  constructor(){ this.active=null; }
  create({ count, diceType='d6', timeoutMs=55_000 }) {
    if(this.active) throw Object.assign(new Error('Une demande est déjà en attente'),{status:409});
    if(!Number.isInteger(count)||count<1||count>8) throw Object.assign(new Error('count doit être compris entre 1 et 8'),{status:400});
    if(diceType!=='d6') throw Object.assign(new Error('Seul le type d6 est disponible'),{status:400});
    const request={id:randomUUID(),count,diceType,createdAt:new Date().toISOString()};
    const promise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ if(this.active?.request.id===request.id)this.active=null; reject(Object.assign(new Error('Aucun lancer détecté avant expiration'),{status:408})); },Math.min(Math.max(timeoutMs,5_000),60_000));
      this.active={request,resolve,reject,timer};
    });
    return {request,promise};
  }
  complete(requestId, values) {
    if(!this.active||this.active.request.id!==requestId) throw Object.assign(new Error('Demande expirée ou inconnue'),{status:404});
    if(!Array.isArray(values)||values.length!==this.active.request.count) throw Object.assign(new Error(`Il faut exactement ${this.active.request.count} valeurs`),{status:400});
    const error=validateRoll({diceType:this.active.request.diceType,values});
    if(error) throw Object.assign(new Error(error),{status:400});
    const result={id:requestId,diceType:this.active.request.diceType,values,count:values.length,source:'live-camera',capturedAt:new Date().toISOString()};
    clearTimeout(this.active.timer); this.active.resolve(result); this.active=null; return result;
  }
  cancel(requestId){ if(this.active?.request.id===requestId){clearTimeout(this.active.timer);this.active=null;} }
  get request(){ return this.active?.request||null; }
}
export const coordinator=new RollCoordinator();

function json(res,status,data){res.writeHead(status,{'content-type':mime['.json'],'cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(data));}
async function rawBody(req,limit){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Payload trop volumineux'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks);}
async function jsonBody(req){return JSON.parse((await rawBody(req,maxJsonBody)).toString()||'{}');}
function authorized(req){if(!apiKey)return true;const given=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(given.length!==apiKey.length)return false;return timingSafeEqual(Buffer.from(given),Buffer.from(apiKey));}
async function serveFile(req,res){const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const requested=pathname==='/'?'index.html':pathname.slice(1);const safe=normalize(requested).replace(/^(\.\.(\/|\\|$))+/,'');const file=join(root,safe);if(!file.startsWith(root))return json(res,404,{error:'Introuvable'});try{if(!(await stat(file)).isFile())throw new Error();res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(await readFile(file));}catch{json(res,404,{error:'Introuvable'});}}

export const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type, authorization'});return res.end();}
  if(url.pathname==='/api/health'&&req.method==='GET')return json(res,200,{ok:true,phoneOnline:Date.now()-frameCapturedAt<4_000,pending:!!coordinator.request});
  if(url.pathname==='/api/roll/latest'&&req.method==='GET')return latestRoll?json(res,200,latestRoll):json(res,404,{error:'Aucun tirage disponible'});
  if(url.pathname==='/api/roll/pending'&&req.method==='GET')return json(res,200,{request:coordinator.request});
  if(url.pathname==='/api/roll/wait'&&req.method==='POST'){
    if(!authorized(req))return json(res,401,{error:'Clé API invalide'});
    let created;
    try{const body=await jsonBody(req);created=coordinator.create({count:body.count,diceType:body.diceType||'d6',timeoutMs:body.timeoutMs});
      res.on('close',()=>{if(!res.writableEnded)coordinator.cancel(created.request.id);});
      latestRoll=await created.promise;return json(res,200,latestRoll);
    }catch(error){return json(res,error.status||400,{error:error.message});}
  }
  if(url.pathname==='/api/roll/complete'&&req.method==='POST'){
    try{const body=await jsonBody(req);latestRoll=coordinator.complete(body.requestId,body.values);return json(res,201,latestRoll);}catch(error){return json(res,error.status||400,{error:error.message});}
  }
  if(url.pathname==='/api/stream/frame'&&req.method==='POST'){
    if(req.headers['content-type']!=='image/jpeg')return json(res,415,{error:'Une image JPEG est attendue'});
    try{latestFrame=await rawBody(req,maxFrameBody);frameCapturedAt=Date.now();res.writeHead(204,{'access-control-allow-origin':'*'});return res.end();}catch(error){return json(res,error.status||400,{error:error.message});}
  }
  if(url.pathname==='/api/stream/latest.jpg'&&req.method==='GET'){
    if(!latestFrame)return json(res,404,{error:'Téléphone hors ligne'});
    res.writeHead(200,{'content-type':'image/jpeg','cache-control':'no-store','access-control-allow-origin':'*','x-frame-age':String(Date.now()-frameCapturedAt)});return res.end(latestFrame);
  }
  if(url.pathname==='/api/debug/crops'&&req.method==='GET')return json(res,200,{crops:latestCropDebug});
  if(url.pathname==='/api/debug/crops'&&req.method==='POST'){
    try{const body=await jsonBody(req);latestCropDebug=Array.isArray(body.crops)?body.crops.slice(0,8):[];return json(res,200,{ok:true});}catch(error){return json(res,400,{error:error.message});}
  }
  return serveFile(req,res);
});
if(process.argv[1]===fileURLToPath(import.meta.url))server.listen(port,()=>console.log(`Ginse Dice écoute sur http://localhost:${port}`));
