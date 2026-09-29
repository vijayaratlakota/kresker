# /pricing (and the other prerendered pages) answer 200 again instead of a 301 to /pricing/.
#
# WHY: the prerendered pages are directories - dist/pricing/index.html - and with
# `try_files $uri $uri/ /index.html` nginx sees the directory and redirects to add a slash.
# The sitemap and every canonical tag say https://kresker.com/pricing, so each listed URL
# redirected to a page whose canonical points straight back. Checking `$uri/index.html` as a
# FILE first serves the page at the URL the sitemap names, with no redirect. Everything
# else resolves exactly as before (the SPA fallback is unchanged).
#
# Safe by construction: backup first, exactly one line must match, `nginx -t` must pass or
# the backup goes straight back, and a graceful reload (no dropped connections).
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_nginx_no_slash_redirect.log'
$out = Remote @'
set -uo pipefail
F=/etc/nginx/snippets/kresker-app.conf
OLD='try_files $uri $uri/ /index.html;'
NEW='try_files $uri $uri/index.html $uri/ /index.html;'
probe() { curl -s -o /dev/null -w '%{http_code}' -H 'Host: kresker.com' "http://127.0.0.1$1"; }
echo "before        : /pricing $(probe /pricing), /pricing/ $(probe /pricing/), / $(probe /), /app $(probe /app)"
if sudo grep -qF "$NEW" "$F"; then echo "already done  : $F has the new rule"; exit 0; fi
n=$(sudo grep -cF "$OLD" "$F" || true)
[ "$n" = 1 ] || { echo "REFUSING: expected exactly one '$OLD' in $F, found $n - nothing changed"; exit 1; }
BK="$F.bak-$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp -p "$F" "$BK"
sudo sed -i 's#try_files \$uri \$uri/ /index.html;#try_files $uri $uri/index.html $uri/ /index.html;#' "$F"
if ! sudo nginx -t 2>&1 | sed 's/^/  nginx -t: /'; then :; fi
if sudo nginx -t >/dev/null 2>&1; then
  sudo systemctl reload nginx
  sleep 1
  echo "changed       : $(sudo grep -F "$NEW" "$F" | sed 's/^ *//')"
  echo "backup        : $BK"
else
  sudo cp -p "$BK" "$F"
  echo "RESTORED the backup: the new config did not pass nginx -t, nothing was reloaded"
  exit 1
fi
echo "after         : /pricing $(probe /pricing), /pricing/ $(probe /pricing/), /privacy $(probe /privacy), / $(probe /), /app $(probe /app), /app/jobs/x $(probe /app/jobs/x), /nope $(probe /nope), /api/health $(probe /api/health), /assets/missing.js $(probe /assets/missing.js)"
echo "nginx         : $(systemctl is-active nginx)"
'@
$out | Out-File -Encoding utf8 $log
$out
