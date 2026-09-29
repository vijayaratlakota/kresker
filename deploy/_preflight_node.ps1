# Read-only look at the web server before staging the Node backend. Changes nothing.
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_preflight_node.log'
$out = Remote @'
echo "host        : $(hostname)  $(. /etc/os-release; echo $PRETTY_NAME)  $(uname -m)"
echo "live service: $(systemctl is-active voicestudio)  ($(systemctl show voicestudio -p ExecStart --value | grep -oE 'uvicorn|backend-node' | head -1))"
echo "nginx       : $(systemctl is-active nginx)"
echo "watchdog    : $(systemctl is-active voicestudio-gpu-watchdog.timer)"
echo "health 8099 : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/api/health)"
echo "port 8199   : $(ss -ltn 2>/dev/null | grep -c ':8199 ') listener(s)  (want 0)"
echo "system node : $(command -v node >/dev/null && node --version || echo none)   npm: $(command -v npm >/dev/null && npm --version || echo none)"
echo "node 24 dir : $(ls -d /opt/voicestudio/node* 2>/dev/null | tr '\n' ' ' || true)"
echo "backend-node: $(ls -d /opt/voicestudio/app/backend-node* 2>/dev/null | tr '\n' ' ' || true)"
echo "tools       : curl=$(command -v curl >/dev/null && echo y || echo n) xz=$(command -v xz >/dev/null && echo y || echo n) sha256sum=$(command -v sha256sum >/dev/null && echo y || echo n) python3=$(command -v python3 >/dev/null && echo y || echo n) g++=$(command -v g++ >/dev/null && echo y || echo n) make=$(command -v make >/dev/null && echo y || echo n)"
echo "svc user    : $(getent passwd voicestudio | cut -d: -f1,6,7)"
echo "opt owner   : $(stat -c '%U:%G %a' /opt/voicestudio) /opt/voicestudio ; $(stat -c '%U:%G %a' /opt/voicestudio/app) app"
echo "disk        :"; df -h /opt /tmp | sed 's/^/   /'
echo "memory      :"; free -m | sed 's/^/   /'
echo "load        : $(cut -d' ' -f1-3 /proc/loadavg)"
echo "jobs active : $(sudo -u voicestudio python3 -c "import sqlite3; c=sqlite3.connect('file:/opt/voicestudio/data/live.db?mode=ro', uri=True); print(c.execute(\"SELECT COUNT(*) FROM jobs WHERE state IN ('queued','claimed','preparing','transcribing','translating','rendering','exporting')\").fetchone()[0])" 2>&1)"
echo "reach npm   : $(curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/express)  nodejs.org: $(curl -s -o /dev/null -w '%{http_code}' https://nodejs.org/dist/v24.16.0/SHASUMS256.txt)"
'@
$out | Out-File -Encoding utf8 $log
$out
