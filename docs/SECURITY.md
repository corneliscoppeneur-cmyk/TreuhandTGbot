# Sicherheit

## Grundsätze (umgesetzt)

- Keine Verwahrung: keine Betreiber-Escrow-Wallet, keine Kundenschlüssel, keine Seeds, keine serverseitigen Signaturen.
- Private Schlüssel und Seed-Phrasen werden erkannt und abgelehnt, nie gespeichert (Test: `security.test.ts`).
- 2-von-3-P2WSH, BIP-67-sortiert, BIP-174-PSBT, nur `SIGHASH_ALL`, low-S.
- Jede importierte PSBT wird vollständig neu validiert: unsigned tx identisch zur Session, UTXOs/Beträge/Scripts, nur bekannte Signierer, kryptografische Prüfung jeder Signatur gegen selbst berechneten BIP-143-Sighash.
- Zugriffskontrolle serverseitig (`authorize()` + Permission-Matrix). Admins haben keine Signatur- oder Zahlungsrechte.
- Einladungstokens (256 Bit) und Zugangscodes (40 Bit) nur als HMAC-SHA-256 gespeichert.
- Webhook-Secret konstantzeit-geprüft; falsche Konfiguration → 503 (fail closed).
- Mainnet doppelt gesperrt (siehe MAINNET-CHECKLIST.md).
- Log-Redaction für Token, xprv/WIF, Adressen, PSBTs, 64-Hex, Deep-Link-Tokens, Seeds.

## Grenzen (ehrlich)

- Der Bot kann BTC **nicht einfrieren**. Ein Streitfall stoppt nur botseitige Abläufe.
- Käufer und Verkäufer können gemeinsam ohne den Bot signieren (Provision umgehbar).
- Bereits abgegebene Signaturen bleiben on-chain gültig.
- Ob drei Schlüssel wirklich drei unabhängigen Personen gehören, ist technisch nicht beweisbar.
- Telegram-Nachrichten sind nicht Ende-zu-Ende verschlüsselt; deshalb nur öffentliche Daten über den Bot.
- Es fand **keine unabhängige Sicherheitsprüfung** statt. Mainnet bleibt bis dahin gesperrt.

## Verantwortungsvolle Meldung

Sicherheitslücken bitte vertraulich über den Support-Bot melden: https://t.me/GruppennetzwerkKontakt_bot (keine Details öffentlich posten).

## Offene Punkte

- Kein RBF/CPFP bei hängenden Transaktionen (v1).
- Kein externer Wallet-Kompatibilitätstest durchgeführt (siehe WALLET-COMPATIBILITY.md).
- Echte Worker-CPU-Zeit nach Deployment messen.
- `PSBT_GLOBAL_XPUB` wird nicht gesetzt; manche Wallets benötigen ihn ggf. für Multisig-Erkennung (zu testen).
