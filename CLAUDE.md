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
- [ ] NACH erfolgreichem Signet-Test: Bot-Token bei BotFather `/revoke`, neues Token per `wrangler secret put TELEGRAM_BOT_TOKEN` + `npm run set-webhook`; danach `token infos.txt` löschen (nur nach Freigabe)
- [x] Cloudflare: D1, Secrets, Deploy, Webhook (2026-10-18) – https://btc-telegram-escrow.cornelis-coppeneur.workers.dev
- [x] Betreiber-Modus aktiv: Schlichter-Key cf1d1361 (Sparrow „Betreiber-Schlichter“), Gebührenadresse tb1qpk4z…e300 (Sparrow „Betreiber-Gebuehren“), 3 % Gebühr
- [ ] Echter On-Chain-Durchlauf: Testhandel bis READY_TO_FUND klappt live (`npm run e2e -- setup`). Offen: Einzahlung mit Signet-Coins (ca. 11.000 sat), dann `npm run e2e -- tick` / `payout`. Faucets: Login/Captcha nötig (nur Nutzer). Coins ggf. an tb1qa5ta3kvffldjau5f0hpxpxrsv8v9u6rwdfclqs
- [ ] Wallet-Test (Sparrow zuerst) → `docs/WALLET-COMPATIBILITY.md` ausfüllen; ggf. `PSBT_GLOBAL_XPUB` ergänzen
- [ ] Echte Worker-CPU-Zeit in Workers Logs prüfen; bei `exceededCpu` Workers Paid
- [ ] Admin-Befehl zum Auflösen von `NEEDS_REVIEW` mit Audit (bisher manuell per D1)
- [ ] Optional: RBF/CPFP für hängende Auszahlungen
- [ ] Vor Mainnet: Audit, Recht (`docs/LEGAL-CHECKLIST.md`), `docs/MAINNET-CHECKLIST.md`
