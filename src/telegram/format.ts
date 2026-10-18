/**
 * Telegram formatting helpers (HTML parse mode and rich-message HTML).
 * Every dynamic value MUST pass through esc() before it is placed in markup.
 */

export function esc(value: string | number | bigint): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const b = (s: string): string => `<b>${s}</b>`;
export const i = (s: string): string => `<i>${s}</i>`;
export const code = (s: string): string => `<code>${esc(s)}</code>`;
export const pre = (s: string): string => `<pre>${esc(s)}</pre>`;
export const quote = (s: string, expandable = false): string => `<blockquote${expandable ? ' expandable' : ''}>${s}</blockquote>`;

export function link(url: string, text: string): string {
  return `<a href="${esc(url)}">${esc(text)}</a>`;
}

/**
 * Date/time shown in the reader's local format (tg-time entity).
 * format: 'r' relative, 'wDT' weekday+long date+time, 'dt' short date+time.
 */
export function time(unix: number, format: 'r' | 'wDT' | 'dt' | 'DT' = 'wDT'): string {
  const fallback = new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `<tg-time unix="${Math.floor(unix)}" format="${format}">${fallback}</tg-time>`;
}

/** Plain-text rendering of our markup (fallback for clients/tests; also used for length checks). */
export function toPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|h[1-6]|tr|li|details|summary|blockquote|pre)>/g, '\n')
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts rich-message HTML (tables, headings, details) to classic HTML parse-mode markup,
 * used as fallback when sendRichMessage is not available.
 */
export function richToHtml(rich: string): string {
  return rich
    .replace(/<h[1-6]>(.*?)<\/h[1-6]>/gs, '<b>$1</b>\n')
    .replace(/<details[^>]*>\s*<summary>(.*?)<\/summary>(.*?)<\/details>/gs, '<b>$1</b>\n<blockquote expandable>$2</blockquote>\n')
    .replace(/<table[^>]*>/g, '')
    .replace(/<\/table>/g, '\n')
    .replace(/<tr>/g, '')
    .replace(/<\/tr>/g, '\n')
    .replace(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs, '$1  ')
    .replace(/<\/?(p|ul|ol)>/g, '')
    .replace(/<li>/g, '• ')
    .replace(/<\/li>/g, '\n')
    .replace(/<hr\s*\/?>/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Simple rich table: first row is the header. Cells must already be escaped/marked up. */
export function table(rows: string[][], header = true): string {
  const tr = (cells: string[], tag: 'td' | 'th') => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  return `<table>${rows.map((r, idx) => tr(r, header && idx === 0 ? 'th' : 'td')).join('')}</table>`;
}

export function explorerTxUrl(network: 'signet' | 'mainnet', txid: string): string {
  return `${network === 'mainnet' ? 'https://mempool.space' : 'https://mempool.space/signet'}/tx/${txid}`;
}

export function explorerAddressUrl(network: 'signet' | 'mainnet', address: string): string {
  return `${network === 'mainnet' ? 'https://mempool.space' : 'https://mempool.space/signet'}/address/${address}`;
}

/** BTC amount with a dot, as wallets expect when pasting ("0.01000000"). */
export function btcForWallet(sats: bigint): string {
  const s = sats.toString().padStart(9, '0');
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}
