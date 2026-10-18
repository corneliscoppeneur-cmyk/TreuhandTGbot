import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config/env.ts';
import { helpText, mainMenuText } from '../../src/telegram/messages.ts';

const cfg = (network: 'signet' | 'mainnet') => ({ network, operatorId: 7472753006 }) as unknown as AppConfig;
const text = (c: { html?: string; text?: string }) => JSON.stringify(c);

describe('network-aware texts', () => {
  it('mainnet menu and help show no test-network content', () => {
    for (const c of [mainMenuText(cfg('mainnet')), helpText(cfg('mainnet'))])
      expect(text(c)).not.toMatch(/Signet|Testbetrieb|Testnetz|tpub/);
  });
  it('signet menu keeps the test hint', () => {
    expect(text(mainMenuText(cfg('signet')))).toMatch(/Testbetrieb/);
  });
});
