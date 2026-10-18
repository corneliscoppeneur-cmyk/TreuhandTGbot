# Datenschutz

## Gespeichert (D1)
- Telegram-User-ID, Username (aktuell), Zeitstempel
- Handelsdaten: Titel, Beschreibung, Bedingungen, Betrag, Rollen, Status
- Öffentliche Schlüssel (tpub), Fingerprints, Multisig-Adresse, Descriptor
- Funding-UTXOs, txids, PSBT (unsigniert) und Signaturen (öffentlich, für Kombination)
- Empfangsadressen der Auszahlung (in der PSBT-Session)
- Streitfall-Begründungen, externe Links, Schlichterentscheidung
- Minimales Audit-Log (Aktion, Akteur-ID, Status)
- Einladungen/Zugangscodes nur als HMAC

## Nicht gespeichert
Klarnamen, Anschriften, Ausweise, Chatkopien, private Schlüssel, Seeds, Passwörter, Klartext-Tokens.

## Datenminimierung im Ablauf
- Teilnehmerliste zeigt nur Rollen, keine Namen/IDs.
- Gruppenchats erhalten nur Statusmeldungen, nie Adressen/Schlüssel/PSBTs (Test: `security.test.ts`).
- Treuhandadresse nur im privaten Chat für Käufer/Verkäufer/Schlichter.
- Cryptgeon-Hinweis für sensible Inhalte; der Bot befüllt Cryptgeon nie selbst.

## Löschfristen (Cron)
| Daten | Frist |
|---|---|
| verarbeitete Update-IDs | 7 Tage |
| Dialogzustand | 30 min |
| Zugangsversuche, Provider-Beobachtungen | 30 Tage |
| Freitexte, Streitfall-Texte, Agreement-Inhalt, PSBT/Raw-Tx abgeschlossener Handel | `DATA_RETENTION_DAYS` (Standard 180) nach Abschluss |
Behalten werden IDs, Status, txids und Audit-Aktionen zur Nachvollziehbarkeit.

## Dritte
- Telegram (Nachrichtentransport, nicht E2E-verschlüsselt)
- Cloudflare (Hosting, Datenbank)
- Esplora-Provider sehen abgefragte Adressen/txids
- Bitcoin-Blockchain ist öffentlich; Adressen sind nicht anonym.
