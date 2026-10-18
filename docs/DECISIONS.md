# Entscheidungen (ADR-Kurzform)

## D1 – Bitcoin-Bibliothek: @scure/btc-signer
**Kontext:** Vergleich bitcoinjs-lib vs. @scure/btc-signer.
**Entscheidung:** @scure/btc-signer in Produktion, bitcoinjs-lib nur als Test-Gegenprüfung.
**Begründung:** keine nativen/WASM-Module (bitcoinjs braucht externe ECC-Lib), kleiner, Workers-kompatibel, PSBT-Kombination und Finalisierung eingebaut, `preimageWitnessV0` öffentlich für eigene Signaturprüfung.
**Nachweis:** `tests/unit/multisig.test.ts` (gleiche Adresse/Script wie bitcoinjs), `tests/unit/psbt.test.ts` (bitcoinjs validiert unsere Signaturen, finalisiert zur gleichen txid; von bitcoinjs finalisierte PSBT wird akzeptiert), `scripts/verify-signet.ts` (Live-Signet, nur lesend).

## D2 – Schlüssel: BIP-48-Account-xpub mit Key-Origin
Nur `[fp/48h/<coin>h/<konto>h/2h]tpub…` (bzw. Vpub, wird zu tpub normalisiert). Escrow-Adresse = `/0/0`. Gründe: Wallets können die PSBT über `bip32Derivation` zuordnen; Descriptor ist importierbar; einheitlicher Pfad verhindert unsichere Ableitungen. Ein xpub darf global nur **einmal** verwendet werden; gleiche Master-Fingerprints in einem Handel sind verboten.

## D3 – Script: `wsh(sortedmulti(2,…))`
BIP-67-Sortierung → Ergebnis unabhängig von der Registrierungsreihenfolge; jede Partei kann die Adresse reproduzieren.

## D4 – Funding-Policy
Summe aller UTXOs der (pro Handel eindeutigen) Adresse: `<` Betrag → warten; `=` Betrag und alle ≥ N Bestätigungen → FUNDED; `>` Betrag → NEEDS_REVIEW. 0-conf nie final. Keine automatische Rückerstattung von Überzahlungen.

## D5 – Gebührenpolicy (v3)
Der Käufer zahlt **eine Summe an eine Adresse**: Handelsbetrag + Servicegebühr (bps vom Betrag, mindestens 546 sat) ins Treuhand-Konto. Jede Auszahlung (Release und Refund) enthält die Gebühr als eigenen Output an `COMMISSION_ADDRESS`; nicht erstattbar. Minerfee trägt der Empfänger. Grenzen: `MAX_FEE_RATE_SAT_VB`, `MAX_FEE_PERCENT`. Restrisiko: Käufer + Verkäufer (2 von 3) können gemeinsam am Bot vorbei auszahlen → der Poller erkennt das, sperrt beide und meldet es dem Betreiber. Eine getrennte Vorab-Gebühr an eine zweite Adresse wurde verworfen (Kundenwunsch: nur eine Zahlung). Die DB-Spalten `fee_index`, `fee_address`, `fee_paid_at` aus Migration 0003 sind dadurch ungenutzt (SQLite entfernt Spalten nicht sauber).

## D12 – Betreiber-Modus
`OPERATOR_TELEGRAM_ID` + `OPERATOR_ARBITER_KEY`: der Betreiber ist automatisch Schlichter jedes Handels. Zustimmung, Schlüssel (öffentlich) und Adressprüfung erledigt der Bot; der Betreiber signiert nur nach Streitfall-Entscheidungen mit eigener Wallet. Sein Schlüssel wird in allen Handeln wiederverwendet (Ausnahme von der xpub-Einmaligkeit).

## D6 – Mainnet-Sperre mit zwei Schaltern
`BITCOIN_NETWORK=mainnet` allein startet nicht. Zusätzlich `ALLOW_MAINNET=true` **und** `MAINNET_RELEASE_CONFIRMATION` mit fester Phrase (siehe MAINNET-CHECKLIST.md).

## D7 – Tests in Node statt `@cloudflare/vitest-pool-workers`
Die aktuelle pool-workers-Version pinnt eine ältere Wrangler- und eine Alpha-Miniflare-Version. Stattdessen: Vitest in Node mit D1-Ersatz auf `node:sqlite` (gleiches SQLite-Dialekt) + Smoke-Test in echter workerd-Runtime per `wrangler dev`. Fund aus dem Smoke-Test: workerd lehnt Nicht-Handler-Exports im Entry ab → `src/app.ts` abgetrennt.

## D8 – Zweiter Provider
Primär mempool.space (Signet), sekundär blockstream.info. Bestätigte UTXOs, Tx-Status und Outspends werden verglichen; Abweichung → `NEEDS_REVIEW`. Broadcast an beide.

## D9 – PSBT-Austausch über Telegram
PSBT als Datei (.psbt) und, wenn kurz genug, zusätzlich als Base64-Text. Import als Datei oder Text, nur innerhalb einer explizit gestarteten Upload-Session (Button), damit die Zuordnung zur Session eindeutig ist. Jede Datei wird vollständig neu validiert.

## D10 – Senden manuell (Standard)
`ENABLE_AUTOMATIC_BROADCAST=false`: nach 2 Signaturen sendet eine berechtigte Partei per Button. Mit `true` sendet der Cron.

## D11 – Handelsbedingungen unveränderlich
Keine Bearbeitung nach Erstellung; bei Änderungswunsch abbrechen und neu anlegen. Einfach und manipulationssicher.
