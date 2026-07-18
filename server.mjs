import { createServer } from 'node:http';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.API_KEY || '';
const maxJsonBody = 32_768;
const maxFrameBody = 600_000;
const ginseDataDir = process.env.GINSE_DATA_DIR || fileURLToPath(new URL('./.ginse-runs/', import.meta.url));
const ginsePublicKey = createPublicKey({ key: {
  kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'ginse-invocation-2026-01',
  x: 'QHjetzvxsSaceb-Ud_TRd7je-TQYsjYG45jRUEJyw9Y'
}, format: 'jwk' });
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
function canonical(value){
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value){return createHash('sha256').update(value).digest('hex');}
function validGinseToken(req){
  const token=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i)?.[1];
  if(!token)return false;
  const parts=token.split('.');
  if(parts.length!==3)return false;
  try{
    const header=JSON.parse(Buffer.from(parts[0],'base64url'));
    const claims=JSON.parse(Buffer.from(parts[1],'base64url'));
    const now=Math.floor(Date.now()/1000);
    if(header.alg!=='EdDSA'||header.kid!=='ginse-invocation-2026-01')return false;
    if(!Number.isFinite(claims.exp)||claims.exp<=now||Number.isFinite(claims.nbf)&&claims.nbf>now+30)return false;
    return verify(null,Buffer.from(`${parts[0]}.${parts[1]}`),ginsePublicKey,Buffer.from(parts[2],'base64url'));
  }catch{return false;}
}
function validateGinseInput(body){
  return body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1&&Number.isInteger(body.count)&&body.count>=1&&body.count<=8;
}
function diceFromSeed(seed,count){
  const values=[];let block=0,bytes=Buffer.alloc(0),offset=0;
  while(values.length<count){
    if(offset>=bytes.length){bytes=createHash('sha256').update(seed).update(String(block++)).digest();offset=0;}
    const byte=bytes[offset++];
    if(byte<252)values.push(byte%6+1);
  }
  return values;
}
async function ginseRun(req,res){
  if(!validGinseToken(req))return json(res,401,{error:'Invalid Ginse bearer token'});
  const idempotencyKey=String(req.headers['idempotency-key']||'');
  if(idempotencyKey.length<8||idempotencyKey.length>200)return json(res,400,{error:'A valid Idempotency-Key is required'});
  let body;
  try{body=await jsonBody(req);}catch{return json(res,400,{error:'A valid JSON body is required'});}
  if(!validateGinseInput(body))return json(res,400,{error:'count must be an integer from 1 to 8 and is the only accepted field'});
  await mkdir(ginseDataDir,{recursive:true});
  const fingerprint=sha256(canonical(body));
  const recordPath=join(ginseDataDir,`${sha256(idempotencyKey)}.json`);
  let record,replayed=false;
  try{
    const handle=await open(recordPath,'wx',0o600);
    record={fingerprint,provider_operation_id:`dice_${randomUUID()}`,seed:randomBytes(32).toString('hex')};
    await handle.writeFile(JSON.stringify(record));await handle.sync();await handle.close();
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    record=JSON.parse(await readFile(recordPath,'utf8'));replayed=true;
    if(record.fingerprint!==fingerprint)return json(res,409,{error:'Idempotency-Key was already used with different input'});
  }
  if(!record.output){
    const values=diceFromSeed(record.seed,body.count);
    const result={diceType:'d6',values,count:values.length};
    record.output={...result,proof:sha256(`${record.provider_operation_id}:${canonical(result)}`)};
    const temp=`${recordPath}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(record),{mode:0o600});await rename(temp,recordPath);
  }
  return json(res,200,{status:'succeeded',provider_operation_id:record.provider_operation_id,replayed,output:record.output});
}
async function serveFile(req,res){const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const requested=pathname==='/'?'index.html':pathname.slice(1);const safe=normalize(requested).replace(/^(\.\.(\/|\\|$))+/,'');const file=join(root,safe);if(!file.startsWith(root))return json(res,404,{error:'Introuvable'});try{if(!(await stat(file)).isFile())throw new Error();res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(await readFile(file));}catch{json(res,404,{error:'Introuvable'});}}

export const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type, authorization'});return res.end();}
  if(url.pathname==='/run'&&req.method==='POST'){
    try{return await ginseRun(req,res);}catch(error){console.error(error);return json(res,500,{error:'The dice roll could not be persisted'});}
  }
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
