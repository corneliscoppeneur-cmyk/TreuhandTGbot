# Wallet-Kompatibilität

**Status: Keine Wallet ist bisher als „unterstützt“ freigegeben.** Eine Wallet gilt erst als unterstützt, wenn der komplette Ablauf unten mit ihr auf Signet nachgewiesen wurde.

## Was bereits nachgewiesen ist (automatisiert)

| Prüfung | Ergebnis | Nachweis |
|---|---|---|
| Adresse/Script identisch zu unabhängiger Implementierung (bitcoinjs-lib) | bestanden | `tests/unit/multisig.test.ts` |
| Signaturen der Test-Signierer von bitcoinjs-lib als gültig erkannt | bestanden | `tests/unit/psbt.test.ts` |
| bitcoinjs-lib finalisiert unsere PSBT zur gleichen txid | bestanden | `tests/unit/psbt.test.ts` |
| Von bitcoinjs-lib finalisierte PSBT wird vom Bot akzeptiert | bestanden | `tests/unit/psbt.test.ts` |
| Descriptor-Prüfsumme nach BIP-380 | bestanden | Testvektor |
| Live-Signet: Tip, Fee-Schätzung, UTXO-Abfrage, Cross-Check | bestanden (2026-10-18) | `npm run verify-signet` |

Grenze: Diese Tests zeigen, dass unsere Daten konsistent und standardkonform sind. Sie beweisen nicht, dass eine bestimmte GUI-Wallet die PSBT importiert und signiert.

## Testprotokoll für eine Wallet (z. B. Sparrow, Electrum, Bitcoin Core)

1. Drei neue Signet-Wallets anlegen (drei Geräte/Personen empfohlen).
2. Jede: Multisig-Keystore mit Pfad `m/48'/1'/<konto>'/2'` → Key-Origin + tpub exportieren.
3. Handel im Bot anlegen, Schlüssel registrieren.
4. Descriptor aus dem Bot in die Wallet importieren → erste Empfangsadresse vergleichen.
5. Signet-Coins von einem Faucet auf die Adresse senden (exakter Betrag).
6. Nach FUNDED: Freigabe anfordern, PSBT-Datei in Wallet A importieren, Outputs prüfen, signieren, exportieren, im Bot hochladen.
7. Gleiches mit Wallet B.
8. Senden im Bot → txid im Explorer prüfen.
9. Refund-Variante und Schlichter-Variante wiederholen.
10. Ergebnis hier eintragen (Version, Datum, txids, Auffälligkeiten).

| Wallet | Version | Descriptor-Import | PSBT-Import | Signieren | Rückgabe an Bot | Status |
|---|---|---|---|---|---|---|
| Sparrow | – | offen | offen | offen | offen | nicht getestet |
| Electrum | – | offen | offen | offen | offen | nicht getestet |
| Bitcoin Core | – | offen | offen | offen | offen | nicht getestet |
