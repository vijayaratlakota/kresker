# READ-ONLY dry run of the new source-video retention sweep (worker.sweepSourceUploads).
#
# Runs the STAGED Node build (backend-node.new, which must have passed its smoke test)
# against a COPY of the live database, with VS_DATA_DIR pointed at an empty private /tmp
# folder - so every stored path resolves to a file that does not exist there and nothing
# can be unlinked. It reports what the first live sweep will delete: which uploads (by id
# and owner id, no emails), why, and whether the real file is on disk now. The copy and
# the folder are deleted at the end, whatever happens.
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_dryrun_sweep.log'
$out = Remote @'
set -uo pipefail
NEW=/opt/voicestudio/app/backend-node.new
[ -f "$NEW/.smoke-ok" ] || { echo "REFUSING: no smoke-tested build staged at $NEW"; exit 1; }
ENVF=/opt/voicestudio/voicestudio.env
LIVE=$(sudo grep -E '^VS_DB_PATH=' "$ENVF" | head -1 | cut -d= -f2- | tr -d "\"'")
REAL=$(sudo grep -E '^VS_DATA_DIR=' "$ENVF" | head -1 | cut -d= -f2- | tr -d "\"'")
[ -n "$LIVE" ] && [ -n "$REAL" ] || { echo "REFUSING: cannot read VS_DB_PATH / VS_DATA_DIR"; exit 1; }
# The live service's cutoff, if one is set, so the dry run answers for the real settings.
SINCE=$(sudo grep -E '^VS_SOURCE_SWEEP_SINCE=' "$ENVF" | head -1 | cut -d= -f2- | tr -d "\"'" || true)
echo "cutoff        : ${SINCE:-none (every upload is subject to the rule)}"
D=$(sudo -u voicestudio mktemp -d /tmp/sweepdry.XXXXXX)
trap 'sudo rm -rf "$D"; echo "cleaned up    : $([ -e "$D" ] && echo STILL PRESENT || echo deleted)"' EXIT

sudo -u voicestudio python3 - "$LIVE" "$D/copy.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
print("copy made     :", sys.argv[2].rsplit("/", 1)[-1])
PY

sudo -u voicestudio tee "$D/dry.js" >/dev/null <<'JS'
const fs = require('fs');
const path = require('path');
const [NEW, REAL] = process.argv.slice(2);
const db = require(path.join(NEW, 'dist', 'db'));
const worker = require(path.join(NEW, 'dist', 'worker'));
const before = db.query(
  "SELECT u.id, u.user_id, u.stored_path, u.created_at, u.status," +
  " (SELECT COUNT(*) FROM jobs j WHERE j.upload_id=u.id) AS jobs," +
  " (SELECT GROUP_CONCAT(j.state) FROM jobs j WHERE j.upload_id=u.id) AS states," +
  " (SELECT MAX(COALESCE(j.finished_at, j.created_at)) FROM jobs j WHERE j.upload_id=u.id) AS last_finished," +
  " (SELECT MAX(j.output_expires_at) FROM jobs j WHERE j.upload_id=u.id) AS last_expiry," +
  " (SELECT COUNT(*) FROM jobs j WHERE j.upload_id=u.id AND j.output_deleted_at IS NULL AND j.output_path IS NOT NULL) AS outputs_kept" +
  " FROM uploads u ORDER BY u.created_at");
const n = worker.sweepSourceUploads();
const after = new Map(db.query('SELECT id, status FROM uploads').map((r) => [r.id, r.status]));
const onDisk = (rel) => { try { return fs.existsSync(path.join(REAL, ...String(rel).split('/'))); } catch { return false; } };
let del = 0, keep = 0, filesToGo = 0, bad = 0;
console.log(`uploads       : ${before.length} rows; the first live sweep would mark ${n}`);
for (const r of before) {
  const goes = after.get(r.id) === 'deleted' && r.status !== 'deleted';
  const file = onDisk(r.stored_path);
  if (goes) { del++; if (file) filesToGo++; } else { keep++; }
  // A source must never go while a dub made from it still has its video.
  if (goes && Number(r.outputs_kept) > 0 && r.last_expiry && r.last_expiry > db.now()) bad++;
  console.log(`  ${goes ? 'DELETE' : 'keep  '}  upload ${String(r.id).slice(0, 8)}  owner #${r.user_id}  uploaded ${r.created_at}  jobs ${r.jobs} [${r.states || '-'}]  last dub ${r.last_finished || '-'}  output until ${r.last_expiry || '-'}  file on disk now: ${file ? 'yes' : 'no'}`);
}
console.log(`summary       : ${del} to delete (${filesToGo} real file(s) on disk), ${keep} kept`);
console.log(`safety        : ${bad === 0 ? 'no source goes while its dub is still downloadable' : `PROBLEM: ${bad} source(s) would go while a dub is still downloadable`}`);
JS

sudo -u voicestudio bash -c "cd '$D' && exec env -i HOME=/opt/voicestudio PATH=/usr/bin:/bin \
  VS_DATA_DIR='$D' VS_DB_PATH='$D/copy.db' VS_ENGINE_MODE=fake VS_GPU_AUTO=0 VS_MAIL_BACKEND=file \
  VS_R2_ENABLED=0 VS_DODO_ENV='$D/none.env' VS_GOOGLE_ENV='$D/none.env' VS_RESEND_ENV='$D/none.env' \
  VS_AWS_PROFILE=dryrun_no_such_profile VS_SOURCE_SWEEP_SINCE='$SINCE' \
  /opt/voicestudio/node/bin/node '$D/dry.js' '$NEW' '$REAL'"
echo "live files    : $(sudo find "$REAL/uploads" -type f 2>/dev/null | wc -l) in the real uploads folder (untouched by this run)"
'@
$out | Out-File -Encoding utf8 $log
$out
