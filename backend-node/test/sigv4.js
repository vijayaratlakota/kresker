'use strict';
/*
  An independent SigV4 query-string presigner, written straight from AWS's published
  algorithm and sharing no code with src/storage.ts. The storage tests compare the
  backend's presigned upload URLs with this one, byte for byte, under a frozen clock.
  https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
*/
const crypto = require('node:crypto');

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
const sha256hex = (msg) => crypto.createHash('sha256').update(msg, 'utf8').digest('hex');
// RFC 3986: everything but A-Z a-z 0-9 - _ . ~ is percent-encoded.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** A presigned PUT with UNSIGNED-PAYLOAD and only `host` signed. */
function presignPut({ host, region, accessKeyId, secretAccessKey, path, expiresS, now }) {
  const amzDate = now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresS),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonicalPath = path.split('/').map(enc).join('/');
  const canonicalRequest = ['PUT', canonicalPath, canonicalQuery, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

module.exports = { presignPut };
