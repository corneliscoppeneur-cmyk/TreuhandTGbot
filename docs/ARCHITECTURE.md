# Architektur

## Überblick

```
Telegram ──webhook──▶ Cloudflare Worker (fetch) ──▶ D1
                         │
Cron */5 ──────────────▶ Worker (scheduled) ──▶ Esplora (primär + sekundär) ──▶ D1
                         │
Externe Wallets ◀──PSBT──┘ (Signatur nur extern; Bot validiert, kombiniert, sendet)
```

Ein einziger Worker bedient Webhook und Cron. Kein VPS, kein eigener Node, kein Long Polling.

## Prinzip: Koordinator, keine Wallet

- Das Geld liegt in einer **2-von-3-P2WSH-Multisig-Adresse** (Käufer, Verkäufer, Schlichter).
- Der Bot speichert nur **öffentliche** Schlüssel (BIP-48-Account-tpub mit Key-Origin).
- Der Bot erzeugt und validiert PSBTs; **signieren können nur die externen Wallets**.
- Keine Variante des Codes kann allein auszahlen. `ENABLE_CUSTODIAL_FEATURES=true` wird beim Start abgelehnt.

## Module

| Pfad | Verantwortung |
|---|---|
| `src/index.ts` | Worker-Entry (nur Handler-Exports, Vorgabe von workerd) |
| `src/app.ts` | Verdrahtung: Config, Provider, Webhook-Auth, Health, Cron |
| `src/config/` | Konstanten, Env-Parsing/-Validierung, Mainnet-Sperre |
| `src/telegram/` | grammY-Bot, Dialoge (D1-State), Keyboards, Texte |
| `src/domain/` | Handel, Zustandsmaschine, Rollen/Permission-Engine, Einladungen, Schlüssel, Auszahlung, Gebühren, Beträge |
| `src/disputes/` | Streitfall, Schlichtung, Entscheidung |
| `src/bitcoin/` | Netzwerke, Key-Parsing, Descriptor (BIP-380), Multisig, Funding-Policy, Gebührenschätzung, PSBT-Bau/-Validierung |
| `src/blockchain/` | Provider-Abstraktion, Esplora-Client, Schema-Validierung, Cross-Check |
| `src/database/` | D1-Schnittstelle, Repository, atomare Transitionen |
| `src/security/` | Zufall, HMAC, Redaction |
| `src/jobs/` | Blockchain-Poller, Cleanup/Löschfristen |
| `migrations/` | versionierte D1-Migrationen |

## Datenfluss eines Handels

1. `/newtrade` → Dialog (Titel, Beschreibung, Betrag, Bedingungen, Rolle, Gebühren) → `INVITING`
2. Einladungen (Deep-Link + separater Zugangscode) → Beitritt → `AGREEMENT` (Snapshot + SHA-256-Hash)
3. Alle drei akzeptieren denselben Hash → `KEY_SETUP`
4. Jede Partei registriert tpub → 3. Schlüssel erzeugt Multisig + Descriptor
5. Alle drei bestätigen die Adresse in der eigenen Wallet → `READY_TO_FUND`, Parameter gesperrt
6. Cron erkennt Einzahlung → `FUNDING_SEEN` → (Bestätigungen) → `FUNDED`
7. Lieferung → Freigabe/Refund → Empfangsadresse → PSBT-Session → `SIGNING`
8. 2 gültige Signaturen → Finalisierung beim Senden → `BROADCAST` → Bestätigung → `COMPLETE`/`REFUNDED`

## Konsistenz

- **Atomare Transitionen:** `transition()` führt ein D1-`batch` (eine Transaktion) aus: bedingtes `UPDATE` (Status + Version), Audit-Event und Folge-Statements. Folge-Statements sind über eine zufällige `last_op`-ID geschützt; eine verlierende parallele Anfrage ändert nichts.
- **Idempotenz:** `processed_telegram_updates` verhindert doppelte Verarbeitung; schlägt die Verarbeitung fehl, wird der Eintrag entfernt, damit Telegram erneut zustellen kann.
- **Eindeutigkeit per Constraint:** eine Person = eine Rolle, eine aktive Signier-Rolle pro Handel, eine Live-PSBT-Session pro Handel, ein offener Streitfall pro Handel, eine xpub nur in einem Handel.

## CPU-Budget (Workers Free: 10 ms)

Gemessen in Node (warm): Ableitung eines Kindschlüssels ≈ 1,5 ms, PSBT-Signaturprüfung ≈ 6 ms, Kombinieren/Finalisieren ≈ 7,5 ms. Deshalb:
- Escrow-Pubkey wird bei jeder Registrierung einzeln abgeleitet (statt 3 auf einmal).
- Finalisierung läuft beim Senden, nicht beim Import der zweiten Signatur.

Echte Worker-CPU-Zeiten sind erst nach Deployment über Workers Logs messbar (siehe `API-LIMITS.md`).
