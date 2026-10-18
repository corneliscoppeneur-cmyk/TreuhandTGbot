# Bedrohungsmodell

Skala: Wahrscheinlichkeit (W) / Auswirkung (A): niedrig · mittel · hoch. „Test“ verweist auf automatisierte Tests in `tests/`.

| # | Risiko | Szenario | A | W | Gegenmaßnahmen | Restrisiko | Test |
|---|---|---|---|---|---|---|---|
| 1 | Kompromittierter Telegram-Account | Angreifer übernimmt Käuferkonto | mittel | mittel | Auszahlung braucht 2 Wallet-Signaturen; Telegram ist keine Signatur | Angreifer kann Streitfall öffnen, Freigabe anfordern, Empfangsadresse (bei Refund) angeben → Wallet-Prüfung der PSBT durch Mitsignierer entscheidend | Signaturkombinationen (`psbt.test.ts`) |
| 2 | Gestohlener Einladungscode | Link/Code abgefangen | mittel | mittel | Link + Code getrennt; Link bindet sich ans erste Konto; Code einmalig; HMAC-gespeichert | Wer beides abfängt und zuerst öffnet, tritt bei → Einladender sieht Rolle besetzt, kann abbrechen | `security.test.ts` (Bindung, Einmaligkeit) |
| 3 | Replay | erneutes Senden alter Updates/PSBTs | mittel | mittel | `processed_telegram_updates`; PSBT an Session/unsigned tx gebunden | – | Duplikat-Update, veraltete PSBT |
| 4 | Brute Force | Codes raten | mittel | niedrig | 8 Zeichen aus 32 (40 Bit), 5 Versuche/Einladung → Sperre, 10 Fehlversuche/h/Nutzer | gering | Sperre nach 5 |
| 5 | Manipulierte Callback-Daten | fremde Trade-ID im Button | hoch | mittel | Jede Aktion serverseitig `authorize()`; Buttons sind keine Zugriffskontrolle | – | Fremder auf fremdem Handel |
| 6 | Gefälschte Webhooks | POST ohne Secret | hoch | mittel | `X-Telegram-Bot-Api-Secret-Token` konstantzeit-geprüft → 401 | Secret-Leak → Rotation | Webhook 401 |
| 7 | Doppelte Updates | Telegram-Retry | mittel | hoch | Idempotenz-Tabelle, idempotente Aktionen | – | Duplikat |
| 8 | Race Conditions | zwei gleichzeitige Transitionen | hoch | mittel | Optimistic Lock (Version) + `last_op`-Guard in einer D1-Transaktion; UNIQUE-Constraints | – | (Struktur), Konfliktpfad `ConcurrencyError` |
| 9 | Kompromittierte Blockchain-API | falsche UTXOs gemeldet | hoch | niedrig | Zweiter Provider, Abweichung → NEEDS_REVIEW; PSBT-Signaturen beziehen sich auf echte Beträge | Beide Provider kompromittiert → falsches FUNDED möglich; Auszahlung scheitert dann on-chain, kein Verlust | Disagreement-Tests |
| 10 | Fehlerhafte API-Antwort | ungültiges JSON/Felder | mittel | mittel | strikte Schema-Validierung, begrenzte Retries | – | Esplora-Tests |
| 11 | Chain-Reorg | Funding-Block verworfen | hoch | niedrig | Block-Hash gespeichert und verglichen; FUNDING_SEEN ↔ READY_TO_FUND; nach FUNDED → NEEDS_REVIEW | – | Reorg-Test |
| 12 | Double Spend | Einzahlung ersetzt | hoch | niedrig | 0-conf nie final, N Bestätigungen | Signet 1 Bestätigung | unbestätigt nie final |
| 13 | Fehlerhafte Fee-Schätzung | extrem hohe Rate | mittel | niedrig | Max-Rate, Max-Prozent → keine PSBT | zu niedrige Rate → Tx hängt (kein RBF in v1) | Fee-Test |
| 14 | Manipulierte PSBT | Output geändert | hoch | mittel | Vergleich der kompletten unsigned tx; Witness-UTXO/Script-Prüfung; eigene Sighash-Berechnung | – | manipulierte Tx/Output/Input |
| 15 | Unerlaubter Output | zusätzlicher Empfänger | hoch | mittel | unsigned tx muss identisch sein | – | Extra-Output |
| 16 | Falsche Provisionsadresse | Config-Fehler | mittel | niedrig | Adresse beim Start gegen Netzwerk validiert; in PSBT-Zusammenfassung sichtbar | falsche, aber gültige Adresse | Config-Test |
| 17 | Falscher Netzwerkparameter | Mainnet-Key auf Signet | hoch | niedrig | Versionsbytes, Coin-Type im Pfad, Adressnetzwerk geprüft | – | Netzwerk-Tests |
| 18 | Falsche Schlüsselreihenfolge | abweichende Adresse | hoch | niedrig | BIP-67 sortedmulti; Gegenprüfung bitcoinjs | – | Reihenfolge-Test |
| 19 | Wallet-Inkompatibilität | Wallet signiert nicht | mittel | mittel | Descriptor + bip32Derivation; Wallet erst nach Test als unterstützt | noch kein echter Wallet-Test | WALLET-COMPATIBILITY.md |
| 20 | Verlorener Signierschlüssel | Partei verliert Wallet | mittel | mittel | 2-von-3: andere zwei können auszahlen | zwei verlorene Schlüssel = Verlust | Kombinationstests |
| 21 | Kompromittierter Schlichter | kolludiert mit Partei | hoch | niedrig | Schlichter allein kann nicht auszahlen; Entscheidung dokumentiert | Schlichter + eine Partei können auszahlen (Modell-bedingt) | – |
| 22 | Kompromittierter Betreiberaccount | Cloudflare/Telegram-Admin | hoch | niedrig | Bot hat keine Schlüssel; Admin-Rolle ohne Signatur-/Zahlungsrechte | Angreifer kann manipulierte PSBTs anbieten → Wallet-Prüfung | – |
| 23 | D1-Ausfall | DB nicht erreichbar | mittel | niedrig | Keine Statusänderung; 500 → Telegram-Retry | – | D1-Ausfall-Test |
| 24 | Cloudflare-Ausfall | Worker offline | mittel | niedrig | Geld bleibt in Multisig; Parteien können extern signieren | – | – |
| 25 | API-Rate-Limit | 429 | niedrig | mittel | Backoff, Budget pro Lauf | Verzögerung | 429-Test |
| 26 | Fehlerhaftes Deployment | falsche Vars | mittel | mittel | Fail-closed Config, `validate-config`, CI | – | Config-Tests |
| 27 | Supply-Chain | kompromittiertes npm-Paket | hoch | niedrig | exakt gepinnt, Lockfile, wenige Deps, `npm audit` in CI | Restrisiko bleibt | CI |
| 28 | Dependency-Kompromittierung | Update mit Schadcode | hoch | niedrig | keine automatischen Updates; Review bei Upgrade | – | – |
| 29 | Log-Leak | Secrets in Logs | mittel | niedrig | Redaction (Token, xprv, Adressen, PSBT, Seeds) | – | Redaction-Test |
| 30 | Social Engineering | „Admin“ fragt nach Seed | hoch | mittel | Hinweise im Bot; Bot fragt nie nach Seeds; Seed/xprv-Erkennung | Nutzerverhalten | Seed-Ablehnung |
| 31 | Gefälschte Cryptgeon-Links | Phishing-Domain | mittel | mittel | Hinweis auf exakte Domain; Bot füllt Cryptgeon nie automatisch | Nutzerverhalten | – |
| 32 | Missbrauch Support-Workflow | Daten an Support | niedrig | niedrig | Bot leitet nichts automatisch weiter; nur Link | – | – |
| 33 | Ein Akteur kontrolliert mehrere Rollen | Sockenpuppe | hoch | mittel | eine Person = eine Rolle; verschiedene Fingerprints; xpub-Einmaligkeit | **Mehrere Telegram-Konten/Wallets einer Person sind technisch nicht erkennbar** → Schlichter organisatorisch auswählen | Rollen-/Fingerprint-Tests |
| 34 | Provision umgangen | Käufer+Verkäufer signieren ohne Bot | niedrig | mittel | transparent dokumentiert | bewusst akzeptiert | – |
