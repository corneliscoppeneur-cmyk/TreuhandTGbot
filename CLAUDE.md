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
- [x] Bot-Token rotiert (2026-10-18), neues nur als Cloudflare-Secret; token infos.txt im Papierkorb
- [x] Cloudflare: D1, Secrets, Deploy, Webhook (2026-10-18) – https://btc-telegram-escrow.cornelis-coppeneur.workers.dev
- [x] Betreiber-Modus aktiv: Schlichter-Key cf1d1361 (Sparrow „Betreiber-Schlichter“), Gebührenadresse tb1qpk4z…e300 (Sparrow „Betreiber-Gebuehren“), 3 % Gebühr
- [x] Echter On-Chain-Durchlauf (2026-10-18, Mutinynet): Überzahlung → NEEDS_REVIEW ✅; Release mit 3 % Gebühr → COMPLETE ✅ (txid 956b3847…52b8). Siehe docs/SIGNET-RUNBOOK.md
- [ ] Wallet-Test (Sparrow zuerst) → `docs/WALLET-COMPATIBILITY.md` ausfüllen; ggf. `PSBT_GLOBAL_XPUB` ergänzen
- [ ] Echte Worker-CPU-Zeit in Workers Logs prüfen; bei `exceededCpu` Workers Paid
- [ ] Admin-Befehl zum Auflösen von `NEEDS_REVIEW` mit Audit (bisher manuell per D1)
- [ ] Optional: RBF/CPFP für hängende Auszahlungen
- [ ] Vor Mainnet: Audit, Recht (`docs/LEGAL-CHECKLIST.md`), `docs/MAINNET-CHECKLIST.md`
