/**
 * Registers the Telegram webhook for the deployed Worker.
 * Usage: npm run set-webhook
 * - TELEGRAM_BOT_TOKEN: from env, otherwise asked for (input hidden)
 * - TELEGRAM_WEBHOOK_SECRET: from env, otherwise from the git-ignored .deploy.secrets
 * - WORKER_URL: from env, otherwise the workers.dev URL of this project
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      // print only the prompt and line breaks, never the typed characters
      if (s.includes(question) || s === '\r\n' || s === '\n') out.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function fromDeploySecrets(key: string): string | undefined {
  if (!existsSync('.deploy.secrets')) return undefined;
  const line = readFileSync('.deploy.secrets', 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

const token = process.env.TELEGRAM_BOT_TOKEN || (await askHidden('Bot-Token von BotFather einfügen (Eingabe unsichtbar): '));
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || fromDeploySecrets('TELEGRAM_WEBHOOK_SECRET');
const workerUrl = (process.env.WORKER_URL || 'https://btc-telegram-escrow.cornelis-coppeneur.workers.dev').replace(/\/+$/, '');

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
