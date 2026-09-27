/**
 * Twitter clients - run bird or twitter-cli and return tweets in bird's JSON shape.
 *
 * Commands run with execFileSync and an argument array, never through a shell,
 * so config values and tweet IDs cannot inject shell syntax.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

function digitsOnly(value, label) {
  const str = String(value ?? '');
  if (!/^\d+$/.test(str)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return str;
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return String(n);
}

function run(bin, args, { env, timeout }) {
  return execFileSync(bin, args, { encoding: 'utf8', env, timeout });
}

/**
 * Run a command with stdout sent to a private temp file (works around bird's pipe buffering bug).
 * mkdtemp creates the directory with mode 0700, so other users cannot read or replace the file.
 */
function runToFile(bin, args, { env, timeout }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smaug-'));
  const file = path.join(dir, 'output.json');
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    execFileSync(bin, args, { env, timeout, stdio: ['ignore', fd, 'inherit'] });
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// bird (https://github.com/steipete/bird)
// ---------------------------------------------------------------------------

// bird CLI may return array or { tweets: [...] } depending on version
function birdTweetList(parsed) {
  return Array.isArray(parsed) ? parsed : (parsed.tweets || []);
}

function createBirdClient(config) {
  const bin = config.birdPath || 'bird';
  const env = { ...process.env };
  if (config.twitter?.authToken) env.AUTH_TOKEN = config.twitter.authToken;
  if (config.twitter?.ct0) env.CT0 = config.twitter.ct0;

  return {
    name: 'bird',

    bookmarks(count, { all = false, maxPages, folderId } = {}) {
      const args = ['bookmarks'];
      if (folderId) args.push('--folder-id', digitsOnly(folderId, 'folder ID'));
      if (all) {
        args.push('--all', '--max-pages', positiveInt(maxPages, 'maxPages'));
      } else {
        args.push('-n', positiveInt(count, 'count'));
      }
      args.push('--json');
      // Paginated fetch needs a longer timeout
      const output = runToFile(bin, args, { env, timeout: all ? 180000 : 60000 });
      return birdTweetList(JSON.parse(output));
    },

    likes(count) {
      const output = runToFile(bin, ['likes', '-n', positiveInt(count, 'count'), '--json'], { env, timeout: 60000 });
      return birdTweetList(JSON.parse(output));
    },

    readTweet(tweetId, { timeout = 30000 } = {}) {
      const output = run(bin, ['read', digitsOnly(tweetId, 'tweet ID'), '--json'], { env, timeout });
      return JSON.parse(output);
    },

    search(query, count) {
      const output = run(bin, ['search', query, '-n', positiveInt(count, 'count'), '--json'], { env, timeout: 30000 });
      return birdTweetList(JSON.parse(output));
    }
  };
}

// ---------------------------------------------------------------------------
// twitter-cli (https://github.com/jackwener/twitter-cli)
// ---------------------------------------------------------------------------

/**
 * Convert a twitter-cli tweet to the bird shape the processor reads.
 * twitter-cli does not report reply parents, so reply context is not available.
 */
export function normalizeTwitterCliTweet(tweet) {
  if (!tweet || typeof tweet !== 'object') return tweet;
  const normalized = {
    ...tweet,
    createdAt: tweet.createdAtISO || tweet.createdAt,
    author: tweet.author && { ...tweet.author, username: tweet.author.screenName }
  };
  if (tweet.quotedTweet) {
    normalized.quotedTweet = normalizeTwitterCliTweet(tweet.quotedTweet);
  }
  if (tweet.articleTitle || tweet.articleText) {
    normalized.article = {
      title: tweet.articleTitle || null,
      previewText: tweet.articleText ? tweet.articleText.slice(0, 280) : null,
      content: tweet.articleText || null
    };
  }
  return normalized;
}

// twitter-cli wraps output as { ok, schema_version, data } or { ok: false, error }
export function parseTwitterCliOutput(output) {
  const parsed = JSON.parse(output);
  if (parsed.ok === false) {
    const { code = 'error', message = 'unknown error' } = parsed.error || {};
    throw new Error(`twitter-cli ${code}: ${message}`);
  }
  return parsed.data;
}

function twitterCliTweetList(output) {
  const data = parseTwitterCliOutput(output);
  return (Array.isArray(data) ? data : []).map(normalizeTwitterCliTweet);
}

function createTwitterCliClient(config) {
  const bin = config.twitterCliPath || 'twitter';
  const env = { ...process.env };
  // Without these, twitter-cli reads cookies from the local browser
  if (config.twitter?.authToken) env.TWITTER_AUTH_TOKEN = config.twitter.authToken;
  if (config.twitter?.ct0) env.TWITTER_CT0 = config.twitter.ct0;

  return {
    name: 'twitter-cli',

    bookmarks(count, { all = false, maxPages, folderId } = {}) {
      // twitter-cli paginates by itself; --all maps to a larger -n (bird returns ~20 per page)
      const max = all ? Math.max(count, (maxPages || 10) * 20) : count;
      const args = folderId
        ? ['bookmarks', 'folders', digitsOnly(folderId, 'folder ID')]
        : ['bookmarks'];
      args.push('-n', positiveInt(max, 'count'), '--json');
      const output = runToFile(bin, args, { env, timeout: all ? 180000 : 60000 });
      return twitterCliTweetList(output);
    },

    likes(count) {
      const me = parseTwitterCliOutput(run(bin, ['whoami', '--json'], { env, timeout: 30000 }));
      const screenName = me?.user?.screenName;
      if (!screenName || !/^\w+$/.test(screenName)) {
        throw new Error('twitter-cli whoami did not return a screen name');
      }
      const output = runToFile(bin, ['likes', screenName, '-n', positiveInt(count, 'count'), '--json'], { env, timeout: 60000 });
      return twitterCliTweetList(output);
    },

    readTweet(tweetId, { timeout = 30000 } = {}) {
      const id = digitsOnly(tweetId, 'tweet ID');
      const tweets = twitterCliTweetList(run(bin, ['tweet', id, '-n', '1', '--json'], { env, timeout }));
      // The result also holds replies; pick the requested tweet
      const tweet = tweets.find(t => String(t.id) === id) || tweets[0];
      if (!tweet) throw new Error(`twitter-cli returned no tweet for ${id}`);
      return tweet;
    },

    search(query, count) {
      const output = run(bin, ['search', query, '-n', positiveInt(count, 'count'), '--json'], { env, timeout: 30000 });
      return twitterCliTweetList(output);
    }
  };
}

/**
 * Create the Twitter client selected by config.twitterClient ('bird' or 'twitter-cli').
 */
export function createTwitterClient(config = {}) {
  const kind = config.twitterClient || 'bird';
  if (kind === 'bird') return createBirdClient(config);
  if (kind === 'twitter-cli') return createTwitterCliClient(config);
  throw new Error(`Invalid twitterClient: ${kind}. Must be 'bird' or 'twitter-cli'.`);
}
