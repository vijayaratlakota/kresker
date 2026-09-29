# Python vs Node, side by side, on COPIES of the live database - every read-only API, as
# a stranger, as each real account and as the admin. Compares status codes and bodies.
#
# Nothing here touches the live site or the live data:
#   * each backend gets its OWN copy of live.db (SQLite online backup) in a private
#     /tmp directory that is deleted at the end, whatever happens
#   * any absolute file path in those copies is redirected into the private directory
#     BEFORE either backend starts, so no sweep in a copy can reach a real file
#   * sessions are minted only inside those copies; nobody's real session is used or seen
#   * the live settings are mirrored from an ALLOWLIST (values never printed), then
#     forced safe: fake engine, GPU lifecycle off, mail to files, storage, payment and
#     Google credentials pointed at a file that does not exist, and the aws CLI is not on
#     PATH. Both backends must print those modes at startup or the run stops.
#   * GET requests, plus a handful of refused POSTs and one read-only SELECT
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_shadow_compare.log'
$out = Remote @'
set -uo pipefail
ENVF=/opt/voicestudio/voicestudio.env

# ── refuse to start unless nothing can leave the server ──────────────────────
if env -i PATH=/usr/bin:/bin bash -c 'command -v aws' >/dev/null 2>&1; then
  echo "REFUSING: the aws CLI is reachable on the shadow PATH"; exit 1
fi
for p in 8197 8198; do
  if ss -ltnH | awk '{print $4}' | grep -qE ":$p\$"; then echo "REFUSING: port $p is already in use"; exit 1; fi
done
LIVE=$(sudo grep -E '^VS_DB_PATH=' "$ENVF" | head -1 | cut -d= -f2- | tr -d "\"'")
if [ -z "$LIVE" ] || ! sudo test -f "$LIVE"; then echo "REFUSING: cannot find the live database"; exit 1; fi

S=$(sudo -u voicestudio mktemp -d /tmp/shadow.XXXXXX)
stop_side() {   # side port - only ever signals the process that is listening as that shadow
  local pid; pid=$(sudo cat "$S/$1.pid" 2>/dev/null || true)
  [ -z "$pid" ] && return 0
  ps -o args= -p "$pid" 2>/dev/null | grep -q -- "--port $2" || return 0
  sudo kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6; do ps -p "$pid" >/dev/null 2>&1 || return 0; sleep 1; done
  ps -o args= -p "$pid" 2>/dev/null | grep -q -- "--port $2" && sudo kill -9 "$pid" 2>/dev/null
  return 0
}
cleanup() {
  stop_side py 8198; stop_side node 8197
  sudo rm -rf "$S"
  echo "cleaned up    : shadow copies $([ -e "$S" ] && echo 'STILL PRESENT' || echo deleted), shadow ports still open: $(ss -ltnH | awk '{print $4}' | grep -cE ':(8197|8198)$' || true)"
  echo "live site     : $(systemctl is-active voicestudio), health $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/api/health)"
}
trap cleanup EXIT
sudo -u voicestudio mkdir -p "$S/py" "$S/node"

# ── settings: the live ones from an allowlist, then the safe overrides on top ──
MIRROR='PYTHONUNBUFFERED|VS_PUBLIC_BASE_URL|VS_DEPLOYMENT|VS_FFPROBE|VS_TRUSTED_PROXIES|VS_REQUIRE_SIGNUP_CONSENT|VS_FIRST_USER_IS_ADMIN|VS_MAIL_FROM_NAME|VS_MAIL_FROM|VS_MAIL_REPLY_TO|VS_R2_PREFIX|VS_AWS_REGION|VS_GPU_INSTANCE_ID|VS_GPU_CONTAINER_ID|VS_SSH_USER|VS_GRIEVANCE_NAME|VS_GRIEVANCE_EMAIL|VS_NOTICE_VERSION|VS_GOOGLE_REDIRECT_URI|VS_GPU_USE_PRIVATE_IP'
sudo grep -E "^($MIRROR)=" "$ENVF" | sudo -u voicestudio tee "$S/mirror.env" >/dev/null
sudo -u voicestudio tee "$S/force.env" >/dev/null <<EOF
NODE_ENV=production
VS_ENGINE_MODE=fake
VS_ENGINE_URL=http://127.0.0.1:39199
VS_ENGINE_PORT=39199
VS_GPU_AUTO=0
VS_MAIL_BACKEND=file
VS_RESEND_ENV=$S/none.env
VS_R2_ENABLED=0
VS_R2_ENV=$S/none.env
VS_DODO_ENV=$S/none.env
VS_GOOGLE_ENV=$S/none.env
VS_AWS_PROFILE=shadow_no_such_profile
EOF
sudo -u voicestudio tee "$S/launch.sh" >/dev/null <<'SH'
S=$(dirname "$0"); side=$1; dir=$2; shift 2
set -a
. "$S/mirror.env"
. "$S/force.env"
VS_DATA_DIR="$S/$side"
VS_DB_PATH="$S/$side/live.db"
set +a
echo $$ > "$S/$side.pid"
cd "$dir" || exit 1
exec "$@" > "$S/$side.log" 2>&1
SH
echo "settings      : $(sudo cat "$S/mirror.env" | grep -c .) live settings mirrored ($(sudo cut -d= -f1 "$S/mirror.env" | tr '\n' ' '))"

# ── two copies, one shared signing key, one session per account in both ──────
sudo -u voicestudio python3 - "$LIVE" "$S" <<'PY'
import hashlib, json, os, re, secrets, sqlite3, sys, time
live, S = sys.argv[1].strip(), sys.argv[2]
src = sqlite3.connect(f"file:{live}?mode=ro", uri=True)
key = secrets.token_bytes(32)
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
far = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 7 * 86400))
users = src.execute("SELECT id, email, role FROM users ORDER BY id").fetchall()
sessions = []
for uid, email, role in users:
    if role == "erased":
        continue
    raw = secrets.token_urlsafe(32)
    sessions.append({"user_id": uid, "role": role, "sid": secrets.token_urlsafe(16), "raw": raw,
                     "csrf": secrets.token_urlsafe(24), "sha": hashlib.sha256(raw.encode()).hexdigest()})

PATHY = re.compile(r"(path|file|dir)", re.I)
def redirect_absolute_paths(con, side_dir):
    """Every absolute path in a path-like column now points inside this copy's own dir."""
    prefix = side_dir + "/_abs"
    moved = 0
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    for t in tables:
        for col in con.execute(f'PRAGMA table_info("{t}")').fetchall():
            c = col[1]
            if not PATHY.search(c):
                continue
            cur = con.execute(f'UPDATE "{t}" SET "{c}" = ? || "{c}" '
                              f'WHERE typeof("{c}") = \'text\' AND substr("{c}", 1, 1) = \'/\'', (prefix,))
            moved += max(cur.rowcount, 0)
            left = con.execute(f'SELECT count(*) FROM "{t}" WHERE typeof("{c}") = \'text\' '
                               f'AND substr("{c}", 1, 1) = \'/\' AND substr("{c}", 1, ?) != ?',
                               (len(prefix), prefix)).fetchone()[0]
            if left:
                raise SystemExit(f"REFUSING: {left} absolute path(s) in {t}.{c} could not be redirected")
    return moved

moved = {}
for side in ("py", "node"):
    path = os.path.join(S, side, "live.db")
    dst = sqlite3.connect(path)
    src.backup(dst)
    moved[side] = redirect_absolute_paths(dst, os.path.join(S, side))
    for s in sessions:
        dst.execute("INSERT INTO sessions (id, user_id, token_sha256, csrf, created_at, last_seen_at,"
                    " expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)",
                    (s["sid"], s["user_id"], s["sha"], s["csrf"], now, now, far, "127.0.0.1", "shadow-compare"))
    dst.commit()
    ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
    dst.close()
    if ok != "ok":
        raise SystemExit(f"REFUSING: the {side} copy failed its integrity check: {ok}")
    with open(os.path.join(S, side, "secret.key"), "wb") as fh:
        fh.write(key)
    os.chmod(os.path.join(S, side, "secret.key"), 0o600)
jobs = src.execute("SELECT id, user_id FROM jobs ORDER BY created_at").fetchall()
states = dict(src.execute("SELECT state, count(*) FROM jobs GROUP BY state").fetchall())
plan = {"start": now,
        "sessions": [{"user_id": s["user_id"], "role": s["role"], "cookie": f"{s['sid']}.{s['raw']}",
                      "csrf": s["csrf"]} for s in sessions],
        "jobs": [{"id": j, "user_id": u} for j, u in jobs],
        "users": [u[0] for u in users]}
json.dump(plan, open(os.path.join(S, "plan.json"), "w"))
print(f"copies made   : {len(users)} accounts ({sum(1 for u in users if u[2] == 'admin')} admin), "
      f"{len(sessions)} shadow sessions, {len(jobs)} jobs {states}, "
      f"absolute file paths redirected: {moved['py']}")
PY
[ $? -eq 0 ] || { echo "REFUSING: the copy step failed"; exit 1; }

# ── start both, then insist they came up in the safe modes ───────────────────
sudo -u voicestudio env -i HOME=/opt/voicestudio PATH=/usr/bin:/bin bash "$S/launch.sh" py /opt/voicestudio/app/backend \
  /opt/voicestudio/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8198 &
sudo -u voicestudio env -i HOME=/opt/voicestudio PATH=/usr/bin:/bin bash "$S/launch.sh" node /opt/voicestudio/app/backend-node \
  /opt/voicestudio/node/bin/node dist/main.js --host 127.0.0.1 --port 8197 &
a=000; b=000
for i in $(seq 1 60); do
  a=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8198/api/health || true)
  b=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8197/api/health || true)
  [ "$a" = 200 ] && [ "$b" = 200 ] && break
  sleep 1
done
echo "shadows up    : python $a, node $b (after ${i}s)"
if [ "$a" != 200 ] || [ "$b" != 200 ]; then
  for side in py node; do echo "--- $side log (last 25 lines) ---"; sudo tail -n 25 "$S/$side.log"; done
  exit 1
fi
for side in py node; do
  banner=$(sudo cat "$S/$side.log")
  if ! grep -q 'engine mode : fake' <<<"$banner" || ! grep -qE 'gpu auto +: off' <<<"$banner" \
     || ! grep -qE 'mail +: file' <<<"$banner" || ! grep -qE 'payments +: .*TEST MODE' <<<"$banner"; then
    echo "REFUSING: the $side shadow did not start in the safe modes:"
    grep -E 'engine mode|gpu auto|mail  |payments' <<<"$banner" | sed 's/^/    /'
    exit 1
  fi
done
echo "safe modes    : both report engine fake, GPU off, mail to files, payments in test mode"

# ── the comparison ───────────────────────────────────────────────────────────
sudo -u voicestudio python3 - "$S" <<'PY'
import base64, json, re, sys, urllib.error, urllib.request
from collections import Counter
S = sys.argv[1]
plan = json.load(open(f"{S}/plan.json"))
START = plan["start"]
PY_, NODE = "http://127.0.0.1:8198", "http://127.0.0.1:8197"
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")

def mask(s):
    """Diff snippets land in a local log: no customer's address or IP in it."""
    return IPV4.sub("<ip>", EMAIL.sub("<email>", s))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None
opener = urllib.request.build_opener(NoRedirect)

def call(base, method, path, cookie=None, csrf=None, body=None, raw=None, accept="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", f"vs_session={cookie}")
    if csrf:
        req.add_header("X-CSRF-Token", csrf)
    req.add_header("Accept", accept)
    try:
        with opener.open(req, timeout=60) as r:
            return r.status, (r.headers.get("content-type") or ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, (e.headers.get("content-type") or ""), e.read()

def token_payload(t):
    body = t.rsplit(".", 1)[0]
    try:
        p = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        p.pop("e", None)
        return p
    except Exception:
        return None

def norm(v, side):
    if isinstance(v, dict):
        return {k: norm(x, side) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x, side) for x in v]
    if isinstance(v, str):
        v = v.replace(f"{S}/{side}", "<DATA>")
        if STAMP.match(v) and v >= START:
            return "<made during this check>"
        if TOKEN.match(v):
            return {"<token payload>": token_payload(v)}
        m = re.match(r"^(.*?/dl/)([A-Za-z0-9_.-]+)(.*)$", v)
        if m:
            return {"<dl link>": m.group(1), "payload": token_payload(m.group(2))}
        return v
    return v

EXPECTED = {  # deliberate differences, stated in the README
    "/api/admin/portability": "the environment report names the runtime: python vs node",
}
same = numfmt = 0
diffs, expected_hits, errors, n = [], [], [], 0
statuses = Counter()

def compare(label, method, path, **kw):
    global same, numfmt, n
    n += 1
    a = call(PY_, method, path, **kw)
    b = call(NODE, method, path, **kw)
    statuses[a[0]] += 1
    if a[0] >= 500 or b[0] >= 500:
        errors.append(f"{label} {method} {path}: python {a[0]}, node {b[0]}")
    if a[0] != b[0]:
        diffs.append(f"{label} {method} {path}: status python {a[0]} vs node {b[0]}")
        return a, b
    ja = jb = None
    if "json" in a[1] and "json" in b[1]:
        try:
            ja, jb = json.loads(a[2]), json.loads(b[2])
        except Exception:
            pass
    if ja is not None and jb is not None:
        na, nb = norm(ja, "py"), norm(jb, "node")
        if na == nb:
            same += 1
            if a[2] != b[2] and a[2].replace(b".0,", b",") != b[2]:
                numfmt += 1
            return a, b
        base = path.split("?")[0]
        if base in EXPECTED:
            expected_hits.append(f"{method} {path}: {EXPECTED[base]}")
            return a, b
        sa, sb = json.dumps(na, sort_keys=True), json.dumps(nb, sort_keys=True)
        i = next((k for k in range(min(len(sa), len(sb))) if sa[k] != sb[k]), min(len(sa), len(sb)))
        diffs.append(f"{label} {method} {path}: body differs at {i}: python ...{sa[max(0,i-60):i+60]}... node ...{sb[max(0,i-60):i+60]}...")
        return a, b
    if a[2].replace(f"{S}/py".encode(), b"<DATA>") == b[2].replace(f"{S}/node".encode(), b"<DATA>"):
        same += 1
    else:
        diffs.append(f"{label} {method} {path}: non-JSON body differs ({len(a[2])} vs {len(b[2])} bytes, {a[1]} vs {b[1]})")
    return a, b

# ── a stranger ──
for p in ["/api/health", "/api/site", "/api/billing/plans", "/api/privacy/notice", "/robots.txt",
          "/sitemap.xml", "/nope", "/api/nope", "/api/auth/me", "/api/jobs", "/api/billing/me",
          "/api/billing/topups", "/api/privacy/consent", "/api/privacy/export", "/api/admin/overview",
          "/api/admin/db", "/db", "/static/db.html", "/api/billing/plans/", "/openapi.json", "/docs",
          "/redoc"]:
    compare("anon", "GET", p)
compare("anon", "GET", "/nope", accept="text/html")
compare("anon", "POST", "/api/health")
compare("anon", "POST", "/api/auth/login", body={})
compare("anon", "POST", "/api/auth/login", raw=b"{bad")
compare("anon", "POST", "/api/auth/login", body={"email": "not-an-email", "password": "x"})
compare("anon", "POST", "/api/auth/register", body={"email": "x@y", "password": "short"})
compare("anon", "GET", "/dl/not-a-real-token")

# ── every account, as itself ──
own = {}
for j in plan["jobs"]:
    own.setdefault(j["user_id"], []).append(j["id"])
all_jobs = [j["id"] for j in plan["jobs"]]
for s in plan["sessions"]:
    c, t, uid = s["cookie"], s["csrf"], s["user_id"]
    lab = f"user#{uid}({s['role']})"
    for p in ["/api/auth/me", "/api/health", "/api/jobs", "/api/billing/me", "/api/billing/topups",
              "/api/billing/plans", "/api/privacy/consent", "/api/privacy/export"]:
        compare(lab, "GET", p, cookie=c)
    for jid in own.get(uid, []):
        for p in [f"/api/jobs/{jid}", f"/api/jobs/{jid}/events", f"/api/jobs/{jid}/events?after_id=3",
                  f"/api/jobs/{jid}/formats", f"/api/jobs/{jid}/download-token",
                  f"/api/jobs/{jid}/download-token?format=m4a&inline=true"]:
            compare(lab, "GET", p, cookie=c)
    others = [x for x in all_jobs if x not in own.get(uid, [])][:2]
    for jid in others:
        compare(lab, "GET", f"/api/jobs/{jid}", cookie=c)
    if s["role"] != "admin":
        compare(lab, "GET", "/api/admin/overview", cookie=c)
        compare(lab, "GET", "/db", cookie=c)
        continue
    for p in ["/api/admin/overview", "/api/admin/users", "/api/admin/users?q=a", "/api/admin/signups",
              "/api/admin/sessions", "/api/admin/gpu", "/api/admin/storage", "/api/admin/mail",
              "/api/admin/limits", "/api/admin/portability", "/api/admin/audit", "/api/admin/preset",
              "/api/admin/inbox", "/api/admin/dpdp", "/api/admin/maintenance", "/api/admin/seo",
              "/api/admin/billing", "/api/admin/db", "/api/admin/db/table/users?limit=5",
              "/api/admin/db/table/jobs?limit=5", "/api/admin/db/table/payments?limit=5",
              "/api/admin/access-log"]:
        compare(lab, "GET", p, cookie=c)
    for u in plan["users"]:
        compare(lab, "GET", f"/api/admin/users/{u}/jobs", cookie=c)
        compare(lab, "GET", f"/api/admin/users/{u}/consent", cookie=c)
    compare(lab, "POST", "/api/admin/db/query", cookie=c, csrf=t,
            body={"sql": "SELECT id, email, role, password_hash AS h FROM users"})
    compare(lab, "GET", "/db", cookie=c, accept="text/html")

print(f"compared      : {n} requests, each sent to both backends")
print(f"status codes  : " + ", ".join(f"{k} x {v}" for k, v in sorted(statuses.items())))
print(f"identical     : {same}  (of which {numfmt} differ only in how a whole float is printed, e.g. 28 vs 28.0)")
print(f"expected      : {len(expected_hits)}  " + "; ".join(sorted(set(expected_hits)))[:300])
print(f"server errors : {len(errors)}")
for e in errors[:20]:
    print("   ", mask(e)[:300])
print(f"DIFFERENT     : {len(diffs)}")
for d in diffs[:40]:
    print("   ", mask(d)[:400])
PY
echo
for side in py node; do
  echo "$side shadow log : $(sudo grep -cE '" 5[0-9][0-9]' "$S/$side.log" 2>/dev/null || true) x 5xx, $(sudo grep -cE 'Traceback|Error:' "$S/$side.log" 2>/dev/null || true) error lines"
done
'@
$out | Out-File -Encoding utf8 $log
$out
