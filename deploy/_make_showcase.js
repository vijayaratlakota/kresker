'use strict';
/*
  Builds the clean copy of the project that goes to GitHub, in _github_export/kresker.

    node deploy/_make_showcase.js

  What goes in is an ALLOW-list, not a deny-list: a new file anywhere in the project stays
  out until somebody adds it here on purpose. Left out by design:
    * the legacy Python backend (backend/) and its copy (backup/) - kept privately
    * every secret: .env files, keys, credentials, the server's addresses
    * customer data: databases, uploads, transcripts, mail, logs
    * build output and dependencies (dist, node_modules)
    * large demo videos, and the brand font (licensed, not ours to publish)
    * test screenshots and artifacts, scratch scripts, local tool settings
  Run deploy/_scan_secrets.js on the result before it is pushed anywhere.
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_github_export', 'kresker');

// [folder in this project, folder in the export, which files (path relative to the folder)]
const SPEC = [
  [
    'backend-node',
    'backend-node',
    // README.md is not copied: the public one is written from deploy/showcase/ (GENERATED).
    (p) =>
      /^(src|sql|static)\//.test(p) ||
      /^test\/[^/]+\.js$/.test(p) ||
      /^examples\/[^/]+\.js$/.test(p) ||
      /^(package\.json|package-lock\.json|tsconfig\.json)$/.test(p) ||
      p === 'scripts/disclosure_node.js' ||
      /^scripts\/ui_check\/[^/]+\.(js|md)$/.test(p) ||
      p === 'scripts/ui_check/_phone_backend.ps1',
  ],
  [
    'frontend',
    'frontend',
    (p) =>
      (/^(src|scripts)\//.test(p) ||
        /^public\//.test(p) ||
        /^(index\.html|package\.json|package-lock\.json|tsconfig\.json|vite\.config\.ts)$/.test(p)) &&
      !/^public\/demo\/.+\.(mp4|m4a)$/.test(p) &&
      !/^public\/fonts\//.test(p),
  ],
  ['pipeline', 'pipeline', (p) => /^[^/]+\.py$/.test(p)],
  ['_box_src', '_box_src', (p) => /^[^/]+\.py$/.test(p)],
  ['research', 'research', (p) => /^[^/]+\.md$/.test(p)],
  [
    'deploy',
    'deploy',
    (p) =>
      [
        '_remote.ps1',
        '_preflight_node.ps1',
        '_ship_node.ps1',
        '_cutover_node.ps1',
        '_ship_dist.ps1',
        '_live_check_node.ps1',
        '_shadow_compare.ps1',
        '_dryrun_sweep.ps1',
        '_set_sweep_since.ps1',
        '_nginx_no_slash_redirect.ps1',
        '_scan_secrets.js',
        '_make_showcase.js',
      ].includes(p),
  ],
  [
    'docs',
    'docs',
    (p) =>
      [
        'stack_explained.html',
        'backend_explained_simply.html',
        'website_backend_plan.html',
        'website_backend_plan_v2.html',
        'deployment.html',
        'migration_runbook.html',
        'launch_playbook.html',
        'seo_plan_explained.html',
        'pipeline_handbook.html',
        'pipeline.html',
        'pipeline_before_after.html',
        'model_map.html',
        'INPUT_FORMAT.md',
        'R2_RESTORE.md',
        'AI_PROMPTS.md',
        'PROMPT_ONE_SHOT.md',
      ].includes(p),
  ],
];
// Single files from the project root, and where they land.
const FILES = [
  ['.gitattributes', '.gitattributes'],
  ['DPDP_PROGRESS.md', 'docs/compliance/DPDP_PROGRESS.md'],
  ['BREACH_RUNBOOK.md', 'docs/compliance/BREACH_RUNBOOK.md'],
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', '.git', '__pycache__', '_server_logs', '_artifacts']);

// Written into the export from deploy/showcase/ (they exist only for the export).
const GENERATED = [
  ['deploy/showcase/README.md', 'README.md'],
  ['deploy/showcase/backend-node.README.md', 'backend-node/README.md'],
  ['deploy/showcase/gitignore', '.gitignore'],
];

// ── redactions, applied to the COPIES in docs and notes only; originals are untouched ──
const EXAMPLE_GMAIL = /^(john|j\.o\.hn|john\+1|\+tag)@gmail\.com$/i;
function isPublicIp(ip) {
  const p = ip.split('.').map(Number);
  if (p.some((n) => n > 255)) return false;
  if (p[0] <= 1 || p[0] === 10 || p[0] === 127 || p[0] >= 224) return false; // 1.x: version numbers
  if ((p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254)) return false;
  return true;
}
const REDACT = [
  // a personal address in one planning document; the textbook examples stay
  [/[A-Za-z0-9._%+-]+@gmail\.com/g, (m) => (EXAMPLE_GMAIL.test(m) ? m : 'owner@example.com')],
  // server and home IP addresses
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => (isPublicIp(m) ? '<ip-address>' : m)],
  // a PEM header quoted as text in a document (no key follows it)
  [/-----BEGIN ([A-Z ]*)PRIVATE KEY-----/g, '"BEGIN $1PRIVATE KEY" (header text)'],
  // one-time links copied into test reports from a local run
  [/([?&](?:token|code|state)=)[A-Za-z0-9_-]{16,}/g, '$1<redacted>'],
];
const REDACT_WHERE = (dst) => /^(docs|research)\//.test(dst) || /^backend-node\/scripts\/ui_check\/[^/]+\.md$/.test(dst);

function walk(dir, base, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, base, out);
    } else out.push(rel);
  }
  return out;
}

// Start from nothing every time, so a file removed from the list is removed from the export.
// The export's own .git is kept, so re-running keeps its history.
if (fs.existsSync(OUT)) {
  for (const e of fs.readdirSync(OUT)) if (e !== '.git') fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
}
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
let bytes = 0;
let redacted = 0;
const copy = (from, dstRel) => {
  const to = path.join(OUT, dstRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (REDACT_WHERE(dstRel) && /\.(md|html|txt|json)$/i.test(dstRel)) {
    let text = fs.readFileSync(from, 'utf8');
    const before = text;
    for (const [re, rep] of REDACT) text = text.replace(re, rep);
    if (text !== before) redacted++;
    fs.writeFileSync(to, text);
  } else {
    fs.copyFileSync(from, to);
  }
  n++;
  bytes += fs.statSync(to).size;
};
for (const [src, dst, want] of SPEC) {
  const base = path.join(ROOT, src);
  for (const rel of walk(base, base)) if (want(rel)) copy(path.join(base, rel), `${dst}/${rel}`);
}
for (const [src, dst] of [...FILES, ...GENERATED]) copy(path.join(ROOT, src), dst);
console.log(`copied ${n} files, ${(bytes / 1048576).toFixed(1)} MB, into ${OUT} (${redacted} redacted)`);
