'use strict';
/*
  Storage switched off, or half-configured (src/storage.ts), offline.

  Credentials in a file and the VS_R2_ENABLED switch are two different states, and only
  both together send bytes to a bucket. Anything less must fall back to local disk
  without throwing: no presigned URL, no download link, no upload attempt.
*/
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kresker-off-test-'));
const envFile = path.join(DIR, 's3.env');
// A bucket and region but no secret: incomplete on purpose.
fs.writeFileSync(envFile, 'STORAGE_BUCKET=example-bucket\nSTORAGE_REGION=ap-south-1\nSTORAGE_ACCESS_KEY_ID=TEST-ACCESS-KEY-ID\n');
process.env.VS_DATA_DIR = path.join(DIR, 'data');
process.env.VS_R2_ENABLED = '1';
process.env.VS_R2_ENV = envFile;

const storage = require('../dist/storage');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('incomplete credentials mean local disk, reported honestly', async () => {
  assert.equal(storage.enabled(), false);
  const st = storage.status();
  assert.equal(st.backend, 'local-disk');
  assert.equal(st.r2_configured, false);
  assert.equal(st.bucket, null);
  assert.equal(storage.presignPut('_incoming/1/x/v.mp4'), null);
  assert.equal(await storage.presign('dubs/x/dubbed_te.mp4'), null);
  assert.deepEqual(await storage.put(__filename, 'dubs/x/y.mp4'), { ok: false, why: 'storage not enabled' });
  assert.equal(await storage.exists('dubs/x/y.mp4'), false);
  assert.equal(await storage.sweepStaging(0), 0);
});
