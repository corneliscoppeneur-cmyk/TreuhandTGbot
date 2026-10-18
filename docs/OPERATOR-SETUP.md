# Betreiber-Modus einrichten (automatischer Schlichter + Servicegebühr)

Im Betreiber-Modus bist du automatisch der dritte Schlüssel (Schlichter) in jedem Handel. Der Bot nutzt dafür nur deinen **öffentlichen** Schlüssel. Dein privater Schlüssel bleibt in deiner Wallet.

## So funktioniert die Gebühr
- Der Käufer zahlt **eine Summe an eine Adresse**: Handelsbetrag + Servicegebühr ins Treuhand-Konto.
- Bei **jeder** Auszahlung, ob an den Verkäufer oder als Rückzahlung an den Käufer, geht die Gebühr als eigener Posten automatisch an deine Adresse `COMMISSION_ADDRESS`.
- Die Gebühr wird nicht erstattet. Das steht vorher in den Bedingungen.
- **Restrisiko:** Käufer und Verkäufer könnten sich absprechen und gemeinsam am Bot vorbei auszahlen, denn sie haben 2 von 3 Schlüsseln. Der Bot erkennt das, **sperrt beide automatisch** und meldet es dir. Diese Regel steht vorher in den Gebühren-Hinweisen.

## Was du brauchst
- Sparrow Wallet im Signet-Modus (`Tools → Restart in → Signet`)
- Eine Empfangsadresse für deine Gebühren (beliebige eigene Wallet, Reiter „Receive“) → `COMMISSION_ADDRESS`
- Für Tests zwei weitere Telegram-Konten (Käufer, Verkäufer). Der Betreiber selbst kann nicht Käufer oder Verkäufer sein.

## Schlichter-Schlüssel erzeugen
1. `File → New Wallet` → Name „Betreiber-Schlichter“
2. `Policy Type: Multi Signature`, `Script Type: Native Segwit (P2WSH)`
3. Im ersten Keystore `New or Imported Software Wallet` → `Generate New` → Wörter auf Papier sichern
4. Angezeigt werden **Master fingerprint**, **Derivation** (z. B. `m/48'/1'/0'/2'`) und **xpub**
5. Daraus wird `OPERATOR_ARBITER_KEY`, z. B. `[a1b2c3d4/48h/1h/0h/2h]tpubDF…`

Diesen Schlüssel brauchst du nur, wenn du nach einem Streitfall eine Auszahlung mit unterschreibst.

## Eintragen und starten
In `wrangler.jsonc` unter `vars`:
```jsonc
"COMMISSION_ADDRESS": "tb1q…deine Gebührenadresse…",
"OPERATOR_TELEGRAM_ID": "7472753006",
"OPERATOR_ARBITER_KEY": "[fingerprint/48h/1h/0h/2h]tpub…",
```
Danach:
```bash
npm run validate-config
npx wrangler deploy
```
Ist ein Wert falsch, startet der Bot nicht (`/health` zeigt `configuration invalid`).

## Was du als Betreiber bekommst
- 🛎 Admin-Meldungen: neuer Handel, wartet auf Einzahlung, finanziert, Prüfung nötig (inkl. Umgehungsversuch), abgeschlossen
- Streitfälle: Fall übernehmen, Rückfragen stellen, entscheiden (Auszahlung oder Rückzahlung)
- Nach einer Entscheidung: Auszahlungs-Datei zum Unterschreiben mit deiner Schlichter-Wallet

## Nutzer entsperren
Gesperrte Nutzer bekommen keine Antworten mehr. Entsperren:
```bash
npx wrangler d1 execute escrow --remote --command "UPDATE users SET is_blocked = 0 WHERE telegram_user_id = <ID>"
```

## Ehrliche Grenzen
- Als Schlichter kannst du zusammen mit Käufer **oder** Verkäufer auszahlen. Nutzer müssen dir als neutraler Instanz vertrauen. Das ist bei Treuhand-Diensten üblich, hat aber rechtliche Folgen (siehe LEGAL-CHECKLIST.md).
- Dein Schlichter-Schlüssel ist in allen Handeln derselbe. Das ist technisch sicher, macht deine Handel nach einer Auszahlung aber für Außenstehende als zusammengehörig erkennbar.
