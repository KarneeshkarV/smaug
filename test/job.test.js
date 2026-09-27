import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { findClaude, getPathSeparator, getAIAccess, getCLISettings } from '../src/job.js';

describe('findClaude', () => {
  describe('Unix/macOS', () => {
    test('returns default "claude" when no paths exist and which fails', () => {
      const result = findClaude({
        platform: 'darwin',
        env: { HOME: '/Users/test' },
        existsSync: () => false,
        execSyncFn: () => { throw new Error('not found'); }
      });
      assert.strictEqual(result, 'claude');
    });

    test('finds claude in /usr/local/bin', () => {
      const result = findClaude({
        platform: 'darwin',
        env: { HOME: '/Users/test' },
        existsSync: (p) => p === '/usr/local/bin/claude',
        execSyncFn: () => { throw new Error('not found'); }
      });
      assert.strictEqual(result, '/usr/local/bin/claude');
    });

    test('finds claude in homebrew path', () => {
      const result = findClaude({
        platform: 'darwin',
        env: { HOME: '/Users/test' },
        existsSync: (p) => p === '/opt/homebrew/bin/claude',
        execSyncFn: () => { throw new Error('not found'); }
      });
      assert.strictEqual(result, '/opt/homebrew/bin/claude');
    });

    test('finds claude via which command', () => {
      const result = findClaude({
        platform: 'darwin',
        env: { HOME: '/Users/test' },
        existsSync: () => false,
        execSyncFn: (cmd) => {
          assert.strictEqual(cmd, 'which claude');
          return '/some/custom/path/claude\n';
        }
      });
      assert.strictEqual(result, '/some/custom/path/claude');
    });

    test('uses which (not where) on Unix', () => {
      let commandUsed = null;
      findClaude({
        platform: 'linux',
        env: { HOME: '/home/test' },
        existsSync: () => false,
        execSyncFn: (cmd) => {
          commandUsed = cmd;
          throw new Error('not found');
        }
      });
      assert.strictEqual(commandUsed, 'which claude');
    });
  });

  describe('Windows', () => {
    test('checks Windows-specific paths on win32', () => {
      const checkedPaths = [];
      findClaude({
        platform: 'win32',
        env: {
          HOME: 'C:\\Users\\test',
          APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
          USERPROFILE: 'C:\\Users\\test',
          PROGRAMFILES: 'C:\\Program Files'
        },
        existsSync: (p) => {
          checkedPaths.push(p);
          return false;
        },
        execSyncFn: () => { throw new Error('not found'); }
      });

      // Should check Windows paths
      assert.ok(
        checkedPaths.some(p => p.includes('npm') && p.includes('claude.cmd')),
        'should check npm claude.cmd path'
      );
      assert.ok(
        checkedPaths.some(p => p.includes('claude.exe')),
        'should check .exe paths'
      );
    });

    test('finds claude.cmd in npm directory', () => {
      // Note: path.join on Unix will use forward slashes, so we need to match
      // what path.join actually produces, not Windows-native paths
      const appdata = 'C:\\Users\\test\\AppData\\Roaming';
      const expectedPath = path.join(appdata, 'npm', 'claude.cmd');
      const result = findClaude({
        platform: 'win32',
        env: {
          HOME: 'C:\\Users\\test',
          APPDATA: appdata,
          LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
          USERPROFILE: 'C:\\Users\\test',
          PROGRAMFILES: 'C:\\Program Files'
        },
        existsSync: (p) => p === expectedPath,
        execSyncFn: () => { throw new Error('not found'); }
      });
      assert.strictEqual(result, expectedPath);
    });

    test('uses where (not which) on Windows', () => {
      let commandUsed = null;
      findClaude({
        platform: 'win32',
        env: {
          HOME: 'C:\\Users\\test',
          APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
          USERPROFILE: 'C:\\Users\\test',
          PROGRAMFILES: 'C:\\Program Files'
        },
        existsSync: () => false,
        execSyncFn: (cmd) => {
          commandUsed = cmd;
          throw new Error('not found');
        }
      });
      assert.strictEqual(commandUsed, 'where claude');
    });

    test('handles where returning multiple lines (takes first)', () => {
      const result = findClaude({
        platform: 'win32',
        env: {
          HOME: 'C:\\Users\\test',
          APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
          USERPROFILE: 'C:\\Users\\test',
          PROGRAMFILES: 'C:\\Program Files'
        },
        existsSync: () => false,
        execSyncFn: () => 'C:\\First\\Path\\claude.cmd\nC:\\Second\\Path\\claude.cmd\n'
      });
      assert.strictEqual(result, 'C:\\First\\Path\\claude.cmd');
    });
  });
});

describe('getPathSeparator', () => {
  test('returns semicolon for Windows', () => {
    assert.strictEqual(getPathSeparator('win32'), ';');
  });

  test('returns colon for macOS', () => {
    assert.strictEqual(getPathSeparator('darwin'), ':');
  });

  test('returns colon for Linux', () => {
    assert.strictEqual(getPathSeparator('linux'), ':');
  });

  test('returns colon for unknown platforms', () => {
    assert.strictEqual(getPathSeparator('freebsd'), ':');
  });
});

describe('AI CLI sandbox', () => {
  const config = {
    projectRoot: '/proj',
    archiveFile: '/vault/bookmarks.md',
    pendingFile: './.state/pending-bookmarks.json',
    categories: { github: { folder: './knowledge/tools' }, tweet: { action: 'capture' } }
  };

  test('getAIAccess limits writes to the archive, pending dir, and category folders', () => {
    const access = getAIAccess(config);
    assert.deepStrictEqual(access.writeDirs, ['/proj/.state', '/proj/knowledge/tools']);
    assert.deepStrictEqual(access.writeFiles, ['/vault/bookmarks.md']);
    assert.ok(access.readDirs.includes('/proj'));
    assert.ok(access.readDirs.includes('/vault'));
  });

  for (const cliType of ['claude', 'opencode']) {
    test(`${cliType}: Twitter secrets are not passed to the AI CLI`, () => {
      const saved = { ...process.env };
      Object.assign(process.env, { AUTH_TOKEN: 'a', CT0: 'b', TWITTER_AUTH_TOKEN: 'c', TWITTER_CT0: 'd' });
      try {
        const { env } = getCLISettings(cliType, config, 1);
        for (const key of ['AUTH_TOKEN', 'CT0', 'TWITTER_AUTH_TOKEN', 'TWITTER_CT0']) {
          assert.strictEqual(env[key], undefined, key);
        }
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      }
    });
  }

  test('claude: no Bash, restricted file rules, config denied', () => {
    const { args } = getCLISettings('claude', config, 1);
    const arg = flag => args[args.indexOf(flag) + 1];
    assert.ok(!arg('--tools').split(',').includes('Bash'));
    assert.strictEqual(arg('--permission-mode'), 'dontAsk');
    assert.strictEqual(arg('--setting-sources'), '');
    assert.ok(args.includes('--strict-mcp-config'));
    const allow = arg('--allowedTools').split(',');
    assert.ok(allow.includes('Edit(//vault/bookmarks.md)'));
    assert.ok(allow.includes('Edit(//proj/knowledge/tools/**)'));
    assert.ok(!allow.some(r => r.startsWith('Edit(//proj/**')));
    assert.ok(arg('--disallowedTools').split(',').includes('Read(//proj/smaug.config.json)'));
  });

  test('opencode: shell and web tools blocked, edits denied by default', () => {
    const { env } = getCLISettings('opencode', config, 1);
    const { permission } = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.strictEqual(permission.bash, 'ask');
    assert.strictEqual(permission.webfetch, 'deny');
    assert.strictEqual(permission.edit['*'], 'deny');
    assert.strictEqual(permission.read['*smaug.config.json'], 'deny');
  });
});
