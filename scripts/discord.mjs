export async function sendDiscordNotification(phoneUrl,{webhookUrl=process.env.DISCORD_WEBHOOK_URL,fetchImpl=fetch}={}){
  if(!webhookUrl){
    console.log('Discord : DISCORD_WEBHOOK_URL absente, notification ignorée.');
    return false;
  }
  let parsed;
  try{parsed=new URL(webhookUrl);}catch{throw new Error('DISCORD_WEBHOOK_URL doit être une URL valide');}
  if(parsed.protocol!=='https:'||!['discord.com','discordapp.com'].includes(parsed.hostname)||!parsed.pathname.startsWith('/api/webhooks/'))throw new Error('DISCORD_WEBHOOK_URL doit être une URL de webhook Discord HTTPS');
  const response=await fetchImpl(webhookUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:`Throw a dice now! 🎲\n${phoneUrl}`})});
  if(!response.ok)throw new Error(`Discord a répondu ${response.status}`);
  console.log('Discord : invitation envoyée.');
  return true;
}
