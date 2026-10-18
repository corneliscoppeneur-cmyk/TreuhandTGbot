# Mainnet-Freigabe

Mainnet ist im Code gesperrt. Start mit `BITCOIN_NETWORK=mainnet` gelingt **nur**, wenn zusätzlich
`ALLOW_MAINNET=true` **und** `MAINNET_RELEASE_CONFIRMATION=I-HAVE-COMPLETED-THE-MAINNET-CHECKLIST-AND-AUDIT` gesetzt sind.
Diese Phrase erst setzen, wenn **alle** Punkte erfüllt und schriftlich dokumentiert sind.

## Technik
- [ ] Alle automatisierten Tests grün (CI) auf dem freizugebenden Commit
- [ ] Mindestens zwei Wallets nach WALLET-COMPATIBILITY.md vollständig auf Signet nachgewiesen (Release, Refund, Schlichtung)
- [ ] Echte Signet-Ende-zu-Ende-Transaktionen mit txids dokumentiert
- [ ] Worker-CPU-Zeiten gemessen; bei > 10 ms Workers Paid aktiv
- [ ] `MIN_CONFIRMATIONS_MAINNET` ≥ 3 festgelegt, `MAX_FEE_*` für Mainnet angepasst
- [ ] `COMMISSION_ADDRESS` = Mainnet-Adresse einer extern verwalteten Betreiber-Wallet
- [ ] Mainnet-Esplora-URLs (zwei unabhängige Provider)
- [ ] Separate D1-Datenbank für Mainnet
- [ ] Backup/Restore von D1 getestet (Time Travel)
- [ ] Incident-Response geübt

## Sicherheit
- [ ] Unabhängiger Sicherheits-Audit des Codes (extern, schriftlich)
- [ ] Alle hohen Audit-Befunde behoben
- [ ] Secrets neu erzeugt (Bot-Token, Webhook-Secret, HMAC-Secret)
- [ ] Zugriff auf Cloudflare-/Telegram-Konten mit 2FA

## Recht und Organisation (siehe LEGAL-CHECKLIST.md)
- [ ] Rechtliche Einordnung geprüft (Anwalt)
- [ ] Nutzungsbedingungen und Datenschutzerklärung veröffentlicht
- [ ] Schlichter-Auswahl und -Regeln dokumentiert

Freigabe durch: ____________  Datum: ________  Commit: ________
