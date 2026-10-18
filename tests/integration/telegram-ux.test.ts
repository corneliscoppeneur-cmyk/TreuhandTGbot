import { afterEach, describe, expect, it, vi } from 'vitest';
import { Harness } from '../helpers/harness.ts';
import { ARBITER, BUYER, SELLER, inviteAndJoin, setupFundedTrade } from '../helpers/flows.ts';
import { signAs, testAddress } from '../helpers/escrow.ts';
import { esc, richToHtml, time, toPlain } from '../../src/telegram/format.ts';
import { toMarkup } from '../../src/telegram/send.ts';

afterEach(() => vi.unstubAllGlobals());

async function newTrade(h: Harness, title = 'T'): Promise<string> {
  await h.text(BUYER, '/newtrade');
  for (const t of [title, 'D', '0,01', 'B']) await h.text(BUYER, t);
  await h.click(BUYER, 'n:role:buyer');
  await h.click(BUYER, 'n:confirm');
  return /Handel #([A-Z0-9]{8}) erstellt/.exec(h.last(BUYER).text)![1]!;
}

describe('formatting helpers', () => {
  it('escapes HTML in user content', () => {
    expect(esc('<b>&"x"')).toBe('&lt;b&gt;&amp;&quot;x&quot;');
  });
  it('renders tg-time with a readable fallback', () => {
    expect(time(1_800_000_000, 'r')).toMatch(/^<tg-time unix="1800000000" format="r">2027-01-15 08:00 UTC<\/tg-time>$/);
  });
  it('converts rich markup to classic HTML and plain text', () => {
    const rich = '<h3>Titel</h3><table><tr><td>A</td><td>B</td></tr></table><details><summary>S</summary><p>x</p></details>';
    const htmlOut = richToHtml(rich);
    expect(htmlOut).not.toMatch(/<table|<h3|<details/);
    expect(htmlOut).toContain('<b>Titel</b>');
    expect(toPlain(rich)).toContain('Titel');
  });
  it('builds markup with styles, copy, disabled and force_reply', () => {
    const m = toMarkup({
      buttons: [
        [
          { text: 'ok', data: 'x', style: 'success' },
          { text: 'c', copy: 'abc' },
          { text: 'wait', disabled: true },
        ],
      ],
      forceReply: { placeholder: 'p' },
    }) as { inline_keyboard: Record<string, unknown>[][]; force_reply?: boolean };
    expect(m.inline_keyboard[0]![0]).toEqual({ text: 'ok', callback_data: 'x', style: 'success' });
    expect(m.inline_keyboard[0]![1]).toEqual({ text: 'c', copy_text: { text: 'abc' } });
    expect(m.inline_keyboard[0]![2]).toEqual({ text: 'wait', disabled: {} });
    expect(m.force_reply).toBe(true);
    expect(toMarkup({ forceReply: { placeholder: 'tb1q…' } })).toEqual({ force_reply: true, input_field_placeholder: 'tb1q…' });
  });
});

describe('Telegram UX', () => {
  it('trade view is a rich message with a table and colored/disabled buttons', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.click(BUYER, `t:${id}:view`);
    const m = h.last(BUYER);
    expect(m.method).toBe('sendRichMessage');
    expect(m.raw).toContain('<table>');
    expect(m.raw).toContain('<tg-time');
    expect(m.buttons.find((b) => b.disabled)?.text).toMatch(/Warte auf Teilnehmer/);
    expect(m.buttons.find((b) => b.data === `t:${id}:cancel`)?.style).toBe('danger');
  });

  it('falls back to HTML when rich messages are not supported', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    h.richUnsupported = true;
    await h.click(BUYER, `t:${id}:view`);
    const m = h.last(BUYER);
    expect(m.method).toBe('sendMessage');
    expect(m.parseMode).toBe('HTML');
    expect(m.raw).not.toContain('<table>');
    expect(m.text).toContain(`#${id}`);
  });

  it('user content is escaped (no HTML injection)', async () => {
    const h = new Harness();
    const id = await newTrade(h, '<b>Fake</b> & <a href="x">');
    await h.click(BUYER, `t:${id}:view`);
    const m = h.last(BUYER);
    expect(m.raw).toContain('&lt;b&gt;Fake&lt;/b&gt; &amp; &lt;a href=&quot;x&quot;&gt;');
    expect(m.raw).not.toContain('<a href="x">');
  });

  it('invite: code shown as copyable code, copy buttons, expiry as tg-time', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.click(BUYER, `i:${id}:seller`);
    const m = h.last(BUYER);
    const code = /Zugangscode[^:]*: ([A-Z0-9]{8})/.exec(m.text)![1]!;
    expect(m.raw).toContain(`<code>${code}</code>`);
    expect(m.raw).toMatch(/<tg-time unix="\d+" format="wDT">/);
    expect(m.buttons.find((b) => b.copy === code)).toBeDefined();
    expect(m.buttons.find((b) => b.copy?.startsWith('https://t.me/TestTreuhandBot?start=i_'))).toBeDefined();
  });

  it('dialog prompts open the reply field (force_reply)', async () => {
    const h = new Harness();
    await h.text(BUYER, '/newtrade');
    expect(h.last(BUYER).forceReply).toBe(true);
  });

  it('deposit info shows the address as code and offers copy + explorer', async () => {
    const h = new Harness();
    const { address } = await setupFundedTrade(h);
    const deposit = h.to(BUYER).find((m) => m.text.includes('Bereit zur Einzahlung'))!;
    expect(deposit.raw).toContain(`<code>${address}</code>`);
    expect(deposit.buttons.find((b) => b.copy === address)).toBeDefined();
    expect(deposit.buttons.find((b) => b.copy === '0.01000000')).toBeDefined();
    expect(deposit.buttons.find((b) => b.url === `https://mempool.space/signet/address/${address}`)).toBeDefined();
  });

  it('verification shows descriptor as code block with green/red buttons', async () => {
    const h = new Harness();
    await setupFundedTrade(h);
    const v = h.to(ARBITER).find((m) => m.text.includes('Treuhand-Konto ist fertig'))!;
    expect(v.raw).toMatch(/<pre>wsh\(sortedmulti\(2,/);
    expect(v.buttons.find((b) => b.data?.includes(':verify:'))?.style).toBe('success');
    expect(v.buttons.find((b) => b.data?.endsWith(':verifyfail'))?.style).toBe('danger');
  });

  it('PSBT summary is a rich table with addresses; send button turns green after 2 signatures', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const summary = h.to(BUYER).find((m) => m.method === 'sendRichMessage' && m.raw.includes('AUSZAHLUNG'))!;
    expect(summary.raw).toContain('<table>');
    expect(summary.raw).toContain(`<code>${testAddress('seller-payout')}</code>`);
    const psbt = h.psbt(BUYER);
    for (const [id, role] of [
      [BUYER, 'buyer'],
      [SELLER, 'seller'],
    ] as const) {
      await h.click(id, h.button(id, /^s:.*:up$/));
      await h.text(id, signAs(psbt, role));
    }
    await h.click(BUYER, `t:${tradeId}:view`);
    const view = h.last(BUYER);
    expect(view.buttons.find((b) => b.data?.endsWith(':bc'))?.style).toBe('success');
    expect(view.buttons.find((b) => b.disabled)?.text).toMatch(/2 von 2/);
    await h.click(SELLER, h.button(SELLER, /^s:.*:bc$/));
    const sent = h.last(SELLER);
    expect(sent.buttons.find((b) => b.url?.startsWith('https://mempool.space/signet/tx/'))).toBeDefined();
    expect(sent.buttons.find((b) => b.copy && /^[0-9a-f]{64}$/.test(b.copy))).toBeDefined();
  });

  it('dispute content is protected from forwarding', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:dispute`);
    await h.text(BUYER, 'Ware fehlt');
    await h.text(BUYER, '-');
    expect(h.last(ARBITER).protect).toBe(true);
    await h.click(ARBITER, `d:${tradeId}:take`);
    const d = h.last(ARBITER);
    expect(d.protect).toBe(true);
    expect(d.raw).toContain('<blockquote expandable>');
  });

  it('start=t_<ID> deep link opens the trade privately', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.text(BUYER, `/start t_${id}`);
    expect(h.last(BUYER).text).toContain(`#${id}`);
  });
});

describe('ephemeral messages in groups', () => {
  const GROUP = -100777;

  it('refused commands are answered only to the sender', async () => {
    const h = new Harness();
    await h.text(BUYER, '/newtrade', { id: GROUP, type: 'supergroup' });
    const m = h.last(GROUP);
    expect(m.ephemeralFor).toBe(BUYER);
    expect(m.buttons[0]?.url).toBe('https://t.me/TestTreuhandBot?start=menu');
  });

  it('falls back to a normal hint if ephemeral messages are unavailable', async () => {
    const h = new Harness();
    h.ephemeralUnsupported = true;
    await h.text(BUYER, '/newtrade', { id: GROUP, type: 'supergroup' });
    const m = h.last(GROUP);
    expect(m.ephemeralFor).toBeUndefined();
    expect(m.text).toMatch(/privaten Chat/);
  });

  it('/status in a group: public status only, private deep link only for the requester', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await inviteAndJoin(h, id, 'seller', SELLER);
    await h.text(SELLER, `/status ${id}`, { id: GROUP, type: 'supergroup' });
    const msgs = h.to(GROUP);
    const pub = msgs.find((m) => !m.ephemeralFor)!;
    expect(pub.text).toMatch(new RegExp(`Handel #${id}: `));
    expect(pub.buttons).toHaveLength(0);
    const eph = msgs.find((m) => m.ephemeralFor === SELLER)!;
    expect(eph.buttons[0]?.url).toBe(`https://t.me/TestTreuhandBot?start=t_${id}`);
  });
});

/** Checks Telegram HTML parse-mode rules: allowed tags only, balanced, no pre/code inside spoiler, no nested quotes. */
function validateTelegramHtml(raw: string): string[] {
  const allowed = new Set([
    'b',
    'strong',
    'i',
    'em',
    'u',
    'ins',
    's',
    'strike',
    'del',
    'tg-spoiler',
    'a',
    'tg-emoji',
    'tg-time',
    'code',
    'pre',
    'blockquote',
  ]);
  const errors: string[] = [];
  const stack: string[] = [];
  for (const m of raw.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    const [, close, tag] = m;
    if (!allowed.has(tag!)) errors.push(`tag <${tag}> not allowed`);
    if (close) {
      if (stack.pop() !== tag) errors.push(`unbalanced </${tag}>`);
    } else {
      if ((tag === 'code' || tag === 'pre') && stack.includes('tg-spoiler')) errors.push(`<${tag}> inside spoiler`);
      if (tag === 'blockquote' && stack.includes('blockquote')) errors.push('nested blockquote');
      stack.push(tag!);
    }
  }
  if (stack.length) errors.push(`unclosed ${stack.join(',')}`);
  if (/&(?!lt;|gt;|amp;|quot;|#\d+;)/.test(raw)) errors.push('unescaped &');
  return errors;
}

describe('all HTML sent in a full trade is valid Telegram markup', () => {
  it('release + dispute flows', async () => {
    const h = new Harness();
    h.richUnsupported = true; // force HTML fallback of rich views too
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:view`);
    await h.click(BUYER, `t:${tradeId}:terms`);
    await h.click(BUYER, `t:${tradeId}:pay`);
    await h.click(BUYER, `t:${tradeId}:parts`);
    await h.click(BUYER, `t:${tradeId}:fees`);
    await h.text(BUYER, '/privacy');
    await h.text(BUYER, '/help');
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    await h.click(SELLER, `t:${tradeId}:dispute`);
    await h.text(SELLER, 'Problem <mit> & "Zeichen"');
    await h.text(SELLER, 'https://cryptgeon.org/note/x');
    await h.click(ARBITER, `d:${tradeId}:take`);
    const htmlMsgs = h.sent.filter((m) => m.parseMode === 'HTML');
    expect(htmlMsgs.length).toBeGreaterThan(15);
    for (const m of htmlMsgs) expect(validateTelegramHtml(m.raw), m.raw.slice(0, 120)).toEqual([]);
  });
});

describe('HTML validator self-check', () => {
  it('detects invalid markup', () => {
    expect(validateTelegramHtml('<tg-spoiler><code>x</code></tg-spoiler>')).toContain('<code> inside spoiler');
    expect(validateTelegramHtml('<table>')).not.toEqual([]);
    expect(validateTelegramHtml('<b>x')).not.toEqual([]);
    expect(validateTelegramHtml('a & b')).toContain('unescaped &');
    expect(validateTelegramHtml('<blockquote><blockquote>x</blockquote></blockquote>')).toContain('nested blockquote');
  });
});
