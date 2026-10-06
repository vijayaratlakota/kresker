'use strict';
/*
  Storage provider configuration, Cloudflare R2 flavour (src/storage.ts), offline.

  With only R2_* keys the backend keeps its original behaviour: path-style addressing on
  the account's R2 endpoint, region "auto" in the signature scope. Checked against the
  same independent SigV4 implementation as the S3 test.
*/
const { test, mock, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sigv4 = require('./sigv4');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kresker-r2-test-'));
const envFile = path.join(DIR, 'r2.env');
// The odd spacing and CRLF line ends are what the real file looked like.
fs.writeFileSync(envFile, 'R2_ACCOUNT_ID= 0123456789abcdef0123456789abcdef\r\nR2_ACCESS_KEY_ID = test-access\r\nR2_SECRET_ACCESS_KEY = test-secret\r\nR2_BUCKET = test-dubs\r\n');
process.env.VS_DATA_DIR = path.join(DIR, 'data');
process.env.VS_R2_ENABLED = '1';
process.env.VS_R2_ENV = envFile;

const storage = require('../dist/storage');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('R2_* keys select Cloudflare R2', () => {
  assert.equal(storage.enabled(), true);
  const st = storage.status();
  assert.equal(st.backend, 'cloudflare-r2');
  assert.equal(st.bucket, 'test-dubs');
  assert.equal(st.region, 'auto');
});

test('R2 presigned upload: path-style, region auto, identical to independent SigV4', () => {
  const now = new Date('2026-10-06T09:15:30.000Z');
  mock.timers.enable({ apis: ['Date'], now });
  try {
    const key = storage.stagingKey(7, 'u0001', 'clip.mp4');
    const got = storage.presignPut(key, 900);
    const want = sigv4.presignPut({
      host: '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      path: `/test-dubs/${key}`,
      expiresS: 900,
      now,
    });
    assert.equal(got, want);
    assert.equal(new URL(got).pathname, '/test-dubs/_incoming/7/u0001/clip.mp4', 'path-style: the bucket is in the path');
  } finally {
    mock.timers.reset();
  }
});
