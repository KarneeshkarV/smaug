import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeTwitterCliTweet, parseTwitterCliOutput, createTwitterClient } from '../src/twitter-client.js';

describe('normalizeTwitterCliTweet', () => {
  test('maps author, date, quote, and article to the bird shape', () => {
    const tweet = normalizeTwitterCliTweet({
      id: '1',
      text: 'hello',
      createdAt: 'Sat Sep 27 10:00:00 +0000 2026',
      createdAtISO: '2026-09-27T10:00:00+00:00',
      author: { screenName: 'alice', name: 'Alice' },
      quotedTweet: { id: '2', author: { screenName: 'bob' }, createdAtISO: '2026-09-26T10:00:00+00:00' },
      articleTitle: 'Title',
      articleText: 'x'.repeat(300)
    });
    assert.strictEqual(tweet.author.username, 'alice');
    assert.strictEqual(tweet.createdAt, '2026-09-27T10:00:00+00:00');
    assert.strictEqual(tweet.quotedTweet.author.username, 'bob');
    assert.strictEqual(tweet.article.title, 'Title');
    assert.strictEqual(tweet.article.previewText.length, 280);
    assert.strictEqual(tweet.article.content.length, 300);
  });
});

describe('parseTwitterCliOutput', () => {
  test('returns data on success', () => {
    assert.deepStrictEqual(parseTwitterCliOutput('{"ok":true,"data":[1]}'), [1]);
  });

  test('throws the error code and message on failure', () => {
    assert.throws(
      () => parseTwitterCliOutput('{"ok":false,"error":{"code":"auth","message":"expired"}}'),
      /twitter-cli auth: expired/
    );
  });
});

describe('createTwitterClient', () => {
  test('defaults to bird', () => {
    assert.strictEqual(createTwitterClient({}).name, 'bird');
  });

  test('rejects an unknown client', () => {
    assert.throws(() => createTwitterClient({ twitterClient: 'curl' }), /Invalid twitterClient/);
  });

  for (const twitterClient of ['bird', 'twitter-cli']) {
    test(`${twitterClient} rejects IDs that are not digits before running a command`, () => {
      const client = createTwitterClient({ twitterClient, birdPath: '/nonexistent', twitterCliPath: '/nonexistent' });
      assert.throws(() => client.readTweet('1; rm -rf ~'), /Invalid tweet ID/);
      assert.throws(() => client.bookmarks(5, { folderId: '$(id)' }), /Invalid folder ID/);
      assert.throws(() => client.bookmarks('5 --x'), /Invalid count/);
    });
  }
});
