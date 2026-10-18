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

## Gebühr und Einzahlung
Der Käufer zahlt eine Summe (Handelsbetrag + Servicegebühr) an eine Adresse. Die Gebühr geht bei jeder Auszahlung als eigener Posten an den Betreiber. Umgehung am Bot vorbei → beide Parteien gesperrt.

## Einladung
Ersteller erhält Link `t.me/<bot>?start=i_<token>` und separaten 8-stelligen Code. Empfänger öffnet Link (bindet die Einladung an sein Konto), gibt Code ein. Gültig 72 h, einmalig, 5 Fehlversuche → Sperre.

## PSBT
Empfänger gibt privat Adresse an → Bot erstellt PSBT und zeigt Zusammenfassung (Inputs, Outputs, Provision, Minerfee, txid) → Signierer laden die Datei in die Wallet, signieren, senden sie zurück („Signierte PSBT hochladen“) → nach 2 gültigen Signaturen „Transaktion senden“.

## Befehle
`/start /help /newtrade /mytrades /trade <ID> /invites <ID> /disputes /support /privacy /fees /status [ID] /cancel`, in Gruppen `/link <ID>`, `/status <ID>`.

## Telegram-Darstellung (Bot API 10.3)

| Funktion | Einsatz |
|---|---|
| Rich Messages (`sendRichMessage`) | Handelsübersicht (Tabellen), Bedingungen (aufklappbare Abschnitte), PSBT-Zusammenfassung (Tabelle der Outputs). Fallback automatisch auf HTML, dann Klartext. |
| Kopier-Buttons (`copy_text`) | Adresse, Betrag (`0.01000000`), Einladungslink, Zugangscode, txid |
| Code-Blöcke (`<pre>`) | Descriptor und PSBT (Antippen kopiert) |
| Farbige Buttons (`style`) | grün = bestätigen/freigeben/senden, rot = abbrechen/Streitfall/„stimmt nicht“, blau = nächster Schritt |
| Deaktivierte Buttons | Statusanzeige („⏳ Warte auf Einzahlung“, „✍️ Signaturen 1 von 2“) |
| `force_reply` + Platzhalter | alle Eingabeschritte (Titel, Betrag, Schlüssel, Adresse, PSBT, Begründung) |
| `protect_content` | Streitfall-Inhalte (Begründungen, Rückfragen, Entscheidungen) – nicht weiterleitbar |
| Ephemeral Messages | in Gruppen: Hinweise und Privat-Link nur für den Absender sichtbar; Fallback auf normalen Hinweis |
| `tg-time` | Ablauf der Einladung, Gültigkeit der PSBT-Session, Erstellt-/Beitrittszeit, Streitfall-Alter – in der Ortszeit des Lesers |
| Links | Explorer (mempool.space) für Adresse und txid, Cryptgeon, Support, Deep-Link `start=t_<ID>` |

Bewusst **nicht** genutzt: `protect_content` für PSBT/Einladungen (Datei muss in die Wallet, Link muss weitergegeben werden), Stars/Payments (nur BTC), Mini Apps (später möglich).
