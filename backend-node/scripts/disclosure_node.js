// Nothing the customer can read may describe how the service is built — for the NODE
// backend. A port of backend/_test_disclosure.py sections 1-6b, reading the TypeScript
// source through the TypeScript compiler's own parser instead of Python's `ast`.
//
// Sections 7 (the frontend) and 8 (the emails) need no port: the frontend is unchanged,
// and scripts/parity/run_parity.py proves every email is byte-identical to Python's,
// which _test_disclosure.py already holds to these rules.
//
//   node scripts/disclosure_node.js
//
// Static on purpose, for the reason the Python suite gives: driving a job covers only
// the messages that job emitted, and the failure paths most likely to leak are the
// hardest to reach.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src');
const PASS = [];
const FAIL = [];

function check(name, ok, extra = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
  return ok;
}

// The Python suite's list, verbatim: words that describe the machinery.
const FORBIDDEN_RE = new RegExp(
  [
    '\\bGPU\\b', '\\binstance\\b', '\\bcontainer\\b', '\\bdocker\\b', '\\bEC2\\b',
    '\\bengine\\b', '\\bR2\\b', '\\bbucket\\b', '\\bS3\\b', '\\btunnel\\b', '\\bssh\\b',
    '\\bsysinfo\\b', '\\bwatchdog\\b', '\\bsegment ids?\\b', '\\bprofile_id\\b',
    '\\bthe box\\b', '\\bworker\\b', '\\bport \\d+', '\\d+\\.\\d+\\.\\d+\\.\\d+',
  ].join('|'),
  'i',
);

function parse(rel) {
  const file = path.join(SRC, rel);
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

/** Every string literal inside a node, concatenated — template pieces included. */
function literalText(node) {
  const out = [];
  walk(node, (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const s of n.templateSpans) out.push(s.literal.text);
    }
  });
  return out.join(' ');
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

function callsIn(sf, names) {
  const found = [];
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && names.has(calleeName(n))) found.push(n);
  });
  return found;
}

/** db.addEvent(jobId, state, percent, detail, vsSeq, internal): internal is the 6th. */
function isInternal(call) {
  if (calleeName(call) !== 'addEvent') return false;
  const a = call.arguments[5];
  return Boolean(a) && a.kind === ts.SyntaxKind.TrueKeyword;
}

function line(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

console.log('\n=== 1. every customer-visible job event is free of infrastructure ===');
const worker = parse('worker.ts');
{
  const offenders = [];
  let visible = 0;
  for (const call of callsIn(worker, new Set(['addEvent', 'setState']))) {
    if (isInternal(call)) continue;
    visible += 1;
    const text = literalText(call);
    const hit = FORBIDDEN_RE.exec(text);
    if (hit) offenders.push(`line ${line(worker, call)}: '${hit[0]}' in '${text.slice(0, 70)}'`);
  }
  check(`all ${visible} customer-visible messages in worker.ts are clean`, visible > 0 && !offenders.length, offenders.slice(0, 3).join('; '));
}

console.log("\n=== 2. the lifecycle's own commentary is never customer-visible ===");
{
  // Every callback handed to ensureRunning / waitReady / waitPrep describes machines by
  // design; every event such a callback writes must be internal.
  const wired = [];
  for (const call of callsIn(worker, new Set(['ensureRunning', 'waitReady', 'waitPrep']))) {
    for (const arg of call.arguments) {
      if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue;
      for (const inner of callsIn(arg, new Set(['addEvent', 'setState']))) wired.push(inner);
    }
  }
  const internal = wired.filter(isInternal).length;
  check('every on_step/on_wait callback writes an internal event', wired.length > 0 && internal === wired.length, `${wired.length} callback(s), ${internal} internal`);
}

console.log('\n=== 3. the endpoints that serve events filter the internal ones ===');
const jobs = parse(path.join('routers', 'jobs.ts'));
{
  let queries = 0;
  let filtered = 0;
  for (const call of callsIn(jobs, new Set(['query', 'one', 'scalar', 'execute']))) {
    const text = literalText(call);
    if (!text.includes('FROM job_events')) continue;
    queries += 1;
    if (text.includes('internal')) filtered += 1;
  }
  check('every job_events query in the API is visibility-aware', queries > 0 && filtered === queries, `${filtered} of ${queries} filtered`);
}

console.log('\n=== 4. raw failure text is not handed to the customer ===');
{
  // Every place the job view WRITES error_detail - `{error_detail: ...}` or
  // `view.error_detail = ...` - must sit on the true branch of a test of the admin flag.
  const ADMIN = /\bforAdmin\b|\bfor_admin\b/;
  const within = (inner, outer) => inner.getStart(jobs) >= outer.getStart(jobs) && inner.getEnd() <= outer.getEnd();
  let total = 0;
  let gated = 0;
  walk(jobs, (n) => {
    const writes =
      (ts.isPropertyAssignment(n) && n.name.getText(jobs) === 'error_detail') ||
      (ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === 'error_detail');
    if (!writes) return;
    total += 1;
    for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isConditionalExpression(p) && ADMIN.test(p.condition.getText(jobs)) && within(n, p.whenTrue)) {
        gated += 1;
        break;
      }
      if (ts.isIfStatement(p) && ADMIN.test(p.expression.getText(jobs)) && within(n, p.thenStatement)) {
        gated += 1;
        break;
      }
    }
  });
  check('error_detail is admin-only in the job view', total > 0 && gated === total, `${gated} of ${total} gated on forAdmin`);
}

console.log('\n=== 5. the unauthenticated health endpoint says nothing about the box ===');
const main = parse('main.ts');
{
  let anon = null;
  walk(main, (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(main) === 'anonymous' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) anon = n.initializer;
  });
  check('the anonymous payload exists and is a short whitelist', Boolean(anon), anon ? 'found' : 'could not find it');
  const keys = anon ? anon.properties.map((p) => (p.name ? p.name.getText(main) : '...')) : [];
  for (const banned of ['engine_mode', 'engine_reachable', 'engine_state', 'engine_url', 'gpu_auto', 'storage']) {
    check(`  it does not expose ${banned}`, !keys.includes(banned) && !keys.includes('...'));
  }
  check('  it does carry ok and maintenance, which the site needs', keys.includes('ok') && keys.includes('maintenance'), keys.join(', '));
}

console.log('\n=== 6. the readiness word a customer sees is not operational ===');
const gpu = parse('gpu.ts');
{
  let fn = null;
  walk(gpu, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === 'publicServiceState') fn = n;
  });
  check('publicServiceState exists', Boolean(fn));
  if (fn) {
    const returned = new Set();
    walk(fn, (n) => {
      if (ts.isReturnStatement(n) && n.expression) {
        walk(n.expression, (x) => {
          if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) returned.add(x.text);
        });
      }
    });
    const allowed = new Set(['ready', 'starting', 'idle', 'demo']);
    check('  and returns only customer-facing words', returned.size > 0 && [...returned].every((w) => allowed.has(w)), [...returned].sort().join(', '));
    for (const banned of ['asleep', 'connected', 'stopped', 'pending', 'running']) check(`  and never returns '${banned}'`, !returned.has(banned));
    check('  and keeps starting and idle apart, so a first dub can be explained', returned.has('starting') && returned.has('idle'), [...returned].sort().join(', '));
  }
}

console.log('\n=== 6b. the public price list does not name the payment provider ===');
const billingRoutes = parse(path.join('routers', 'billing.ts'));
{
  // The handler registered for GET /plans.
  let handler = null;
  for (const call of callsIn(billingRoutes, new Set(['get']))) {
    const [p, , h] = call.arguments;
    if (p && ts.isStringLiteral(p) && p.text === '/plans' && h) handler = h;
  }
  check('the public plans endpoint exists', Boolean(handler));
  if (handler) {
    const src = handler.getText(billingRoutes).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    check('  and it does not return the provider name', !/providerName|provider_name|\bprovider\s*:/.test(src), 'clean');
    check('  while still saying whether payment is open', /\blive\s*:/.test(src), 'live flag present');
  }
}

console.log(`\nPASSED ${PASS.length}   FAILED ${FAIL.length}`);
for (const f of FAIL) console.log(`  failed: ${f}`);
process.exit(FAIL.length ? 1 : 0);
