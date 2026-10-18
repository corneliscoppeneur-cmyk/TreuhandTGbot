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

## D5 – Gebührenpolicy v1
Provision in Basispunkten vom vereinbarten Betrag, eigener Output; Release: `DEFAULT_COMMISSION_BPS`, Refund: `REFUND_COMMISSION_BPS` (Standard 0); Streitfall folgt dem Ergebnis. Minerfee trägt der Empfänger. Grenze: `MAX_FEE_RATE_SAT_VB` und `MAX_FEE_PERCENT`. Provision unter Dust entfällt. Änderung = neue Session.

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
