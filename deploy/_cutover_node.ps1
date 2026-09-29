# Switch the live site between the Python and the Node backend. EVERY ACTION HERE IS LIVE.
#
#   deploy\_cutover_node.ps1 -Action Status            what is serving right now (read-only)
#   deploy\_cutover_node.ps1 -Action GoLive   -Yes     Python -> Node
#   deploy\_cutover_node.ps1 -Action Rollback -Yes     Node -> Python
#   deploy\_cutover_node.ps1 -Action Restart  -Yes     Node -> a newer Node build staged by _ship_node.ps1
#
# HOW THE SWITCH WORKS, and why it is this shape. The unit stays `voicestudio.service`; going
# live adds ONE drop-in file that points ExecStart at Node, and rolling back deletes it. So the
# journal, every existing ops script and `systemctl status voicestudio` keep working unchanged,
# and the Python backend is never removed - it is the rollback, one command away.
#
# The same applies to the GPU watchdog timer: a drop-in points it at dist/watchdog.js. Both
# implementations decide from the same database, so either is safe to run.
#
# WHAT CARRIES OVER UNTOUCHED: the database, sessions (nobody is signed out), passwords,
# download links (same secret.key), queued jobs, the mail outbox, nginx, the env file.
#
# SAFETY RAILS:
#   * refuses unless -Yes is given for anything that changes the server
#   * refuses while a dub is running or queued (a restart requeues it from the start),
#     unless -Force
#   * takes an online backup of the live database before every switch and restart
#   * Restart only swaps in a staged build that passed its smoke test (.smoke-ok)
#   * if the new side does not answer /api/health within 30 s, switches straight back
param(
    [Parameter(Mandatory = $true)][ValidateSet('Status', 'GoLive', 'Rollback', 'Restart')][string]$Action,
    [switch]$Yes,
    [switch]$Force
)
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_cutover_node.log'

if ($Action -ne 'Status' -and -not $Yes) {
    Write-Host "REFUSING: '$Action' changes the LIVE site. Re-run with -Yes once you mean it." -ForegroundColor Red
    exit 2
}

$common = @'
set -uo pipefail
DROP=/etc/systemd/system/voicestudio.service.d/node.conf
WDROP=/etc/systemd/system/voicestudio-gpu-watchdog.service.d/node.conf
APP=/opt/voicestudio/app
DB=$(sudo grep -E '^VS_DB_PATH=' /opt/voicestudio/voicestudio.env | cut -d= -f2-)

serving() {
  if [ -f "$DROP" ]; then echo node; else echo python; fi
}

health() {   # 200 within 30 s, or fail
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/api/health)
    [ "$code" = 200 ] && { echo "health 200 after ${i}s"; return 0; }
    sleep 1
  done
  echo "health never reached 200 (last: $code)"; return 1
}

busy() {     # jobs a restart would requeue from the beginning
  sudo -u voicestudio python3 - "$DB" <<'PY'
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
n = con.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','claimed','preparing',"
                "'transcribing','translating','rendering','exporting')").fetchone()[0]
print(n)
PY
}

backup() {
  sudo -u voicestudio mkdir -p /opt/voicestudio/data/backups
  local dest="/opt/voicestudio/data/backups/live-$(date -u +%Y%m%dT%H%M%SZ)-before-$1.db"
  sudo -u voicestudio python3 - "$DB" "$dest" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)   # SQLite's online backup: consistent while the service keeps writing
dst.close()
print("backup:", sys.argv[2])
PY
}

write_dropins() {
  sudo mkdir -p "$(dirname "$DROP")" "$(dirname "$WDROP")"
  sudo tee "$DROP" > /dev/null <<'UNIT'
# Written by deploy/_cutover_node.ps1 -Action GoLive. Delete this file (and daemon-reload,
# restart) to go back to the Python backend: deploy/_cutover_node.ps1 -Action Rollback -Yes
[Unit]
Description=VoiceStudio backend (kresker.com) - Node.js
[Service]
WorkingDirectory=/opt/voicestudio/app/backend-node
Environment=NODE_ENV=production
ExecStart=
ExecStart=/opt/voicestudio/node/bin/node /opt/voicestudio/app/backend-node/dist/main.js --host 127.0.0.1 --port 8099
# Node writes only under the data directory; the code directories stay read-only.
ReadWritePaths=
ReadWritePaths=/opt/voicestudio/data
UNIT
  sudo tee "$WDROP" > /dev/null <<'UNIT'
# Written by deploy/_cutover_node.ps1 -Action GoLive; removed by -Action Rollback.
[Service]
WorkingDirectory=/opt/voicestudio/app/backend-node
ExecStart=
ExecStart=/opt/voicestudio/node/bin/node /opt/voicestudio/app/backend-node/dist/watchdog.js
UNIT
}

remove_dropins() {
  sudo rm -f "$DROP" "$WDROP"
}

status() {
  echo "serving        : $(serving)"
  echo "service        : $(systemctl is-active voicestudio)"
  echo "ExecStart      : $(systemctl show voicestudio -p ExecStart --value | grep -oE 'path=[^ ;]+' | head -1)"
  echo "watchdog runs  : $(systemctl show voicestudio-gpu-watchdog.service -p ExecStart --value | grep -oE 'argv\[\]=[^;]+' | head -1)"
  echo "node runtime   : $([ -x /opt/voicestudio/node/bin/node ] && /opt/voicestudio/node/bin/node --version || echo 'not installed')"
  echo "node build     : $([ -f $APP/backend-node/dist/main.js ] && echo present || echo missing)$([ -d $APP/backend-node.new ] && echo ', newer build staged')"
  echo "python backend : $([ -f $APP/backend/app/main.py ] && echo 'present (the rollback)' || echo MISSING)"
  echo "jobs in flight : $(busy)"
  echo "health         : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/api/health)"
}
'@

$bodies = @{
    Status   = @'
status
echo
echo "--- last startup lines ---"
sudo journalctl -u voicestudio -n 14 --no-pager | sed "s/^/  /"
'@
    GoLive   = @'
[ "$(serving)" = node ] && { echo "already serving from Node; nothing to do"; status; exit 0; }
[ -f "$APP/backend-node/dist/main.js" ] || { echo "REFUSING: no Node build at $APP/backend-node - run deploy\_ship_node.ps1 first"; exit 2; }
[ -x /opt/voicestudio/node/bin/node ] || { echo "REFUSING: no Node runtime at /opt/voicestudio/node"; exit 2; }
n=$(busy)
if [ "$n" != 0 ] && [ "__FORCE__" != 1 ]; then echo "REFUSING: $n job(s) queued or running; a restart would start them over. Wait, or pass -Force."; exit 2; fi
backup node
write_dropins
sudo systemctl daemon-reload
sudo systemctl restart voicestudio
if health; then
  echo "LIVE ON NODE."
  sudo journalctl -u voicestudio -n 14 --no-pager | sed "s/^/  /"
else
  echo "NODE DID NOT COME UP - switching straight back to Python."
  sudo journalctl -u voicestudio -n 30 --no-pager | sed "s/^/  /"
  remove_dropins
  sudo systemctl daemon-reload
  sudo systemctl restart voicestudio
  health && echo "back on Python." || echo "PYTHON DID NOT COME BACK EITHER - look at the journal now."
  exit 1
fi
status
'@
    Rollback = @'
[ "$(serving)" = python ] && { echo "already serving from Python; nothing to do"; status; exit 0; }
n=$(busy)
if [ "$n" != 0 ] && [ "__FORCE__" != 1 ]; then echo "REFUSING: $n job(s) queued or running; a restart would start them over. Wait, or pass -Force."; exit 2; fi
backup python
remove_dropins
sudo systemctl daemon-reload
sudo systemctl restart voicestudio
health && echo "BACK ON PYTHON." || { echo "PYTHON DID NOT COME UP - look at the journal:"; sudo journalctl -u voicestudio -n 30 --no-pager | sed "s/^/  /"; exit 1; }
status
'@
    Restart  = @'
[ "$(serving)" = node ] || { echo "REFUSING: the live service is on Python; use -Action GoLive"; exit 2; }
[ -d "$APP/backend-node.new" ] || { echo "nothing staged at $APP/backend-node.new - run deploy\_ship_node.ps1 first"; exit 2; }
# Only a build that passed its smoke test. A failed ship leaves the directory behind.
[ -f "$APP/backend-node.new/.smoke-ok" ] || { echo "REFUSING: the staged build has no .smoke-ok - its smoke test did not pass. Re-run deploy\_ship_node.ps1."; exit 2; }
n=$(busy)
if [ "$n" != 0 ] && [ "__FORCE__" != 1 ]; then echo "REFUSING: $n job(s) queued or running; a restart would start them over. Wait, or pass -Force."; exit 2; fi
# A new build can change what the worker writes on its first pass, so the database is
# copied first, like GoLive and Rollback do.
backup node-restart
sudo rm -rf "$APP/backend-node.prev"
sudo mv "$APP/backend-node" "$APP/backend-node.prev"
sudo mv "$APP/backend-node.new" "$APP/backend-node"
sudo systemctl restart voicestudio
if health; then
  echo "NEW NODE BUILD LIVE (previous kept at backend-node.prev)."
else
  echo "NEW BUILD DID NOT COME UP - putting the previous one back."
  sudo rm -rf "$APP/backend-node.new"
  sudo mv "$APP/backend-node" "$APP/backend-node.new"
  sudo mv "$APP/backend-node.prev" "$APP/backend-node"
  sudo systemctl restart voicestudio
  health && echo "previous Node build restored." || echo "STILL DOWN - roll back to Python: -Action Rollback -Yes -Force"
  exit 1
fi
status
'@
}

# The helpers first, then the action, on separate lines: a here-string has no trailing
# newline, and `}` run together with the next command is a bash syntax error.
$body = ($common + "`n" + $bodies[$Action]).Replace('__FORCE__', $(if ($Force) { '1' } else { '0' }))
$result = Remote $body "cutover-$Action"
"=== $Action  $(Get-Date -Format s) ===`n$result" | Out-File -Append -Encoding utf8 $log
Write-Host $result
