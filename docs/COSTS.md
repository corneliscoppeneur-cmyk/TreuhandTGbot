# Kosten

Ziel: Betrieb im kostenlosen Rahmen. **Keine Kostengarantie.**

| Posten | Kosten | Hinweis |
|---|---|---|
| Cloudflare Workers Free | 0 € | 100.000 Requests/Tag, **10 ms CPU/Aufruf**, 50 Subrequests/Aufruf |
| Cloudflare D1 Free | 0 € | 5 Mio. gelesene / 100.000 geschriebene Zeilen pro Tag, 5 GB |
| Workers Paid (empfohlen für stabilen Betrieb) | ca. 5 USD/Monat | 30 s CPU (bis 5 min), 10.000 Subrequests |
| Telegram Bot API | 0 € | |
| Esplora (mempool.space, blockstream.info) | 0 € | öffentliche APIs, Limits/Bedingungen können sich ändern |
| workers.dev-Domain | 0 € | eigene Domain nicht nötig |
| GitHub + Actions | 0 € (öffentliche Repos) | |
| Signet | 0 € | Testcoins ohne Wert |

## Nicht kostenlos / nicht garantiert
- **Mainnet-Netzwerkgebühren** sind nie kostenlos (zahlt Einzahler bzw. Auszahlungsempfänger).
- Öffentliche Blockchain-APIs können drosseln oder abschalten.
- Kostenlose Dienste können ihre Bedingungen ändern.
- Ein Upgrade auf Workers Paid kann nötig werden (CPU-Zeit der PSBT-Prüfung, siehe API-LIMITS.md).
- Externe Wallets können je nach Anbieter Kosten verursachen.
- Externer Sicherheits-Audit: kostenpflichtig.
- Rechtsberatung/Compliance: kostenpflichtig.

Verhalten bei erschöpften Kontingenten: Cloudflare antwortet mit Fehler (1027/1102) → Telegram wiederholt Updates; der Bot ändert dabei keinen Finanzstatus.
