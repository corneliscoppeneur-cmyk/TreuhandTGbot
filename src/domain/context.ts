import type { NetworkParams } from '../bitcoin/networks.ts';
import type { BlockchainProvider } from '../blockchain/provider.ts';
import type { AppConfig } from '../config/env.ts';
import type { Db } from '../database/client.ts';

export interface ServiceCtx {
  db: Db;
  cfg: AppConfig;
  net: NetworkParams;
  chain: BlockchainProvider;
  now: () => number;
}

/** Telegram button colors: success = green, danger = red, primary = blue. */
export type ButtonStyle = 'success' | 'danger' | 'primary';

export type Button =
  | { text: string; data: string; style?: ButtonStyle }
  | { text: string; url: string; style?: ButtonStyle }
  /** Copies text (1-256 chars) to the clipboard. */
  | { text: string; copy: string; style?: ButtonStyle }
  /** Non-clickable status indicator. */
  | { text: string; disabled: true };

/** Content of an outgoing message. Exactly one of text / html / rich should be the primary content. */
export interface MessageContent {
  /** Plain text (no markup). */
  text: string;
  /** HTML parse-mode markup; all dynamic values escaped with esc(). */
  html?: string;
  /** Rich-message HTML (tables, headings, details). Falls back to html/text if unsupported. */
  rich?: string;
  buttons?: Button[][];
  /** Prevent forwarding and saving (dispute content, warnings). */
  protect?: boolean;
  /** Ask the client to open the reply field (dialog prompts). */
  forceReply?: { placeholder?: string };
}

/** Outgoing message produced by a service. Private notices go to user ids; group notices are status-only. */
export interface Notice extends MessageContent {
  chatId: number;
  /** Send as a document (e.g. PSBT file) in addition to the text. */
  document?: { filename: string; content: string };
}

/** Error whose message is safe and meant to be shown to the user. */
export class UserError extends Error {
  override name = 'UserError';
}
