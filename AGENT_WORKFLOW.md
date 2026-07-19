# AI agent workflow

This repository exposes one command for the complete human-in-the-loop dice roll:

```bash
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…/…' npm run throw -- --count 2
```

`DISCORD_WEBHOOK_URL` is the webhook for the target Discord channel. Keep it in the agent's secret/environment configuration; never commit it. The Discord webhook must be allowed to post in that channel.

## What the command does

1. Builds and starts the camera service.
2. Creates a temporary HTTPS Cloudflare URL.
3. Posts the following message through the configured Discord webhook:

   ```text
   Throw a dice now! 🎲
   https://….trycloudflare.com
   ```

4. Opens a pending request for 1–8 six-sided dice and waits up to 60 seconds.
5. The human taps the Discord link on their smartphone, allows the camera, and throws the requested number of dice in view.
6. The phone detects a stable result and submits it to the service.
7. The command prints one JSON result to stdout, then shuts down the service and tunnel. Service logs are written to stderr so an agent can safely parse stdout.

Example result:

```json
{"id":"…","diceType":"d6","values":[4,2],"count":2,"source":"live-camera","capturedAt":"2026-07-18T12:00:00.000Z"}
```

The agent should return `values` to the user in a friendly sentence. A non-zero exit means the tunnel, Discord notification, timeout, or dice request failed; report the error from stderr. Only one roll may be pending at a time.

## Agent instruction

When the user asks to throw dice, determine the requested count (default to one), run `npm run throw -- --count N`, wait for completion, parse the JSON line on stdout, and return the detected values. Do not invent a result if the command times out.

For a protected service, also provide `API_KEY` in the environment. For normal interactive development, `npm start` still launches the service and sends the Discord notification when `DISCORD_WEBHOOK_URL` is configured.
