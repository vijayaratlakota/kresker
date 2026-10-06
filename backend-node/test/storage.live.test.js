'use strict';
/*
  OPT-IN integration test against a real S3 bucket: the whole storage path the website
  uses, through the compiled module.

      set KRESKER_S3_TEST_ENV=C:\path\to\storage.env      (a file with the STORAGE_* keys)
      npm test

  Skipped when KRESKER_S3_TEST_ENV is not set, so the default run needs no network and no
  credentials. It only ever touches its own two keys (one upload, one dub, under test-*
  ids) and deletes both, so it is safe against a bucket with customer files in it.
*/
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CREDS = process.env.KRESKER_S3_TEST_ENV;
const skip = CREDS ? false : 'set KRESKER_S3_TEST_ENV to a STORAGE_* credentials file to run against a real bucket';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kresker-live-test-'));
process.env.VS_DATA_DIR = path.join(DIR, 'data');
process.env.VS_R2_ENABLED = '1';
if (CREDS) process.env.VS_R2_ENV = CREDS;
const storage = require('../dist/storage');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const ORIGIN = 'https://kresker.com';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('a browser upload, an import, a stored dub and a signed download, end to end', { skip, timeout: 120_000 }, async () => {
  assert.equal(storage.status().backend, 'aws-s3');
  const id = 'test-' + crypto.randomBytes(6).toString('hex');
  const body = crypto.randomBytes(256 * 1024);
  const uploadKey = storage.stagingKey(0, id, 'probe.mp4');
  const dubKey = storage.keyFor(id, 'te');
  try {
    // 1. What the browser does: a CORS preflight, then the PUT to the presigned URL.
    const url = storage.presignPut(uploadKey, 900, 'video/mp4');
    const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(pre.status, 200);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', Origin: ORIGIN }, body });
    assert.equal(put.status, 200);

    // 2. What /api/uploads/complete does: size read from storage, never from the client.
    const head = await storage.head(uploadKey);
    assert.equal(head.bytes, body.length);
    const local = path.join(DIR, 'imported.bin');
    const got = await storage.fetchObject(uploadKey, local);
    assert.equal(got.ok, true);
    assert.equal(sha(fs.readFileSync(local)), sha(body));

    // 3. What the worker does with a finished dub, and what a download link returns.
    assert.equal((await storage.put(local, dubKey)).ok, true);
    assert.equal(await storage.exists(dubKey), true);
    const link = await storage.presign(dubKey, 300);
    const dl = await fetch(link);
    assert.equal(dl.status, 200);
    assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha(body));
    const unsigned = await fetch(link.split('?')[0]);
    assert.equal(unsigned.status, 403, 'the bucket is private');
  } finally {
    await storage.del(uploadKey);
    await storage.del(dubKey);
  }
  assert.equal(await storage.exists(uploadKey), false);
  assert.equal(await storage.exists(dubKey), false);
});
