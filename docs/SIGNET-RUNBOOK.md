# Signet-Runbook (manueller Ende-zu-Ende-Test)

**Status (2026-10-18):** Automatisierter On-Chain-Durchlauf bestanden (Skript `scripts/signet-e2e.ts`, echter Bot-Code lokal, echte Chain Mutinynet-Signet, Käufer/Verkäufer simuliert mit Testschlüsseln). Noch offen: Durchlauf mit GUI-Wallets (Sparrow) und echten Telegram-Konten.

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
| 2026-10-18 | Überzahlung (Faucet schickte 500.000 statt 10.546 sat) | Skript | 23c78afe…bf2d | – | ✅ NEEDS_REVIEW + Admin-Meldung, keine Auszahlung |
| 2026-10-18 | Release (Betreiber-Modus, 3 % Gebühr) | Skript (Testschlüssel) | 138cd1b7…903c | 956b3847ba56ba4f8db9db15633c51ebde9bf3073a425aa1cc9c871735f852b8 | ✅ COMPLETE: 485.081 sat an Verkäufer, 14.563 sat Gebühr an Betreiber, 356 sat Netzwerkgebühr, Mutinynet |
