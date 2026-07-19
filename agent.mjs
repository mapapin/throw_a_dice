import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function parseCount(argv){
  const position=argv.findIndex(value=>value==='--count'||value==='-c');
  const raw=position===-1?'1':argv[position+1];
  const count=Number(raw);
  if(!Number.isInteger(count)||count<1||count>8)throw new Error('--count doit être un entier compris entre 1 et 8');
  return count;
}

function waitForService(child,timeoutMs=45_000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Le lien téléphone n'a pas été créé à temps")),timeoutMs);
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      process.stderr.write(`${line}\n`);
      if(line.startsWith('SERVICE_ERROR ')){
        clearTimeout(timer);
        try{reject(new Error(JSON.parse(line.slice('SERVICE_ERROR '.length)).error));}catch(error){reject(error);}
        return;
      }
      if(!line.startsWith('SERVICE_READY '))return;
      clearTimeout(timer);
      try{resolve(JSON.parse(line.slice('SERVICE_READY '.length)));}catch(error){reject(error);}
    });
    child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Le service s'est arrêté (code ${code})`));});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}

function build(){
  return new Promise((resolve,reject)=>{
    const command=process.platform==='win32'?'npm.cmd':'npm';
    const child=spawn(command,['run','build'],{cwd:new URL('.',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>process.stderr.write(chunk));
    child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(`La compilation a échoué (code ${code})`)));
  });
}

const count=parseCount(process.argv.slice(2));
if(!process.env.DISCORD_WEBHOOK_URL)throw new Error('DISCORD_WEBHOOK_URL est requise pour prévenir le serveur Discord');
await build();
const child=spawn(process.execPath,['phone.mjs'],{cwd:new URL('.',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']});
let stopping=false;
function stop(){if(stopping)return;stopping=true;child.kill('SIGTERM');}
process.once('SIGINT',()=>{stop();process.exitCode=130;});
process.once('SIGTERM',stop);

try{
  const {port}=await waitForService(child);
  const headers={'content-type':'application/json'};
  if(process.env.API_KEY)headers.authorization=`Bearer ${process.env.API_KEY}`;
  const response=await fetch(`http://127.0.0.1:${port}/api/roll/wait`,{method:'POST',headers,body:JSON.stringify({diceType:'d6',count,timeoutMs:60_000})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||`Le lancer a échoué (${response.status})`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}catch(error){
  console.error(`throw-a-dice: ${error.message}`);
  process.exitCode=1;
}finally{stop();}
