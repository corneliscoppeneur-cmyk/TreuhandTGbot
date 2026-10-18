# BTC-Treuhand-Bot für Telegram (Signet)

Nichtverwahrender Bitcoin-Treuhand-Koordinator: Käufer, Verkäufer und ein unabhängiger Schlichter halten je einen Schlüssel einer **2-von-3-P2WSH-Multisig**. Der Bot verwahrt **keine Coins und keine privaten Schlüssel**; er koordiniert Einladungen, Bedingungen, Adressprüfung, Zahlungserkennung und PSBTs. Läuft komplett auf Cloudflare Workers + D1, ohne VPS und ohne eigenen Bitcoin-Node.

> ⚠️ **Haftungsausschluss.** Experimentelle Software, nur für **Bitcoin Signet** (Testnetz, Coins ohne Wert). Mainnet ist im Code gesperrt und darf erst nach unabhängigem Sicherheits-Audit, erfolgreichen Wallet-Tests und rechtlicher Prüfung freigegeben werden (`docs/MAINNET-CHECKLIST.md`). Keine Gewährleistung, keine Rechts- oder Finanzberatung. Der Bot kann BTC on-chain **nicht einfrieren oder zurückholen**; Käufer und Verkäufer können gemeinsam ohne den Bot signieren (die Provision ist daher nicht technisch garantiert).

## Funktionen
- Deutschsprachiger Telegram-Ablauf (Befehle + Inline-Buttons), Webhook statt Polling
- Mehrere Teilnehmer: Käufer, Verkäufer, Schlichter, Vermittler, Beobachter; zentrale Permission-Engine
- Einladungen per Deep-Link + separatem Zugangscode (HMAC, Ablauf, Kontobindung, Rate-Limit, Sperre)
- Bedingungen als Hash-Snapshot, von allen Signierern akzeptiert
- BIP-48-Schlüssel (tpub mit Key-Origin), deterministische `wsh(sortedmulti(2,…))`, importierbarer Descriptor
- Zahlungserkennung per Cron über zwei Esplora-Provider mit Gegenprüfung, Bestätigungen, Reorg-Erkennung
- PSBT (BIP-174) mit Provision als eigenem Output, vollständige Re-Validierung jeder importierten PSBT
- Streitfall → Schlichtung → Release/Refund; Audit-Log; Löschfristen; Cryptgeon-Hinweise; Support-Link

## Schnellstart (lokal)
```bash
npm ci
npm run check            # Typecheck, Lint, Format, Tests, Worker-Build
npm run verify-signet    # Live-Signet-Check, nur lesend
```
Lokaler Worker: `.dev.vars` anlegen (siehe `.env.example`), dann `npm run db:migrate:local` und `npm run dev`.

Deployment: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) · Testablauf: [`docs/SIGNET-RUNBOOK.md`](docs/SIGNET-RUNBOOK.md)

## Teststand
104 automatisierte Tests (Unit, Integration über die echten Telegram-Handler, Security, Fehlerfälle), u. a. alle Signaturkombinationen, manipulierte PSBTs, Gegenprüfung mit bitcoinjs-lib. Smoke-Test in der echten workerd-Runtime. **Noch nicht durchgeführt:** echter Telegram-Betrieb, echte Signet-Transaktionen, Test mit GUI-Wallets ([`docs/WALLET-COMPATIBILITY.md`](docs/WALLET-COMPATIBILITY.md)).

## Dokumentation
[Architektur](docs/ARCHITECTURE.md) · [Entscheidungen](docs/DECISIONS.md) · [Abhängigkeiten](docs/DEPENDENCIES.md) · [Sicherheit](docs/SECURITY.md) · [Bedrohungsmodell](docs/THREAT-MODEL.md) · [Abläufe](docs/USER-FLOWS.md) · [Datenschutz](docs/PRIVACY.md) · [Kosten](docs/COSTS.md) · [Limits](docs/API-LIMITS.md) · [Incident Response](docs/INCIDENT-RESPONSE.md) · [Mainnet-Checkliste](docs/MAINNET-CHECKLIST.md) · [Rechtliches](docs/LEGAL-CHECKLIST.md)

Support: https://t.me/GruppennetzwerkKontakt_bot

Lizenz: MIT
