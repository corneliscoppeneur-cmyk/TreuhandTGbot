# CLAUDE.md – Treuhandbot

Nichtverwahrender BTC-Treuhand-Bot (Telegram, Cloudflare Workers + D1, Signet). Repo: https://github.com/corneliscoppeneur-cmyk/TreuhandTGbot

## Projektregeln
- Abweichung von der Ordner-Regel „PostgreSQL/Docker“: Vorgabe des Auftrags ist Cloudflare Workers + D1, ohne VPS (siehe `docs/DECISIONS.md`).
- Niemals private Schlüssel, Seeds oder Kundengelder serverseitig. Mainnet bleibt gesperrt.
- `token infos.txt` und `treuhand vorhaben.txt` sind lokal und git-ignoriert. Nicht committen.
- Vor Commit: `npm run check`.
- Node-Skripte laufen mit Type-Stripping: keine Parameter-Properties/Enums (`erasableSyntaxOnly`).
- Worker-Entry `src/index.ts` darf nur Handler exportieren (workerd).

## Live-ToDos
- [ ] Bot-Token bei BotFather `/revoke`, neuen Token nur als Cloudflare-Secret setzen; danach `token infos.txt` löschen (nur nach Freigabe)
- [ ] Cloudflare: `wrangler login`, `d1 create`, `database_id` + `COMMISSION_ADDRESS` + `TELEGRAM_BOT_USERNAME` in `wrangler.jsonc`, Secrets, Deploy, `set-webhook`
- [ ] Signet-Ende-zu-Ende nach `docs/SIGNET-RUNBOOK.md` (Release, Refund, Schlichtung) mit Faucet-Coins
- [ ] Wallet-Test (Sparrow zuerst) → `docs/WALLET-COMPATIBILITY.md` ausfüllen; ggf. `PSBT_GLOBAL_XPUB` ergänzen
- [ ] Echte Worker-CPU-Zeit in Workers Logs prüfen; bei `exceededCpu` Workers Paid
- [ ] Admin-Befehl zum Auflösen von `NEEDS_REVIEW` mit Audit (bisher manuell per D1)
- [ ] Optional: RBF/CPFP für hängende Auszahlungen
- [ ] Vor Mainnet: Audit, Recht (`docs/LEGAL-CHECKLIST.md`), `docs/MAINNET-CHECKLIST.md`
