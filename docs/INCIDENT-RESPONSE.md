# Incident Response

Grundsatz: Der Bot hält kein Geld. Im Notfall bleibt BTC in der Multisig; zwei Parteien können jederzeit mit ihren Wallets und dem Descriptor auszahlen – auch ohne Bot.

| Vorfall | Sofortmaßnahme | Danach |
|---|---|---|
| Bot-Token geleakt | BotFather `/revoke`, neues Token per `wrangler secret put TELEGRAM_BOT_TOKEN`, Webhook neu setzen | Logs prüfen, Nutzer informieren |
| Webhook-Secret geleakt | neues Secret setzen + `npm run set-webhook` | – |
| HMAC-Secret geleakt | neues Secret → alle offenen Einladungen werden ungültig (Hash passt nicht mehr) | neue Einladungen erstellen |
| Cloudflare-Konto kompromittiert | Zugang sperren, Worker deaktivieren (`wrangler delete` oder Route entfernen) | Parteien warnen: keine PSBTs aus dem Bot signieren, bis geklärt; Auszahlung extern mit Descriptor |
| Verdacht manipulierte PSBT | Teilnehmer warnen: nur signieren, wenn Wallet exakt die vereinbarten Outputs zeigt | Session prüfen (`psbt_sessions`, `audit_events`) |
| Provider liefert Widersprüche | Trades gehen automatisch in NEEDS_REVIEW | Provider-Status prüfen, ggf. URL tauschen |
| D1-Ausfall | nichts tun; Bot ändert keinen Finanzstatus | nach Wiederherstellung Cron prüfen |
| Fehlerhaftes Deployment | `wrangler rollback` auf vorige Version | Ursache in CI ergänzen |
| Datenleck D1 | Schadensbewertung (enthält nur öffentliche Schlüssel, Telegram-IDs, Handelsdaten) | DSGVO-Meldepflicht prüfen (72 h) |

## NEEDS_REVIEW bearbeiten
1. `review_reason` und `audit_events` des Handels lesen.
2. Blockchain im Explorer gegenprüfen (Adresse aus `multisig_configs`).
3. Mit Parteien und Schlichter klären. Statuswechsel aus NEEDS_REVIEW erfolgen in v1 nur per manuellem, dokumentiertem D1-Eingriff durch den Betreiber (geplant: Admin-Befehl mit Audit).
