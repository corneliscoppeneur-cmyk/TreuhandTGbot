# Abläufe

## Zustände
`INVITING → AGREEMENT → KEY_SETUP → READY_TO_FUND → FUNDING_SEEN → FUNDED → FULFILLMENT → RELEASE_REQUESTED / REFUND_REQUESTED → SIGNING → BROADCAST → COMPLETE / REFUNDED`

Streit: `FUNDING_SEEN…SIGNING → DISPUTED → ARBITRATION → RELEASE_REQUESTED / REFUND_REQUESTED → SIGNING`
Sicher anhalten: `NEEDS_REVIEW` (Überzahlung, Reorg nach Funding, Spend außerhalb, Provider-Widerspruch, Broadcast abgelehnt).
Terminal: `COMPLETE`, `REFUNDED`, `CANCELLED`, `FAILED`. (`DRAFT` existiert im Modell; der Dialog erzeugt direkt `INVITING`.)

Abbruch nur bis `READY_TO_FUND` ohne erkannte Einzahlung.

## Rollen
| Aktion | Käufer | Verkäufer | Schlichter | Vermittler | Beobachter | Admin |
|---|---|---|---|---|---|---|
| Handel sehen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Teilnehmer sehen | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Zahlungsdetails | ✓ | ✓ | ✓ | – | – | – |
| Einladen / widerrufen | ✓ | ✓ | – | – | – | – |
| Bedingungen akzeptieren | ✓ | ✓ | ✓ | – | – | – |
| Schlüssel registrieren / Adresse prüfen | ✓ | ✓ | ✓ | – | – | – |
| Abbrechen (vor Funding) | ✓ | ✓ | – | – | – | – |
| Lieferung melden | – | ✓ | – | – | – | – |
| Freigabe anfordern | ✓ | – | – | – | – | – |
| Refund zustimmen | – | ✓ | – | – | – | – |
| PSBT signieren / senden | ✓ | ✓ | ✓ | – | – | – |
| Streitfall eröffnen | ✓ | ✓ | – | – | – | – |
| Streitfall entscheiden | – | – | ✓ | – | – | – |

## Einladung
Ersteller erhält Link `t.me/<bot>?start=i_<token>` und separaten 8-stelligen Code. Empfänger öffnet Link (bindet die Einladung an sein Konto), gibt Code ein. Gültig 72 h, einmalig, 5 Fehlversuche → Sperre.

## PSBT
Empfänger gibt privat Adresse an → Bot erstellt PSBT und zeigt Zusammenfassung (Inputs, Outputs, Provision, Minerfee, txid) → Signierer laden die Datei in die Wallet, signieren, senden sie zurück („Signierte PSBT hochladen“) → nach 2 gültigen Signaturen „Transaktion senden“.

## Befehle
`/start /help /newtrade /mytrades /trade <ID> /invites <ID> /disputes /support /privacy /fees /status [ID] /cancel`, in Gruppen `/link <ID>`, `/status <ID>`.
