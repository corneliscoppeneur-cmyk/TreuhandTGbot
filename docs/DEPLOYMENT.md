# Deployment (Cloudflare, Signet)

Kostenlose `workers.dev`-Domain genügt. Keine eigene Domain nötig.

## 1. Voraussetzungen
- Node.js ≥ 22.5 (getestet: 24.11), Git
- Cloudflare-Konto (Free genügt zum Start; siehe COSTS.md)
- `npm ci`

## 2. Telegram-Bot (BotFather)
1. `/newbot` → Name und Username → Token erhalten. **Token nie in Dateien im Repo speichern.**
2. Optional `/setprivacy` → Enable (Bot liest in Gruppen nur Befehle).
3. Bei geleaktem Token: `/revoke`.

## 3. Cloudflare vorbereiten
```bash
npx wrangler login
```

## 4. D1 erstellen
```bash
npx wrangler d1 create escrow
```
Die ausgegebene `database_id` in `wrangler.jsonc` eintragen.

## 5. Migrationen
```bash
npm run db:migrate:remote
```

## 6. Worker konfigurieren
In `wrangler.jsonc` → `vars`: `TELEGRAM_BOT_USERNAME`, `COMMISSION_ADDRESS` (eigene, extern verwaltete Signet-Adresse), ggf. `ADMIN_TELEGRAM_IDS`. Prüfen:
```bash
npm run validate-config
```

## 7. Secrets
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put INVITE_HMAC_SECRET
```
Secrets zufällig erzeugen, z. B. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## 8. Deploy / Webhook-URL
```bash
npm run deploy
```
URL: `https://btc-telegram-escrow.<account>.workers.dev`. Test: `GET /health`.

## 9. Telegram-Webhook registrieren
```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_URL=https://... npm run set-webhook
```

## 10. Scheduled Worker
Cron `*/5 * * * *` ist in `wrangler.jsonc` definiert und wird beim Deploy aktiv. Dashboard → Worker → Triggers prüfen.

## 11. Signet-Konfiguration prüfen
`/status` im Bot → „Netzwerk: signet, Mainnet: gesperrt“. `npm run verify-signet`.

## 12. Testhandel
Siehe SIGNET-RUNBOOK.md.

## 13. Logging
Dashboard → Worker → Logs (Observability ist aktiviert). `npx wrangler tail` live. CPU-Zeit pro Aufruf dort ablesen.

## 14. API-Fehler simulieren
`ESPLORA_PRIMARY_URL` testweise auf eine ungültige https-URL setzen → Cron loggt Fehler, Trades bleiben unverändert, `scheduled_jobs.failures` steigt. Danach zurücksetzen.

## 15. Backup und Wiederherstellung
D1 Time Travel (30 Tage):
```bash
npx wrangler d1 time-travel info escrow
npx wrangler d1 export escrow --remote --output backup.sql
```
Wiederherstellung: `npx wrangler d1 time-travel restore escrow --timestamp <ISO>`. `backup.sql` nicht ins Repo.

## 16. Rollback
```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```
Migrationen sind nur vorwärts gerichtet; Schemaänderungen immer additiv planen.
