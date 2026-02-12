const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadContentHooks() {
  const scriptPath = path.join(__dirname, '..', 'src', 'content.js');
  const code = fs.readFileSync(scriptPath, 'utf8');

  const sandbox = {
    console: {
      log() {},
      warn() {},
      error() {}
    },
    window: {
      location: {
        origin: 'https://www.youtube.com',
        href: 'https://www.youtube.com/watch?v=seed'
      },
      innerHeight: 900,
      scrollBy() {}
    },
    document: {
      body: {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {}
    },
    chrome: {
      runtime: {
        sendMessage() {},
        onMessage: {
          addListener() {}
        }
      }
    },
    MutationObserver: class {
      observe() {}
    },
    URL,
    setTimeout() {
      return 0;
    },
    clearTimeout() {}
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: scriptPath });
  return sandbox.__YTCC_CONTENT_TEST_HOOKS__;
}

const hooks = loadContentHooks();

test('getVideoIdFromUrl handles watch, shorts, and live URLs', () => {
  assert.equal(hooks.getVideoIdFromUrl('https://www.youtube.com/watch?v=abc123'), 'abc123');
  assert.equal(hooks.getVideoIdFromUrl('https://www.youtube.com/shorts/xyz987'), 'xyz987');
  assert.equal(hooks.getVideoIdFromUrl('https://www.youtube.com/live/live456'), 'live456');
  assert.equal(hooks.getVideoIdFromUrl('https://www.youtube.com/feed/subscriptions'), null);
});

test('getCommentIdFromUrl extracts lc query parameter', () => {
  assert.equal(
    hooks.getCommentIdFromUrl('https://www.youtube.com/watch?v=abc123&lc=UgxCommentId1'),
    'UgxCommentId1'
  );
  assert.equal(hooks.getCommentIdFromUrl('/watch?v=abc123&lc=UgxCommentId2'), 'UgxCommentId2');
  assert.equal(hooks.getCommentIdFromUrl('https://www.youtube.com/watch?v=abc123'), null);
});

test('shouldSkipDuplicateCapture respects time window and text/video match', () => {
  const lastCapture = {
    videoId: 'video-1',
    text: 'same comment',
    at: 1000
  };

  assert.equal(
    hooks.shouldSkipDuplicateCapture(lastCapture, 'video-1', 'same comment', 2500, 2000),
    true
  );
  assert.equal(
    hooks.shouldSkipDuplicateCapture(lastCapture, 'video-1', 'same comment', 3200, 2000),
    false
  );
  assert.equal(
    hooks.shouldSkipDuplicateCapture(lastCapture, 'video-2', 'same comment', 1500, 2000),
    false
  );
});

test('mapVerificationResults prefers ID matches and uses cautious text fallback', () => {
  const byId = new Map([
    ['KnownCommentId', { commentId: 'KnownCommentId', commentUrl: 'https://example.test/id' }],
    ['FromUrlOnly', { commentId: 'FromUrlOnly', commentUrl: 'https://example.test/url' }]
  ]);

  const byText = new Map([
    [hooks.normalizeText('Unique text'), [{ commentId: 'UniqueTextId', commentUrl: 'https://example.test/unique' }]],
    [hooks.normalizeText('Duplicate text'), [{ commentId: 'DupA' }, { commentId: 'DupB' }]]
  ]);

  const input = [
    { id: 'a', text: 'ignored', commentId: 'KnownCommentId' },
    { id: 'b', text: 'ignored', commentUrl: 'https://www.youtube.com/watch?v=v1&lc=FromUrlOnly' },
    { id: 'c', text: 'Unique text' },
    { id: 'd', text: 'Duplicate text' },
    { id: 'e', text: 'Missing text' }
  ];

  const results = hooks.mapVerificationResults(input, byText, byId);
  const byLocalId = Object.fromEntries(results.map((result) => [result.id, result]));

  assert.deepEqual(toPlain(byLocalId.a), {
    id: 'a',
    found: true,
    commentId: 'KnownCommentId',
    commentUrl: 'https://example.test/id'
  });
  assert.deepEqual(toPlain(byLocalId.b), {
    id: 'b',
    found: true,
    commentId: 'FromUrlOnly',
    commentUrl: 'https://example.test/url'
  });
  assert.deepEqual(toPlain(byLocalId.c), {
    id: 'c',
    found: true,
    commentId: 'UniqueTextId',
    commentUrl: 'https://example.test/unique'
  });
  assert.deepEqual(toPlain(byLocalId.d), {
    id: 'd',
    found: true,
    commentId: null,
    commentUrl: null
  });
  assert.deepEqual(toPlain(byLocalId.e), {
    id: 'e',
    found: false,
    commentId: null,
    commentUrl: null
  });
});
