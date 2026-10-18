/**
 * Picture guides sent as Telegram albums (swipeable media group).
 * The images are rendered from this data by scripts/build-guides.ts into public/guide/
 * and served by the Worker as static assets.
 */

export interface GuideUi {
  /** Menu path opened in the mock window, e.g. ['Tools', 'Restart In', 'Signet']. */
  menuPath?: string[];
  /** Highlighted entry in the left sidebar. */
  sidebar?: 'Transactions' | 'Send' | 'Receive' | 'Addresses' | 'UTXOs' | 'Settings';
  /** Form fields shown in the content area. */
  fields?: { label: string; value: string }[];
  /** Buttons shown in the content area; the first one is highlighted. */
  buttons?: string[];
}

export interface GuideCard {
  title: string;
  lines: string[];
  ui?: GuideUi;
}

export interface Guide {
  id: string;
  name: string;
  color: string;
  cards: GuideCard[];
}

export const GUIDES: Guide[] = [
  {
    id: 'wallet',
    name: 'Wallet einrichten',
    color: '#2f6fde',
    cards: [
      {
        title: 'Sparrow Wallet installieren',
        lines: [
          'Kostenlos für Windows, Mac und Linux.',
          'Nur von der offiziellen Seite laden:',
          'sparrowwallet.com/download',
          'Beim Start „Public Server“ wählen.',
        ],
      },
      {
        title: 'Testnetz einschalten (nur im Test)',
        lines: [
          'Oben im Menü: Tools → Restart In → Signet.',
          'Sparrow startet neu, oben rechts steht „Signet“.',
          'Im echten Betrieb diesen Schritt weglassen.',
        ],
        ui: { menuPath: ['Tools', 'Restart In', 'Signet'] },
      },
      {
        title: 'Neue Wallet anlegen',
        lines: ['File → New Wallet.', 'Einen Namen eingeben, z. B. „Handel“,', 'dann „Create Wallet“.'],
        ui: { menuPath: ['File', 'New Wallet'] },
      },
      {
        title: 'Multisig wählen',
        lines: [
          'Policy Type: Multi Signature',
          'Script Type: Native Segwit (P2WSH)',
          'Unten bei Keystore 1:',
          '„New or Imported Software Wallet“.',
        ],
        ui: {
          sidebar: 'Settings',
          fields: [
            { label: 'Policy Type', value: 'Multi Signature HD' },
            { label: 'Script Type', value: 'Native Segwit (P2WSH)' },
          ],
          buttons: ['New or Imported Software Wallet'],
        },
      },
      {
        title: '12 Wörter erzeugen und aufschreiben',
        lines: [
          'Pfeil ▼ → „Use 12 Words“ → „Generate New“.',
          'Wörter NUR auf Papier schreiben – nie fotografieren,',
          'nie verschicken. Dann bestätigen und',
          '„Import Keystore“ (Pfad nicht ändern).',
        ],
        ui: { buttons: ['Generate New', 'Confirm Backup…', 'Import Keystore'] },
      },
      {
        title: 'Schlüssel an den Bot senden',
        lines: [
          'Im Keystore stehen Master fingerprint, Derivation und tpub.',
          'Im Bot so senden: [fingerprint/48h/1h/0h/2h]tpub…',
          'Für jeden weiteren Handel einen neuen Pfad nutzen:',
          '…/1h/2h, …/2h/2h usw. (beim Import „Custom Derivation“).',
        ],
        ui: {
          sidebar: 'Settings',
          fields: [
            { label: 'Master fingerprint', value: 'a1b2c3d4' },
            { label: 'Derivation', value: "m/48'/1'/0'/2'" },
            { label: 'tpub', value: 'tpubDF…' },
          ],
        },
      },
    ],
  },
  {
    id: 'trade-wallet',
    name: 'Treuhand-Konto prüfen',
    color: '#0f8a5f',
    cards: [
      {
        title: 'Kontodaten aus dem Bot kopieren',
        lines: ['Der Bot schickt die „Kontodaten (Descriptor)“.', 'Den grauen Text antippen – er wird kopiert.'],
      },
      {
        title: 'Handels-Wallet in Sparrow anlegen',
        lines: ['File → New Wallet → Name „Handel #ID“.', 'Bei „Descriptor“ auf „Edit…“ klicken,', 'den kopierten Text einfügen, „Apply“.'],
        ui: { sidebar: 'Settings', fields: [{ label: 'Descriptor', value: 'wsh(sortedmulti(2,[…' }], buttons: ['Edit…', 'Apply'] },
      },
      {
        title: 'Eigenen Schlüssel einsetzen',
        lines: [
          'Den Reiter mit DEINEM Fingerprint öffnen →',
          '„Replace…“ → Software Wallet → deine 12 Wörter',
          'eingeben → „Import Keystore“ → „Apply“.',
          'Erst dann kannst du später unterschreiben.',
        ],
        ui: { sidebar: 'Settings', buttons: ['Replace…', 'Import Keystore', 'Apply'] },
      },
      {
        title: 'Adresse vergleichen',
        lines: [
          'Links auf „Receive“.',
          'Die Adresse muss genau der Adresse im Bot entsprechen.',
          'Stimmt sie: im Bot „Adresse stimmt überein“.',
        ],
        ui: { sidebar: 'Receive', fields: [{ label: 'Address', value: 'tb1q…' }] },
      },
    ],
  },
  {
    id: 'deposit',
    name: 'Einzahlen',
    color: '#c77700',
    cards: [
      {
        title: 'Betrag und Adresse kopieren',
        lines: ['Im Bot: „Adresse kopieren“ und „Summe kopieren“.', 'Eine Zahlung, eine Adresse – genau diese Summe.'],
      },
      {
        title: 'In der Wallet senden',
        lines: [
          'Sparrow: links „Send“.',
          'Pay to: Adresse einfügen, Amount: Summe einfügen.',
          '„Create Transaction“ → „Finalize“ → „Sign“ → „Broadcast“.',
        ],
        ui: {
          sidebar: 'Send',
          fields: [
            { label: 'Pay to', value: 'tb1q…' },
            { label: 'Amount', value: '0.01030000 BTC' },
          ],
          buttons: ['Create Transaction'],
        },
      },
      {
        title: 'Warten – der Bot meldet sich',
        lines: [
          'Nach der Bestätigung durch das Netzwerk',
          '(meist 10–30 Minuten) schreibt dir der Bot.',
          'Mit jeder Wallet möglich, auch Handy-Wallets.',
        ],
      },
    ],
  },
  {
    id: 'sign',
    name: 'Auszahlung unterschreiben',
    color: '#7a3fd1',
    cards: [
      {
        title: 'Datei aus dem Bot speichern',
        lines: ['Der Bot schickt eine .psbt-Datei.', 'Speichern (oder den Text antippen und kopieren).'],
      },
      {
        title: 'In Sparrow öffnen',
        lines: ['Handels-Wallet öffnen.', 'File → Open Transaction → From File', '(oder From Clipboard).'],
        ui: { menuPath: ['File', 'Open Transaction', 'From File…'] },
      },
      {
        title: 'Prüfen und unterschreiben',
        lines: [
          'Empfänger und Beträge mit der Übersicht im Bot vergleichen.',
          '„Finalize Transaction for Signing“ → „Sign“.',
          'NICHT „Broadcast“ – das macht der Bot.',
        ],
        ui: { buttons: ['Finalize Transaction for Signing', 'Sign'] },
      },
      {
        title: 'Zurück an den Bot',
        lines: ['„Save Transaction“ → Datei speichern.', 'Im Bot: „Signierte PSBT hochladen“', 'und die Datei schicken. Fertig!'],
        ui: { buttons: ['Save Transaction'] },
      },
    ],
  },
];

export function guideById(id: string): Guide | undefined {
  return GUIDES.find((g) => g.id === id);
}

/** Public URLs of a guide's images (served by the Worker as static assets). */
export function guideImageUrls(baseUrl: string, g: Guide): string[] {
  return g.cards.map((_c, i) => `${baseUrl.replace(/\/+$/, '')}/guide/${g.id}-${i + 1}.png`);
}
