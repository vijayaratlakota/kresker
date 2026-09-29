# Read-only health of the live site after the switch to Node: the service, its log, the
# database's integrity, and that nothing was lost across the switch. Changes nothing.
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_live_check_node.log'
$out = Remote @'
set -uo pipefail
DB=$(sudo grep -E '^VS_DB_PATH=' /opt/voicestudio/voicestudio.env | cut -d= -f2-)
BK=$(ls -1t /opt/voicestudio/data/backups/live-*-before-node.db 2>/dev/null | head -1)
PID=$(systemctl show voicestudio -p MainPID --value)
echo "=== the service ==="
echo "  active      : $(systemctl is-active voicestudio)  since $(systemctl show voicestudio -p ActiveEnterTimestamp --value)"
echo "  process     : $(ps -o pid=,rss=,pcpu=,etime=,args= -p "$PID" | awk '{printf "pid %s, %.0f MB, %s%% cpu, up %s, %s %s", $1, $2/1024, $3, $4, $5, $6}')"
echo "  restarts    : $(systemctl show voicestudio -p NRestarts --value)"
echo
echo "=== the log since the switch ==="
since=$(systemctl show voicestudio -p ActiveEnterTimestamp --value)
echo "  lines       : $(sudo journalctl -u voicestudio --since "$since" --no-pager | wc -l)"
echo "  500 errors  : $(sudo journalctl -u voicestudio --since "$since" --no-pager | grep -c '\[500 ' || true)"
echo "  5xx answers : $(sudo journalctl -u voicestudio --since "$since" --no-pager | grep -cE '" 5[0-9][0-9] ' || true)"
echo "  exceptions  : $(sudo journalctl -u voicestudio --since "$since" --no-pager | grep -ciE 'unhandled|uncaught|TypeError|ReferenceError|SqliteError' || true)"
echo "  requests by status:"
sudo journalctl -u voicestudio --since "$since" --no-pager | grep -oE '" [0-9]{3} ' | sort | uniq -c | sed 's/^/    /'
echo "  last lines:"
sudo journalctl -u voicestudio --since "$since" --no-pager | tail -8 | sed 's/^/    /'
echo
echo "=== the database (read-only) ==="
sudo -u voicestudio python3 - "$DB" "$BK" <<'PY'
import sqlite3, sys
db, bk = sys.argv[1], sys.argv[2]
live = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
print("  integrity   :", live.execute("PRAGMA integrity_check").fetchone()[0])
fk = live.execute("PRAGMA foreign_key_check").fetchall()
print("  foreign keys:", "ok" if not fk else f"{len(fk)} violation(s): {fk[:3]}")
print("  journal     :", live.execute("PRAGMA journal_mode").fetchone()[0])
if bk:
    old = sqlite3.connect(f"file:{bk}?mode=ro", uri=True)
    tables = [r[0] for r in live.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    otables = {r[0] for r in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    same_schema = all(
        live.execute(f'PRAGMA table_info("{t}")').fetchall() == old.execute(f'PRAGMA table_info("{t}")').fetchall()
        for t in tables if t in otables)
    print("  schema      :", "unchanged by the switch" if same_schema and set(tables) == otables else f"CHANGED: now {sorted(set(tables) ^ otables)}")
    print(f"  rows        : table                    before -> now")
    lost = []
    # Tables the app prunes ON PURPOSE: sessions dead for 30 days (worker.purgeDeadSessions).
    # Fewer rows there is the cleanup working, not data loss.
    pruned = {"sessions"}
    for t in tables:
        n = live.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        o = old.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] if t in otables else None
        mark = "" if o is None or n >= o else ("   (fewer: pruned by design)" if t in pruned else "   <-- FEWER")
        if o is not None and n < o and t not in pruned:
            lost.append(t)
        print(f"                {t:<24} {o!s:>6} -> {n}{mark}")
    print("  nothing lost:", "yes" if not lost else f"NO: {lost}")
    print("  backup      :", bk)
PY
echo
echo "=== the GPU watchdog: its own scheduled runs, not started by this check ==="
echo "  timer       : $(systemctl is-active voicestudio-gpu-watchdog.timer 2>/dev/null)"
systemctl list-timers voicestudio-gpu-watchdog.timer --all --no-pager | head -2 | sed 's/^/    /'
echo "  last result : $(systemctl show voicestudio-gpu-watchdog.service -p Result --value), exit $(systemctl show voicestudio-gpu-watchdog.service -p ExecMainStatus --value)"
echo "  runs        : $(systemctl show voicestudio-gpu-watchdog.service -p ExecStart --value | grep -oE 'argv\[\]=[^;]+' | head -1)"
echo "  since switch: $(sudo journalctl -u voicestudio-gpu-watchdog.service --since "$since" --no-pager | grep -c ': Finished ' || true) finished run(s), $(sudo journalctl -u voicestudio-gpu-watchdog.service --since "$since" --no-pager | grep -ciE 'failed|error|Traceback' || true) failure line(s)"
sudo journalctl -u voicestudio-gpu-watchdog.service -n 4 --no-pager | sed 's/^/    /'
echo "  instance    : $(sudo -u voicestudio env HOME=/opt/voicestudio AWS_PROFILE=vs-deploy /usr/local/bin/aws ec2 describe-instances --instance-ids i-041b48c591cb86e19 --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1)"
'@
$out | Out-File -Encoding utf8 $log
$out
