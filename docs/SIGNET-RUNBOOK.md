# Signet-Runbook (manueller Ende-zu-Ende-Test)

**Status:** noch nicht durchgeführt. Benötigt: echtes Bot-Token, Cloudflare-Deployment, drei Signet-Wallets, Signet-Coins (Faucet).

## Vorbereitung
1. Deployment nach DEPLOYMENT.md.
2. Drei Telegram-Konten (Käufer, Verkäufer, Schlichter), drei Wallets (Sparrow empfohlen, Netzwerk „Signet“).
3. In jeder Wallet: neuer Multisig-Keystore `m/48'/1'/0'/2'` → `[fingerprint/48h/1h/0h/2h]tpub…` notieren.

## Ablauf Release
1. Käufer: `/newtrade` → z. B. 0,0005 BTC → Rolle Käufer → Erstellen.
2. Einladungen Verkäufer + Schlichter; Link und Code getrennt weitergeben.
3. Alle: Bedingungen akzeptieren.
4. Alle: Schlüssel registrieren.
5. Alle: Descriptor in Wallet importieren, Adresse vergleichen, „Adresse stimmt überein“.
6. Käufer: exakten Betrag per Faucet/Wallet senden.
7. Warten auf FUNDED (Cron alle 5 min, 1 Bestätigung).
8. Verkäufer: „Lieferung erfolgt“. Käufer: „Freigabe an Verkäufer“.
9. Verkäufer: Empfangsadresse senden.
10. Käufer + Verkäufer: PSBT-Datei in Wallet laden, **Outputs prüfen**, signieren, Datei zurück an Bot.
11. „Transaktion senden“ → txid im Explorer (mempool.space/signet) prüfen → COMPLETE.

## Varianten
- Refund mit Zustimmung Verkäufer (Käufer + Verkäufer).
- Streitfall → Schlichter → Refund (Käufer + Schlichter).
- Streitfall → Schlichter → Release (Verkäufer + Schlichter).
- Negativtests: nur eine Signatur; PSBT aus falscher Session; Datei manipuliert.

## Ergebnisprotokoll
| Datum | Variante | Wallets | Funding-txid | Payout-txid | Ergebnis |
|---|---|---|---|---|---|
| | | | | | |
