'use strict';
/*
  Provider configuration for the engine: VS_ENGINE_MODE=real selects the HTTP client,
  pointed at VS_ENGINE_URL. (engine.test.js covers the default, the fake.) Configuration
  is read once at start-up, so this needs its own process - which node --test gives every
  test file.
*/
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kresker-mode-test-'));
process.env.VS_DATA_DIR = DATA;
process.env.VS_ENGINE_MODE = 'real';
process.env.VS_ENGINE_URL = 'http://10.0.0.5:3900/';

const engine = require('../dist/engine');
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('VS_ENGINE_MODE=real gives the real client, at the configured URL', () => {
  const e = engine.getEngine();
  assert.ok(e instanceof engine.VoiceStudioEngine);
  assert.equal(e.base, 'http://10.0.0.5:3900');
});
