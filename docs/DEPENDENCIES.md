# Abhängigkeiten

Stand: 2026-10-18. Versionen exakt gepinnt (`package.json`), `npm audit --omit=dev`: 0 Schwachstellen.

## Laufzeit

| Paket | Version | Lizenz | Zweck | Bewertung |
|---|---|---|---|---|
| `grammy` | 1.46.0 | MIT | Telegram-Bot-Framework | Workers-kompatibel (Web-Build), aktiv gepflegt. Wird mit `client.fetch = globalThis.fetch` betrieben. |
| `@scure/btc-signer` | 2.4.1 | MIT | P2WSH, P2MS, PSBT (BIP-174), Finalisierung | Reines TS, keine nativen Module, Abhängigkeiten nur noble/scure. Gewählt (siehe DECISIONS.md). |
| `@scure/bip32` | 2.4.0 | MIT | tpub-Parsing, öffentliche Ableitung | gleiche Familie |
| `@scure/base` | 2.4.0 | MIT | base58check, base64, hex | |
| `@noble/curves` | 2.4.0 | MIT | secp256k1-Signaturprüfung (ECDSA, low-S) | |
| `@noble/hashes` | 2.4.0 | MIT | SHA-256, HMAC | |

## Nur Entwicklung / Tests

| Paket | Zweck |
|---|---|
| `bitcoinjs-lib` 7.0.4 + `tiny-secp256k1` | **Unabhängige Gegenprüfung** in Tests: gleiche Adresse/Script, Signaturen gültig, gleiche txid nach Finalisierung |
| `wrangler` 4.151.1 | Build, lokale D1, Deploy |
| `vitest` 4.1.12 | Tests (Node, D1-Ersatz auf `node:sqlite`) |
| `typescript` 5.9.3, `eslint`, `typescript-eslint`, `prettier` | Qualität |
| `@cloudflare/workers-types` | Typen |

## Geprüfte, nicht übernommene Projekte

- `formysister/telegram-escrow-bot`, `Pycomet-zz/escrow-service-bot`: setzen Betreiber-Wallets bzw. serverseitige Schlüssel voraus. **Kein Code übernommen.** Eine Detailprüfung des aktuellen Repository-Inhalts wurde in dieser Phase nicht durchgeführt (Websuche war im Arbeitsumfeld nicht verfügbar); die Ablehnung beruht auf dem Recherchebericht und dem Grundsatz „keine Betreiber-Private-Keys“.
- `cupcakearmy/cryptgeon`: wird nur als externer Dienst verlinkt, nicht eingebunden.

## Bundle

`wrangler deploy --dry-run`: 616 KiB, gzip 148 KiB (Limit Free: 3 MB).
