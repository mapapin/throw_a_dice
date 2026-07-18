import { networkInterfaces } from 'node:os';
import { Tunnel } from 'cloudflared';
import { server } from './server.mjs';

const preferredPort=Number(process.env.PORT||3000);
const addresses=[];
for(const interfaces of Object.values(networkInterfaces()))for(const address of interfaces||[]){if(address.family==='IPv4'&&!address.internal)addresses.push(address.address);}

function listen(port){
  const onError=error=>{server.off('listening',onListening);if(error.code==='EADDRINUSE'&&!process.env.PORT){console.log(`Le port ${port} est déjà utilisé, essai sur ${port+1}…`);listen(port+1);}else throw error;};
  const onListening=()=>{server.off('error',onError);launch(port);};
  server.once('error',onError);server.once('listening',onListening);server.listen(port,'0.0.0.0');
}

async function launch(port){
  console.log('\n🎲 Ginse Dice est lancé.');
  console.log(`   Ordinateur : http://localhost:${port}/watch.html`);
  for(const address of addresses)console.log(`   Réseau local : http://${address}:${port}`);
  console.log('\n⏳ Création du lien HTTPS pour le téléphone…');
  try{
    const tunnel=Tunnel.quick(`http://localhost:${port}`);
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Cloudflare ne répond pas')),30_000);
      tunnel.once('url',value=>{clearTimeout(timer);resolve(value);});
      tunnel.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('OUVRE CE LIEN SUR TON TÉLÉPHONE :');
    console.log(url);
    console.log('═══════════════════════════════════════════════════════');
    console.log(`\nRégie live : ${url}/watch.html`);
    console.log('Garde ce terminal ouvert pendant la démo.\n');
    tunnel.on('exit',()=>console.log('Le tunnel téléphone a été fermé.'));
  }catch(error){
    console.error('\nImpossible de créer le lien HTTPS :',error.message);
    console.error('Le serveur local reste disponible. Relance `npm start` pour réessayer.\n');
  }
}

listen(preferredPort);

function shutdown(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),2_000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
