# Betreiber-Modus einrichten (automatischer Schlichter + sichere Gebühr)

Im Betreiber-Modus bist du automatisch der dritte Schlüssel (Schlichter) in jedem Handel, und die Servicegebühr wird **bei der Einzahlung** direkt an deine eigene Wallet gezahlt. Der Bot nutzt dafür nur deine **öffentlichen** Schlüssel. Deine privaten Schlüssel bleiben in deiner Wallet.

## Was du brauchst
- Sparrow Wallet im Signet-Modus (`Tools → Restart in → Signet`)
- Für Tests zwei weitere Telegram-Konten (Käufer, Verkäufer). Der Betreiber selbst kann nicht Käufer oder Verkäufer sein.

## 1. Schlichter-Wallet (Multisig-Schlüssel)
1. `File → New Wallet` → Name „Betreiber-Schlichter“
2. `Policy Type: Multi Signature`, `Script Type: Native Segwit (P2WSH)`
3. Im ersten Keystore `New or Imported Software Wallet` → `Generate New` → Wörter auf Papier sichern
4. Angezeigt werden **Master fingerprint**, **Derivation** (z. B. `m/48'/1'/0'/2'`) und **xpub**
5. Daraus wird `OPERATOR_ARBITER_KEY`, z. B. `[a1b2c3d4/48h/1h/0h/2h]tpubDF…`

Diesen Schlüssel brauchst du nur, wenn du nach einem Streitfall eine Auszahlung unterschreibst.

## 2. Gebühren-Wallet (normale Wallet)
1. `File → New Wallet` → Name „Betreiber-Gebühren“
2. `Policy Type: Single Signature`, `Script Type: Native Segwit (P2WPKH)`
3. `New or Imported Software Wallet` → `Generate New` → Wörter sichern
4. Den angezeigten **xpub/vpub** kopieren → `COMMISSION_XPUB`

Jeder Handel bekommt automatisch eine neue Empfangsadresse aus dieser Wallet. Die Gebühren siehst du direkt in Sparrow.

## 3. Eintragen und starten
In `wrangler.jsonc` unter `vars` die drei Zeilen aktivieren (Kommentarzeichen `//` entfernen) und ausfüllen:
```jsonc
"OPERATOR_TELEGRAM_ID": "7472753006",
"OPERATOR_ARBITER_KEY": "[fingerprint/48h/1h/0h/2h]tpub…",
"COMMISSION_XPUB": "vpub…",
```
Danach:
```bash
npm run validate-config
npx wrangler deploy
```
Ein falscher Schlüssel führt dazu, dass der Bot nicht startet (`/health` zeigt `configuration invalid`). So läuft nie etwas mit fehlerhafter Konfiguration.

## Was du als Betreiber bekommst
- 🛎 Admin-Meldungen: neuer Handel, wartet auf Einzahlung (mit Gebührenadresse), Gebühr erhalten, finanziert, Prüfung nötig, abgeschlossen
- Streitfälle: Fall übernehmen, Rückfragen stellen, entscheiden (Auszahlung oder Rückzahlung)
- Nach einer Entscheidung: Auszahlungs-Datei zum Unterschreiben mit deiner Schlichter-Wallet

## Ehrliche Grenzen
- Die Gebühr ist sicher, weil sie vor dem Handel bezahlt wird. Sie wird nicht erstattet. So steht es vor dem Handel in den Bedingungen.
- Als Schlichter kannst du zusammen mit Käufer **oder** Verkäufer auszahlen. Die Nutzer müssen dir also als neutraler Instanz vertrauen. Das ist bei Treuhand-Diensten üblich, hat aber rechtliche Folgen (siehe LEGAL-CHECKLIST.md).
- Dein Schlichter-Schlüssel ist in allen Handeln derselbe. Das ist technisch sicher, macht deine Handel aber für Außenstehende als zusammengehörig erkennbar, sobald ausgezahlt wird.
