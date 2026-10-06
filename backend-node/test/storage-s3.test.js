'use strict';
/*
  Storage provider configuration, AWS S3 flavour (src/storage.ts), offline.

  The provider is chosen by which keys the credentials file holds. With STORAGE_* keys the
  backend must address S3 virtual-hosted style in the bucket's own region, and the
  presigned upload URL it hands a browser must be exactly the URL AWS's published SigV4
  algorithm produces (checked against an independent implementation in sigv4.js).
*/
const { test, mock, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sigv4 = require('./sigv4');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kresker-s3-test-'));
const CREDS = {
  STORAGE_BUCKET: 'example-bucket',
  STORAGE_REGION: 'ap-south-1',
  // Made-up values in no real key's format, so secret scanners have nothing to flag.
  STORAGE_ACCESS_KEY_ID: 'TEST-ACCESS-KEY-ID',
  STORAGE_SECRET_ACCESS_KEY: 'test/secret+access=key',
};
const envFile = path.join(DIR, 's3.env');
fs.writeFileSync(envFile, '# test credentials\r\n' + Object.entries(CREDS).map(([k, v]) => `${k} = "${v}"`).join('\r\n') + '\r\n');
process.env.VS_DATA_DIR = path.join(DIR, 'data');
process.env.VS_R2_ENABLED = '1';
process.env.VS_R2_ENV = envFile;

const storage = require('../dist/storage');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('STORAGE_* keys select AWS S3, and the switch plus complete keys enable it', () => {
  assert.equal(storage.enabled(), true);
  const st = storage.status();
  assert.equal(st.backend, 'aws-s3');
  assert.equal(st.bucket, 'example-bucket');
  assert.equal(st.region, 'ap-south-1');
  assert.equal(st.r2_configured, true, 'reported as "credentials present"');
  assert.match(st.note, /private S3 bucket/);
  assert.equal(JSON.stringify(st).includes(CREDS.STORAGE_SECRET_ACCESS_KEY), false, 'status never carries the secret');
});

test('upload keys are confined to the customer and the upload, with a safe filename', () => {
  assert.equal(storage.stagingKey(42, 'abc123', '../../etc/passwd'), '_incoming/42/abc123/passwd');
  assert.equal(storage.stagingKey(42, 'abc123', 'my holiday (1).mp4'), '_incoming/42/abc123/my_holiday_1_.mp4');
  assert.equal(storage.stagingKey(42, 'abc123', ''), '_incoming/42/abc123/video');
  assert.equal(storage.keyFor('job9', 'te'), 'dubs/job9/dubbed_te.mp4');
});

test('presigned upload URL is byte-identical to an independent SigV4 implementation', () => {
  const now = new Date('2026-10-06T09:15:30.000Z');
  mock.timers.enable({ apis: ['Date'], now });
  try {
    const key = storage.stagingKey(7, 'u0001', 'clip.mp4');
    const got = storage.presignPut(key, 900, 'video/mp4');
    const { STORAGE_ACCESS_KEY_ID: accessKeyId, STORAGE_SECRET_ACCESS_KEY: secretAccessKey } = CREDS;
    const want = sigv4.presignPut({
      host: 'example-bucket.s3.ap-south-1.amazonaws.com',
      region: 'ap-south-1',
      accessKeyId,
      secretAccessKey,
      path: '/' + key,
      expiresS: 900,
      now,
    });
    assert.equal(got, want);

    const u = new URL(got);
    assert.equal(u.host, 'example-bucket.s3.ap-south-1.amazonaws.com', 'virtual-hosted: the bucket is in the host');
    assert.equal(u.pathname, '/_incoming/7/u0001/clip.mp4');
    assert.equal(u.searchParams.get('X-Amz-Credential'), 'TEST-ACCESS-KEY-ID/20261006/ap-south-1/s3/aws4_request');
    assert.equal(u.searchParams.get('X-Amz-Expires'), '900');
    assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'host', 'content-type is deliberately unsigned');
    assert.match(u.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
    assert.equal(got.includes(CREDS.STORAGE_SECRET_ACCESS_KEY), false, 'the secret never appears in a URL');
  } finally {
    mock.timers.reset();
  }
});
