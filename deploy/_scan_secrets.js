'use strict';
/*
  Secret and personal-data scan for a folder that is about to leave this machine.

    node deploy/_scan_secrets.js <folder>

  Exit 0 only when nothing is found. It prints WHERE a finding is and WHAT KIND it is,
  never the value itself - the point is to keep secrets out of logs as well as out of git.

  Looks for:
    * credential formats: AWS, GitHub, Google (API key, OAuth secret, service account),
      Slack, Stripe, Razorpay, Resend, Dodo/Standard-Webhooks secrets, Hugging Face, OpenAI,
      Anthropic, Bedrock, JWTs, private keys, passwords inside URLs
    * assignments that look like a real secret (KEY=..., "token": "...") with a long value
    * files that should never be shared by name (.env, .pem, id_rsa, credentials, *.db ...)
    * email addresses other than placeholders and the site's own public addresses
    * public IPv4 addresses (servers, home connections)
    * AWS account ids inside ARNs
    * very large files
*/
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const findings = [];
const add = (file, line, kind) => findings.push({ file: path.relative(root, file).replace(/\\/g, '/'), line, kind });

const PATTERNS = [
  ['AWS access key id', /\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/],
  ['AWS secret key assignment', /aws_?secret_?access_?key["'\s]*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/i],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['Google service-account key', /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}/],
  ['Stripe key', /\b(sk|rk)_(live|test)_[0-9A-Za-z]{16,}/],
  ['Razorpay key', /\brzp_(live|test)_[0-9A-Za-z]{10,}/],
  ['Resend API key', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ['webhook signing secret', /\bwhsec_[A-Za-z0-9+/=]{16,}/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['Bedrock API key', /\bABSK[A-Za-z0-9+/=]{40,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['password inside a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"<>]{1,64}:[^\s/:@'"<>]{3,}@[^\s/'"<>]+/i],
  // KEY=value / "key": "value" where the key names a secret and the value is long and not a placeholder
  [
    'secret-looking assignment',
    /\b[A-Za-z0-9_]*(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?(?!\$|<|\{|process\.env|os\.environ|env\.|none|null|undefined|""|''|x+\b|\*+|example|placeholder|changeme|your[_-])[A-Za-z0-9+/_\-=.]{24,}/i,
  ],
];

const BAD_NAMES = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.keystore|id_rsa.*|id_ed25519.*|credentials(\.json)?|.*\.db|.*\.sqlite3?|.*-wal|.*-shm|_state\.json|known_hosts|_known_hosts)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Placeholders, the site's own public addresses, and the textbook examples the address
// normaliser is documented with. Anything else is somebody's real address.
const EMAIL_OK = /@(example\.(com|org|net)(\.txt)?|kresker\.com|invalid|test|test\.local|localhost|users\.noreply\.github\.com)$|^(git|noreply|no-reply)@|^(john|j\.o\.hn|john\+1|\+tag)@(gmail|googlemail)\.com$|^(you|first\.last)@company\.com$/i;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ARN_ACCOUNT = /arn:aws:[a-z0-9-]*:[a-z0-9-]*:\d{12}:/;
const BIG = 5 * 1024 * 1024;

function privateOrSpecial(ip) {
  const p = ip.split('.').map(Number);
  if (p.some((n) => n > 255)) return true; // a version number, not an address
  return (
    p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    p[0] >= 224 || (p[0] === 255) || (p[0] === 1 && p[1] === 1 && p[2] === 1) ||
    (p[0] === 8 && p[1] === 8) || (p[0] === 192 && p[1] === 0 && p[2] === 2) || // documentation / public resolvers
    (p[0] === 198 && (p[1] === 51 || p[1] === 18 || p[1] === 19)) || (p[0] === 203 && p[1] === 0 && p[2] === 113)
  );
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else scan(full);
  }
}

function scan(file) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (BAD_NAMES.test(rel)) add(file, 0, 'file that must not be shared (by its name)');
  const st = fs.statSync(file);
  if (st.size > BIG) add(file, 0, `large file (${(st.size / 1048576).toFixed(1)} MB)`);
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return; // binary: images, fonts
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const [kind, re] of PATTERNS) if (re.test(text)) add(file, i + 1, kind);
    for (const m of text.match(EMAIL) || []) if (!EMAIL_OK.test(m)) add(file, i + 1, 'email address');
    for (const m of text.match(IPV4) || []) if (!privateOrSpecial(m)) add(file, i + 1, 'public IP address');
    if (ARN_ACCOUNT.test(text)) add(file, i + 1, 'AWS account id in an ARN');
  });
}

walk(root);
const byKind = {};
for (const f of findings) (byKind[f.kind] = byKind[f.kind] || []).push(f);
console.log(`scanned ${root}`);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n${kind}: ${list.length}`);
  for (const f of list.slice(0, 60)) console.log(`  ${f.file}${f.line ? `:${f.line}` : ''}`);
  if (list.length > 60) console.log(`  ... and ${list.length - 60} more`);
}
console.log(`\n${findings.length ? `FOUND ${findings.length} item(s) to deal with` : 'CLEAN: nothing found'}`);
process.exit(findings.length ? 1 : 0);
