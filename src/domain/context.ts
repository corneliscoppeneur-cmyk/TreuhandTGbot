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

export type Button = { text: string; data: string } | { text: string; url: string };

/** Outgoing message produced by a service. Private notices go to user ids; group notices are status-only. */
export interface Notice {
  chatId: number;
  text: string;
  buttons?: Button[][];
  /** Send as a document (e.g. PSBT file) in addition to the text. */
  document?: { filename: string; content: string };
}

/** Error whose message is safe and meant to be shown to the user. */
export class UserError extends Error {
  override name = 'UserError';
}
