import { GrammyError, type Api } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup, ForceReply } from 'grammy/types';
import { TELEGRAM_MAX_MESSAGE_CHARS } from '../config/constants.ts';
import type { Button, MessageContent } from '../domain/context.ts';
import { richToHtml, toPlain } from './format.ts';

function toButton(b: Button): InlineKeyboardButton {
  if ('disabled' in b) return { text: b.text, disabled: {} };
  const style = b.style ? { style: b.style } : {};
  if ('url' in b) return { text: b.text, url: b.url, ...style };
  if ('copy' in b) return { text: b.text, copy_text: { text: b.copy.slice(0, 256) }, ...style };
  return { text: b.text, callback_data: b.data, ...style };
}

export function toMarkup(c: Pick<MessageContent, 'buttons' | 'forceReply'>): InlineKeyboardMarkup | ForceReply | undefined {
  if (c.buttons && c.buttons.length > 0) {
    return { inline_keyboard: c.buttons.map((row) => row.map(toButton)), ...(c.forceReply ? { force_reply: true } : {}) };
  }
  if (c.forceReply) {
    return { force_reply: true, ...(c.forceReply.placeholder ? { input_field_placeholder: c.forceReply.placeholder.slice(0, 64) } : {}) };
  }
  return undefined;
}

export interface SendOptions {
  /** Show the message only to this user (ephemeral message in groups). */
  ephemeralFor?: number;
}

function clip(s: string): string {
  return s.length > TELEGRAM_MAX_MESSAGE_CHARS ? `${s.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 1)}…` : s;
}

/**
 * Sends one message with graceful degradation:
 * rich message → HTML parse mode → plain text. Ephemeral sending falls back to a normal message
 * only for content that is safe for everyone in the chat (callers decide via ephemeralFor).
 */
export async function sendContent(api: Api, chatId: number, c: MessageContent, o: SendOptions = {}): Promise<void> {
  if (c.album && c.album.length >= 2) {
    await api.sendMediaGroup(
      chatId,
      c.album.slice(0, 10).map((media) => ({ type: 'photo' as const, media })),
    );
  }
  const reply_markup = toMarkup(c);
  const common = {
    ...(reply_markup ? { reply_markup } : {}),
    ...(c.protect ? { protect_content: true } : {}),
    ...(o.ephemeralFor ? { ephemeral_message_parameters: { receiver_user_id: o.ephemeralFor } } : {}),
  };

  if (c.rich) {
    try {
      await api.sendRichMessage(chatId, { html: c.rich, skip_entity_detection: true }, common);
      return;
    } catch (e) {
      if (!(e instanceof GrammyError) || e.error_code !== 400) throw e;
      // fall through to classic HTML
    }
  }
  const html = c.html ?? (c.rich ? richToHtml(c.rich) : undefined);
  if (html) {
    try {
      await api.sendMessage(chatId, clip(html), { ...common, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return;
    } catch (e) {
      if (!(e instanceof GrammyError) || e.error_code !== 400 || !/parse|entit|tag/i.test(e.description)) throw e;
      // markup rejected: degrade to plain text below
    }
  }
  const text = c.text || (html ? toPlain(html) : '');
  await api.sendMessage(chatId, clip(text), { ...common, link_preview_options: { is_disabled: true } });
}
