/**
 * WhatsApp source - read tweet links shared in WhatsApp chats via wacli
 * (https://wacli.sh).
 *
 * wacli runs with --read-only against its local store, so smaug never sends
 * WhatsApp messages or changes the store. Keep the store current with
 * `wacli sync`. Only X/Twitter status links are used; other links and the
 * message text are not passed on, because they can be private.
 */

import { execFileSync } from 'child_process';

const TWEET_URL = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:\w+|i(?:\/web)?)\/status(?:es)?\/(\d+)/g;

// wacli chat JIDs look like 919812345678@s.whatsapp.net or 1203...@g.us
const CHAT_JID = /^[\w.-]+@[\w.-]+$/;

export function extractTweetIds(text) {
  return [...(text || '').matchAll(TWEET_URL)].map(m => m[1]);
}

function listMessages(config, chatJid, limit) {
  const bin = config.whatsapp?.wacliPath || 'wacli';
  const output = execFileSync(bin, [
    '--read-only', 'messages', 'list',
    '--chat', chatJid,
    '--limit', String(limit),
    '--json'
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 * 1024 });
  const parsed = JSON.parse(output);
  if (!parsed.success) {
    throw new Error(`wacli: ${parsed.error?.message || parsed.error || 'unknown error'}`);
  }
  return parsed.data?.messages || [];
}

/**
 * Find tweet links in the configured chats, newest first.
 * Returns [{ tweetId, chatJid, tag, sharedAt }], one entry per tweet ID.
 */
export function findSharedTweets(config) {
  const chats = config.whatsapp?.chats || {};
  const limit = Number(config.whatsapp?.messageLimit) || 1000;
  const found = new Map();

  for (const [chatJid, tag] of Object.entries(chats)) {
    if (!CHAT_JID.test(chatJid)) {
      throw new Error(`Invalid WhatsApp chat JID: ${JSON.stringify(chatJid)}`);
    }
    for (const message of listMessages(config, chatJid, limit)) {
      const text = [message.Text, message.MediaCaption].filter(Boolean).join('\n');
      for (const tweetId of extractTweetIds(text)) {
        const existing = found.get(tweetId);
        if (!existing || message.Timestamp > existing.sharedAt) {
          found.set(tweetId, { tweetId, chatJid, tag, sharedAt: message.Timestamp });
        }
      }
    }
  }

  return [...found.values()].sort((a, b) => (a.sharedAt < b.sharedAt ? 1 : -1));
}
