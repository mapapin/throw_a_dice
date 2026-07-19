import test from 'node:test';
import assert from 'node:assert/strict';
import { RollCoordinator, validateRoll } from '../server.mjs';
import { sendDiscordNotification } from '../scripts/discord.mjs';

test('accepte un tirage d6 valide', () => assert.equal(validateRoll({ diceType:'d6', values:[1,6,3] }), null));
test('refuse une face hors limites', () => assert.match(validateRoll({ diceType:'d6', values:[7] }), /comprise/));
test('refuse une liste vide', () => assert.match(validateRoll({ diceType:'d6', values:[] }), /1 à 30/));
test('refuse un type invalide', () => assert.match(validateRoll({ diceType:'coin', values:[1] }), /diceType/));

test('une demande en attente est résolue par le téléphone', async () => {
  const coordinator = new RollCoordinator();
  const { request, promise } = coordinator.create({ count:2 });
  coordinator.complete(request.id, [6, 3]);
  assert.deepEqual((await promise).values, [6, 3]);
  assert.equal(coordinator.request, null);
});

test('refuse un résultat qui ne correspond pas au nombre demandé', () => {
  const coordinator = new RollCoordinator();
  const { request } = coordinator.create({ count:3 });
  assert.throws(() => coordinator.complete(request.id, [2]), /exactement 3/);
  coordinator.cancel(request.id);
});

test('envoie le lien téléphone sur Discord', async () => {
  let request;
  const sent=await sendDiscordNotification('https://dice.example',{webhookUrl:'https://discord.com/api/webhooks/123/token',fetchImpl:async(url,options)=>{request={url,options};return {ok:true,status:204};}});
  assert.equal(sent,true);
  assert.equal(request.url,'https://discord.com/api/webhooks/123/token');
  assert.deepEqual(JSON.parse(request.options.body),{content:'Throw a dice now! 🎲\nhttps://dice.example'});
});

test('ignore Discord lorsque le webhook est absent', async () => {
  assert.equal(await sendDiscordNotification('https://dice.example',{webhookUrl:'',fetchImpl:()=>assert.fail('fetch ne doit pas être appelé')}),false);
});
