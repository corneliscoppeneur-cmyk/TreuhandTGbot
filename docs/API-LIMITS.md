# Limits und Budget

Geprüft gegen offizielle Cloudflare-Doku am 2026-10-18 (developers.cloudflare.com/workers/platform/limits, /d1/platform/limits, /d1/platform/pricing):

| Limit | Free | Paid |
|---|---|---|
| Requests | 100.000/Tag | unbegrenzt |
| CPU pro HTTP-Aufruf | 10 ms | 30 s (bis 5 min) |
| CPU pro Cron-Aufruf | 10 ms | 30 s / 15 min |
| Subrequests pro Aufruf (inkl. D1-Queries!) | 50 | 10.000 |
| Cron-Trigger pro Konto | 5 | 250 |
| D1 Rows read | 5 Mio./Tag | 25 Mrd./Monat inkl. |
| D1 Rows written | 100.000/Tag | 50 Mio./Monat inkl. |
| D1 Speicher | 5 GB/Konto | 1 TB |

Die Zahlen im ursprünglichen Recherchebericht stimmen damit überein. Zusätzlich relevant: **D1-Queries zählen auf Free als Subrequests.**

## Budget pro Aufruf (Schätzung aus Code)

| Aufruf | D1-Queries | HTTP (Telegram/Esplora) |
|---|---|---|
| normaler Button/Befehl | 4–10 | 1–3 |
| Beitritt mit Agreement-Start | ~15 | bis 7 |
| PSBT-Erstellung | ~12 | 1 Fee + 6 (3 Text + 3 Datei) |
| Cron pro Handel | 4–8 | 1–4 (× 2 bei zweitem Provider) |

`POLL_MAX_TRADES_PER_RUN=4` hält einen Cron-Lauf auf Free unter 50 Subrequests.

## CPU (gemessen in Node 24, warm – nicht Workers)

| Operation | Zeit |
|---|---|
| Kindschlüssel ableiten (×2 Ebenen) | ~3 ms |
| PSBT bauen | ~3,5 ms |
| PSBT-Signatur prüfen | ~6 ms |
| Kombinieren + Finalisieren | ~7,5 ms |

Konsequenz: einzelne Aufrufe liegen nahe an 10 ms. **Echte Werte nach Deployment in Workers Logs prüfen.** Bei `exceededCpu` → Workers Paid. Fehlerverhalten ist sicher (Abbruch ohne Statusänderung, Telegram wiederholt).

## Esplora
Öffentliche Instanzen ohne zugesicherte Limits. Client: Timeout 8 s, max. 1 Retry (5xx/429/Timeout), Backoff im Poller bis 6 h.
