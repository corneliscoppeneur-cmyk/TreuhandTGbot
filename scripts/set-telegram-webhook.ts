/**
 * Registers the Telegram webhook for the deployed Worker.
 * Usage (values from your environment, never committed):
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_URL=https://<name>.<account>.workers.dev npm run set-webhook
 */
export {};

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const workerUrl = process.env.WORKER_URL?.replace(/\/+$/, '');

if (!token || !secret || !workerUrl) {
  console.error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL');
  process.exit(1);
}
if (!workerUrl.startsWith('https://')) {
  console.error('WORKER_URL must be https');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${workerUrl}/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 10,
  }),
});
const body = (await res.json()) as { ok: boolean; description?: string };
console.log(body.ok ? 'Webhook set.' : `Failed: ${body.description ?? res.status}`);

const commands = [
  ['start', 'Hauptmenü'],
  ['newtrade', 'Neuen Handel erstellen'],
  ['mytrades', 'Meine Handelsfälle'],
  ['trade', 'Handel anzeigen: /trade <ID>'],
  ['invites', 'Einladungen: /invites <ID>'],
  ['disputes', 'Offene Streitfälle'],
  ['fees', 'Gebühren'],
  ['privacy', 'Datenschutz und Cryptgeon'],
  ['support', 'Support'],
  ['status', 'Status'],
  ['help', 'Hilfe und Sicherheit'],
  ['cancel', 'Dialog abbrechen'],
].map(([command, description]) => ({ command, description }));
const r2 = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ commands, scope: { type: 'all_private_chats' } }),
});
console.log(((await r2.json()) as { ok: boolean }).ok ? 'Commands set.' : 'Setting commands failed.');
if (!body.ok) process.exit(1);
