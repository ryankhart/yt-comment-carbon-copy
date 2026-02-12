const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStorage() {
  const store = {};
  return {
    async get(keys) {
      if (typeof keys === 'string') {
        return { [keys]: store[keys] };
      }
      if (Array.isArray(keys)) {
        const result = {};
        keys.forEach((key) => {
          result[key] = store[key];
        });
        return result;
      }
      if (keys && typeof keys === 'object') {
        const result = {};
        Object.keys(keys).forEach((key) => {
          result[key] = store[key] === undefined ? keys[key] : store[key];
        });
        return result;
      }
      return { ...store };
    },
    async set(values) {
      Object.assign(store, values || {});
    }
  };
}

function loadBackgroundHooks() {
  const scriptPath = path.join(__dirname, '..', 'src', 'background.js');
  const code = fs.readFileSync(scriptPath, 'utf8');
  const storage = createStorage();

  const sandbox = {
    console: {
      log() {},
      warn() {},
      error() {}
    },
    chrome: {
      storage: {
        local: storage
      },
      runtime: {
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener() {} }
      },
      alarms: {
        async clear() {},
        async create() {},
        onAlarm: { addListener() {} }
      },
      notifications: {
        async create() {}
      },
      tabs: {
        async query() { return []; },
        async sendMessage() { return {}; },
        async create() { return { id: 1 }; },
        async remove() {}
      }
    },
    setTimeout(fn) {
      return fn();
    },
    clearTimeout() {}
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: scriptPath });
  return sandbox.__YTCC_BACKGROUND_TEST_HOOKS__;
}

const hooks = loadBackgroundHooks();

test('normalizeSettings constrains unsupported values to defaults', () => {
  const normalized = hooks.normalizeSettings({
    autoCheckEnabled: true,
    autoCheckIntervalHours: 7,
    autoCheckNotifications: 1,
    autoArchiveHours: 999
  });

  assert.deepEqual(toPlain(normalized), {
    autoCheckEnabled: true,
    autoCheckIntervalHours: 12,
    autoCheckNotifications: true,
    autoArchiveHours: 24
  });
});

test('getAutoArchiveAfterMs supports disabling auto-archive', () => {
  assert.equal(hooks.getAutoArchiveAfterMs(0), null);
  assert.equal(hooks.getAutoArchiveAfterMs(24), 24 * 60 * 60 * 1000);
});

test('applyStatusTransition maintains consistent status lifecycle fields', () => {
  const base = {
    id: 'c1',
    status: hooks.STATUS_ACTIVE,
    lastCheckedAt: null,
    deletedAt: null,
    archivedAt: null,
    unknownAt: null,
    unknownReason: null
  };

  const deleted = hooks.applyStatusTransition(base, { status: hooks.STATUS_DELETED }, 1000);
  assert.equal(deleted.status, hooks.STATUS_DELETED);
  assert.equal(deleted.lastCheckedAt, 1000);
  assert.equal(deleted.deletedAt, 1000);
  assert.equal(deleted.archivedAt, null);
  assert.equal(deleted.unknownAt, null);

  const activeAgain = hooks.applyStatusTransition(deleted, { status: hooks.STATUS_ACTIVE }, 2000);
  assert.equal(activeAgain.status, hooks.STATUS_ACTIVE);
  assert.equal(activeAgain.deletedAt, null);
  assert.equal(activeAgain.lastCheckedAt, 2000);

  const unknown = hooks.applyStatusTransition(
    activeAgain,
    { status: hooks.STATUS_UNKNOWN, unknownReason: 'comments_not_loaded', updateLastCheckedAt: false },
    3000
  );
  assert.equal(unknown.status, hooks.STATUS_UNKNOWN);
  assert.equal(unknown.lastCheckedAt, 2000);
  assert.equal(unknown.unknownAt, 3000);
  assert.equal(unknown.unknownReason, 'comments_not_loaded');
});
