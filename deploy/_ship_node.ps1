# Ship the NODE backend to the web server and prove it runs there - WITHOUT putting it
# in front of customers.
#
# What this does, all of it reversible and none of it on the live path:
#   1. installs Node.js 24 LTS under /opt/voicestudio/node-<version> (checksum-verified),
#      beside - not instead of - the system Node the frontend build uses
#   2. unpacks backend-node/ to /opt/voicestudio/app/backend-node.new, runs npm ci, the
#      TypeScript build and a dev-dependency prune there, then swaps it into place
#   3. starts it on a SPARE port (8199) against a THROWAWAY database in /tmp, with the fake
#      engine, and checks /api/health, /api/site and a 404 - then stops it
#
# What this deliberately does NOT do:
#   * touch /opt/voicestudio/app/backend (the Python backend stays as the rollback)
#   * touch /opt/voicestudio/data (the live database, uploads, outputs, secret.key)
#   * restart, stop or reconfigure voicestudio.service, nginx or the watchdog timer
#   * ship pipeline/, _box_src/ or backup/ - the golden engine never leaves the GPU box
#
# Going live is a separate, explicit step: deploy\_cutover_node.ps1 -Action GoLive -Yes
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_ship_node.log'
$out = @()
$root = 'c:\video translator'
$NodeVersion = 'v24.16.0'   # the version every local suite and parity check ran on

function Step($label, $body) {
    $script:out += "########## $label ##########"
    foreach ($l in ((Remote $body $label) -split "`n")) {
        $t = $l.TrimEnd()
        if (-not $t) { continue }
        if ($t -match '^\s*(npm warn|added \d+ packages|npm notice)') { continue }
        $script:out += '  ' + $t
    }
    $script:out += ''
}

# ── refuse to ship something that was not built and verified here ───────────
if (-not (Test-Path "$root\backend-node\dist\main.js")) {
    Write-Host 'REFUSING: backend-node\dist\main.js is missing. Run npm run build and the verify sweep first.' -ForegroundColor Red
    exit 2
}

# ── pack ─────────────────────────────────────────────────────────────────────
$tar = Join-Path $env:TEMP 'kresker_node.tar.gz'
if (Test-Path $tar) { Remove-Item $tar -Force }
$out += '########## packing ##########'
Push-Location $root
# scripts/ui_check stays here: screenshots, results, and throwaway test accounts' data
# (its migration-archive export holds their password hashes). None of it runs on the server.
& "$env:SystemRoot\System32\tar.exe" --create --gzip --file $tar `
    --exclude='backend-node/node_modules' `
    --exclude='backend-node/dist' `
    --exclude='backend-node/scripts/_server_logs' `
    --exclude='backend-node/scripts/ui_check' `
    --exclude='*.log' `
    --exclude='*.lock' `
    --exclude='*.db' `
    --exclude='*.db-wal' `
    --exclude='*.db-shm' `
    --exclude='__pycache__' `
    backend-node 2>&1 | ForEach-Object { $out += '  ' + $_ }
Pop-Location
if (-not (Test-Path $tar)) {
    $out += '  FAILED to build the archive'
    $out | Out-File -Encoding utf8 $log
    exit 1
}
$out += "  archive: $([math]::Round((Get-Item $tar).Length/1MB,2)) MB"
$out += ''

$out += '########## uploading ##########'
$ok = Push-Remote $tar '/tmp/kresker_node.tar.gz'
$out += "  scp ok: $ok"
$out += ''
if (-not $ok) { $out | Out-File -Encoding utf8 $log; exit 1 }

# ── the runtime ──────────────────────────────────────────────────────────────
Step "node runtime $NodeVersion (beside the system node, which the frontend build keeps)" (@'
set -euo pipefail
WANT=__NODE_VERSION__
DIR=/opt/voicestudio/node-$WANT
if [ -x "$DIR/bin/node" ] && [ "$("$DIR/bin/node" --version)" = "$WANT" ]; then
  echo "already installed: $DIR"
else
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/$WANT/node-$WANT-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/$WANT/SHASUMS256.txt"
  # The archive must match the checksum nodejs.org publishes for it, or nothing is installed.
  grep " node-$WANT-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
  sudo mkdir -p "$DIR"
  sudo tar -xJf "node-$WANT-linux-x64.tar.xz" -C "$DIR" --strip-components=1
  rm -f "node-$WANT-linux-x64.tar.xz" SHASUMS256.txt
fi
# One stable path for the unit files, repointed atomically.
sudo ln -sfn "$DIR" /opt/voicestudio/node
echo "backend runtime : $(/opt/voicestudio/node/bin/node --version)  (/opt/voicestudio/node -> $(readlink /opt/voicestudio/node))"
echo "system node     : $(command -v node >/dev/null && node --version || echo none)  (left alone: the frontend build uses it)"
'@).Replace('__NODE_VERSION__', $NodeVersion)

# ── unpack and build in a staging directory ─────────────────────────────────
Step 'unpack and build in /opt/voicestudio/app/backend-node.new' @'
set -euo pipefail
NEW=/opt/voicestudio/app/backend-node.new
sudo rm -rf "$NEW"
sudo mkdir -p "$NEW"
sudo tar -xzf /tmp/kresker_node.tar.gz -C "$NEW" --strip-components=1
rm -f /tmp/kresker_node.tar.gz
sudo chown -R voicestudio:voicestudio "$NEW"
for d in pipeline _box_src backup; do
  if [ -e "$NEW/$d" ]; then echo "  PROBLEM: $d was shipped"; exit 1; fi
done
echo "the golden pipeline is not in this package (correct)"

cd "$NEW"
RUN="sudo -u voicestudio env HOME=/opt/voicestudio PATH=/opt/voicestudio/node/bin:/usr/bin:/bin"
$RUN npm ci --no-audit --no-fund 2>&1 | tail -3
$RUN npm run build 2>&1 | tail -5
$RUN npm prune --omit=dev --no-audit --no-fund 2>&1 | tail -2
echo
echo "the native SQLite driver loads on this machine:"
$RUN node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); console.log('  better-sqlite3 ok, sqlite', d.prepare('select sqlite_version() v').get().v); d.close()" \
  || { echo "  FAILED: better-sqlite3 has no prebuilt binary here; install build-essential and re-run"; exit 1; }
echo "the database browser's authorizer is available:"
$RUN node -e "const s=require('node:sqlite'); console.log('  node:sqlite setAuthorizer:', typeof new s.DatabaseSync(':memory:').setAuthorizer)" 2>/dev/null
echo "compiled modules: $(find dist -name '*.js' | wc -l)"
[ -f dist/main.js ] && [ -f dist/watchdog.js ] && [ -f dist/dbquery.js ] || { echo "FAILED: the build is incomplete"; exit 1; }
# The next steps only run on a build that got this far.
sudo -u voicestudio touch "$NEW/.build-ok"
'@

# ── smoke test on a spare port, against nothing real ─────────────────────────
Step 'smoke test on 127.0.0.1:8199 (fake engine, throwaway database)' @'
set -euo pipefail
NEW=/opt/voicestudio/app/backend-node.new
[ -f "$NEW/.build-ok" ] || { echo "SKIPPED: the build step did not finish, so there is nothing to test"; exit 1; }
D=$(sudo -u voicestudio mktemp -d /tmp/node_smoke.XXXXXX)
# The whole command, redirect included, runs as the service account: the directory is its
# own (mode 700), so a redirect opened by this shell could not write there.
sudo -u voicestudio bash -c "cd '$NEW' && exec env -i HOME=/opt/voicestudio \
  PATH=/opt/voicestudio/node/bin:/usr/local/bin:/usr/bin:/bin \
  VS_ENGINE_MODE=fake VS_GPU_AUTO=0 VS_DATA_DIR='$D' VS_DB_PATH='$D/smoke.db' \
  VS_MAIL_BACKEND=file VS_R2_ENABLED=0 VS_DODO_ENV='$D/none.env' VS_GOOGLE_ENV='$D/none.env' \
  /opt/voicestudio/node/bin/node dist/main.js --host 127.0.0.1 --port 8199 > '$D/server.log' 2>&1" &
PID=$!
# Whatever happens below, the test server is stopped and its throwaway data removed.
trap 'kill "$PID" 2>/dev/null || true; sudo rm -rf "$D"' EXIT
up=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8199/api/health > /dev/null 2>&1; then up=1; break; fi
  sleep 1
done
h=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8199/api/health || true)
s=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8199/api/site || true)
p=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8199/api/billing/plans || true)
n=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8199/nope || true)
c=$(curl -sI http://127.0.0.1:8199/api/health 2>/dev/null | grep -ci 'content-security-policy' || true)
echo "health   : $h  $(curl -s http://127.0.0.1:8199/api/health || true)"
echo "site     : $s"
echo "plans    : $p"
echo "unknown  : $n  (want 404)"
echo "headers  : $c CSP header(s)"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
echo "--- its startup log ---"
sudo head -12 "$D/server.log" | sed "s/^/  /" || true
if [ "$up" = 1 ] && [ "$h" = 200 ] && [ "$s" = 200 ] && [ "$p" = 200 ] && [ "$n" = 404 ] && [ "$c" -ge 1 ]; then
  sudo -u voicestudio touch "$NEW/.smoke-ok"
  echo "SMOKE TEST PASSED"
else
  echo "FAILED: the smoke test did not pass"; exit 1
fi
'@

# ── swap into place (the live service still runs Python, so nothing restarts) ─
Step 'swap into /opt/voicestudio/app/backend-node' @'
set -euo pipefail
APP=/opt/voicestudio/app
[ -f "$APP/backend-node.new/.smoke-ok" ] || { echo "NOT SWAPPED: the smoke test did not pass; nothing was moved"; exit 1; }
if systemctl cat voicestudio.service 2>/dev/null | grep -q 'backend-node/dist/main.js'; then
  echo "NOTE: the live service is ALREADY on Node. The new build is staged at $APP/backend-node.new;"
  echo "      run deploy\_cutover_node.ps1 -Action Restart -Yes to put it in place and restart."
  exit 0
fi
sudo rm -rf "$APP/backend-node.prev"
kept=""
if [ -d "$APP/backend-node" ]; then sudo mv "$APP/backend-node" "$APP/backend-node.prev"; kept="  (previous build kept at backend-node.prev)"; fi
sudo mv "$APP/backend-node.new" "$APP/backend-node"
echo "in place: $APP/backend-node$kept"
echo "live service is still: $(systemctl is-active voicestudio) on $(systemctl cat voicestudio.service | grep -oE 'uvicorn|backend-node' | head -1)"
'@

$out | Out-File -Encoding utf8 $log
$out
