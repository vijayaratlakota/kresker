'use strict';
/*
  The source-video retention sweep (worker.sweepSourceUploads), case by case, against a
  SCRATCH database and data directory. Nothing else is touched: VS_DATA_DIR and
  VS_DB_PATH point into a fresh temp folder before any backend module loads, and the
  folder is deleted at the end.

  Usage: node scripts/ui_check/retention_check.js   (after npm run build)
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vs_retention_'));
process.env.VS_DATA_DIR = TMP;
process.env.VS_DB_PATH = path.join(TMP, 'retention.db');
process.env.VS_ENGINE_MODE = 'fake';
process.env.VS_GPU_AUTO = '0';
process.env.VS_MAIL_BACKEND = 'file';
process.env.VS_R2_ENABLED = '0';
process.env.VS_DODO_ENV = path.join(TMP, 'none.env');

const DIST = path.join(__dirname, '..', '..', 'dist');
const db = require(path.join(DIST, 'db'));
const worker = require(path.join(DIST, 'worker'));
const { UPLOAD_DIR } = require(path.join(DIST, 'config'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

const H = 3600_000;
const stamp = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().slice(0, 19) + 'Z';

try {
  db.initDb();
  const now = stamp(0);
  const addUser = (email) =>
    db.execute("INSERT INTO users (email, password_hash, role, created_at, email_verified_at) VALUES (?, 'x', 'user', ?, ?)", [email, now, now]).lastrowid;
  const free = addUser('free@example.com');
  const paid = addUser('paid@example.com');
  // An active paid plan, so the 7-day window applies to this account.
  db.execute(
    "INSERT INTO subscriptions (user_id, plan_code, provider, status, current_period_start, current_period_end, auto_renew, created_at) VALUES (?, 'starter', 'manual', 'active', ?, ?, 0, ?)",
    [paid, stamp(-2 * 24 * H), stamp(28 * 24 * H), now],
  );
  check('the paid account really is on a paid plan', db.entitlement(paid).is_free === false);
  check('the free account really is free', db.entitlement(free).is_free === true);

  let seq = 0;
  const cases = [];
  function addCase(name, user, uploadAgeH, jobs, expectDeleted) {
    seq++;
    const id = `u${String(seq).padStart(3, '0')}`;
    const file = path.join(UPLOAD_DIR, `${id}_video.mp4`);
    fs.writeFileSync(file, 'x');
    db.execute(
      "INSERT INTO uploads (id, user_id, stored_path, original_name, bytes, content_type, probed_duration_s, probed_has_audio, probed_codec, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,'ready',?)",
      [id, user, `uploads/${id}_video.mp4`, 'video.mp4', 1, 'video/mp4', 10.0, 1, 'h264', stamp(-uploadAgeH * H)],
    );
    for (const [k, j] of jobs.entries()) {
      db.execute(
        'INSERT INTO jobs (id, user_id, upload_id, target_lang, state, percent, created_at, finished_at, output_expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          `${id}j${k}`,
          user,
          id,
          'hi',
          j.state,
          j.state === 'done' ? 100 : 0,
          stamp(-uploadAgeH * H + 60_000),
          j.finishedH == null ? null : stamp(-j.finishedH * H),
          j.expiresH == null ? null : stamp(j.expiresH * H),
        ],
      );
    }
    cases.push({ name, id, file, expectDeleted });
  }

  addCase('free, never dubbed, uploaded 30 h ago -> deleted', free, 30, [], true);
  addCase('free, never dubbed, uploaded 2 h ago -> kept', free, 2, [], false);
  addCase('free, dub finished 30 h ago, output expired 6 h ago -> deleted', free, 72, [{ state: 'done', finishedH: 30, expiresH: -6 }], true);
  addCase('free, dub finished 2 h ago, output kept 22 h more -> kept', free, 72, [{ state: 'done', finishedH: 2, expiresH: 22 }], false);
  addCase('free, a dub still QUEUED on it -> kept, however old', free, 500, [{ state: 'queued' }], false);
  addCase('free, one dub done long ago but another RENDERING -> kept', free, 500, [{ state: 'done', finishedH: 400, expiresH: -380 }, { state: 'rendering' }], false);
  addCase('free, dub FAILED 30 h ago (no output) -> deleted', free, 72, [{ state: 'failed', finishedH: 30 }], true);
  addCase('paid, dub finished 3 days ago, output kept 4 days more -> kept', paid, 80, [{ state: 'done', finishedH: 72, expiresH: 96 }], false);
  addCase('paid, never dubbed, uploaded 30 h ago -> kept (7-day window)', paid, 30, [], false);
  addCase('paid, dub finished 8 days ago, output expired a day ago -> deleted', paid, 240, [{ state: 'done', finishedH: 192, expiresH: -24 }], true);
  addCase('free, output still kept (plan was paid then): newest expiry wins -> kept', free, 100, [{ state: 'done', finishedH: 90, expiresH: 30 }], false);

  const n = worker.sweepSourceUploads();
  check('the sweep reports what it deleted', n === cases.filter((c) => c.expectDeleted).length, `${n} deleted`);
  for (const c of cases) {
    const row = db.one('SELECT status FROM uploads WHERE id=?', [c.id]);
    const onDisk = fs.existsSync(c.file);
    if (c.expectDeleted) {
      check(c.name, !onDisk && row.status === 'deleted', `file ${onDisk ? 'present' : 'gone'}, status ${row.status}`);
    } else {
      check(c.name, onDisk && row.status === 'ready', `file ${onDisk ? 'present' : 'gone'}, status ${row.status}`);
    }
  }
  check('the rows stay (jobs still point at them)', db.scalar('SELECT COUNT(*) FROM uploads', [], 0) === cases.length);
  check('a second sweep deletes nothing more', worker.sweepSourceUploads() === 0);

  // ── VS_SOURCE_SWEEP_SINCE: the backlog is protected until an operator clears it ──
  const before = cases.length;
  addCase('(since) free, never dubbed, 50 h old, uploaded BEFORE the cutoff', free, 50, [], null);
  addCase('(since) free, never dubbed, 30 h old, uploaded AFTER the cutoff', free, 30, [], null);
  const [older, newer] = cases.slice(before);
  const status = (c) => db.one('SELECT status FROM uploads WHERE id=?', [c.id]).status;
  process.env.VS_SOURCE_SWEEP_SINCE = stamp(-40 * H);
  const n1 = worker.sweepSourceUploads();
  check('with a cutoff, an expired upload from before it is kept', status(older) === 'ready' && fs.existsSync(older.file), status(older));
  check('  and an expired upload from after it is deleted', status(newer) === 'deleted' && !fs.existsSync(newer.file), `${n1} deleted`);
  process.env.VS_SOURCE_SWEEP_SINCE = 'not-a-date';
  check('an unreadable cutoff deletes nothing at all', worker.sweepSourceUploads() === 0 && status(older) === 'ready');
  delete process.env.VS_SOURCE_SWEEP_SINCE;
  const n2 = worker.sweepSourceUploads();
  check('removing the cutoff clears the backlog', n2 === 1 && status(older) === 'deleted' && !fs.existsSync(older.file), `${n2} deleted`);
} catch (e) {
  fail++;
  console.log('  FAIL  crashed:', e && e.stack ? e.stack : e);
} finally {
  try {
    db.connect().close();
  } catch {
    /* already closed */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`PASSED ${pass}   FAILED ${fail}`);
process.exit(fail ? 1 : 0);
