# Ship the built frontend and nothing else.
#
# For changes that live entirely in frontend/src. It does not touch a single backend file, so
# there is no migration to run and no schema to check - which also means it is the deploy to
# reach for when the risk of restarting the API is not worth taking.
#
# THE SERVICE IS NOT RESTARTED. nginx serves these files, not the backend, and the Node
# backend notices a new build by itself: it re-reads index.html whenever its mtime changes
# (site.ts, buildId), which is all /api/site reports. The restart this used to do had no
# guard, and a restart requeues a running dub from the start.
#
# `dist.old` is kept, so a bad bundle is one `mv` away from being undone.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. "c:\video translator\deploy\_remote.ps1"

$tar = "$env:SystemRoot\System32\tar.exe"
$log = "c:\video translator\deploy\_ship_dist.log"
"=== ship dist  $(Get-Date -Format s) ===" | Out-File -Encoding utf8 $log
function Log([string]$s) { $s | Out-File -Append -Encoding utf8 $log; Write-Host $s }

$dist = "c:\video translator\frontend\dist"
if (-not (Test-Path $dist)) { throw "no dist - run npm run build first" }

Log "--- packing ---"
$tgz = "c:\video translator\frontend\_dist_$(Get-Date -Format yyyyMMddHHmmss).tgz"
& $tar -czf $tgz -C "c:\video translator\frontend" dist
if ($LASTEXITCODE -ne 0) { throw "tar failed" }
if (-not (Push-Remote $tgz '/tmp/dist.tgz')) { throw "scp failed" }
Log "  staged dist.tgz ($([math]::Round((Get-Item $tgz).Length/1MB,1)) MB)"
try { Remove-Item $tgz -Force -ErrorAction Stop } catch { Log "  (left $tgz behind)" }

Log "--- installing ---"
Log (Remote @'
set -e
cd /opt/voicestudio/app/frontend
sudo rm -rf dist.old
[ -d dist ] && sudo mv dist dist.old
sudo tar -xzf /tmp/dist.tgz -C /opt/voicestudio/app/frontend
# THE DEMO VIDEOS GO, THE POSTER STAYS.
#
# This used to be `rm -rf dist/demo`, which was right when everything in that folder
# was a ~9 MB reel served from R2 instead. It stopped being right when poster.webp
# moved back into the bundle: that frame is the homepage's LCP element, and deleting
# the whole directory meant production served a broken image reference for the one
# asset Google times.
#
# So: the media files are removed by extension and poster.webp survives. Named
# explicitly rather than by an exclusion glob, because a `find ! -name` typo silently
# deletes everything and this runs unattended.
sudo rm -f /opt/voicestudio/app/frontend/dist/demo/*.mp4 \
           /opt/voicestudio/app/frontend/dist/demo/*.m4a
sudo chown -R voicestudio:voicestudio /opt/voicestudio/app/frontend/dist
# The LCP asset has to be there after that deletion, so it is asserted rather than
# assumed - a missing poster is invisible until somebody looks at the homepage.
test -f /opt/voicestudio/app/frontend/dist/demo/poster.webp \
  && echo "  poster.webp: present ($(stat -c%s /opt/voicestudio/app/frontend/dist/demo/poster.webp) bytes)" \
  || echo "  poster.webp: MISSING - the homepage LCP image will 404"
rm -f /tmp/dist.tgz
echo "  service: $(systemctl is-active voicestudio) (not restarted), health $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/api/health)"
'@ 'install')

Log "--- build stamp ---"
$idx = (Invoke-WebRequest -Uri 'https://kresker.com/' -UseBasicParsing -TimeoutSec 30).Content
$entry = [regex]::Match($idx, 'assets/(index-[A-Za-z0-9_-]+\.js)').Groups[1].Value
$stamp = ((Invoke-WebRequest -Uri 'https://kresker.com/api/site' -UseBasicParsing `
           -TimeoutSec 30).Content | ConvertFrom-Json).build
Log "  index.html entry chunk : $entry"
Log "  /api/site reports      : $stamp"
Log ("  --> " + $(if ($stamp -and $entry -match [regex]::Escape($stamp)) { 'agree' } else { 'DISAGREE' }))

# THE BUILD STAMP ONLY PROVES SOME NEW BUNDLE IS LIVE. These strings prove it is this one,
# and they are fetched from the site rather than read off local disk for the same reason.
# Each pair is (a file in dist\assets, a string only this release has). Update per release.
Log "--- strings from this release, as served ---"
$css = [regex]::Match($idx, 'assets/(index-[A-Za-z0-9_-]+\.css)').Groups[1].Value
$checks = @(
  @($entry,                'd3iq4yczk6aieh.cloudfront.net'), # demo reel now on AWS CloudFront
  @('AdminSystem-*.js',    'AWS S3'),                     # admin storage panel names S3
  @($entry,                'Email us'),                   # maintenance page, no router
  @($css,                  'data-mounted'),               # a toast arrives opaque
  @('JobsTable-*.js',      'video expired'),              # the phone list of dubs
  @('AdminPeople-*.js',    'Personal data access log'),   # the new admin screens
  @('AdminBilling-*.js',   'Run the renewal sweep now'),
  @('AdminGpu-*.js',       'Stop sent to AWS')            # force stop reports the truth
)
$allFound = $true
foreach ($c in $checks) {
  $name = $c[0]
  if ($name -like '*`**') {
    $name = (Get-ChildItem "c:\video translator\frontend\dist\assets\$name" | Select-Object -First 1).Name
  }
  try {
    $body = (Invoke-WebRequest -Uri "https://kresker.com/assets/$name" -UseBasicParsing -TimeoutSec 30).Content
    $found = ([string]$body).Contains($c[1])
  } catch { $found = $false }
  if (-not $found) { $allFound = $false }
  Log ("  {0,-34} {1,-28} {2}" -f $name, $c[1], $found)
}
Log ("  --> " + $(if ($allFound) { 'this release is the one being served' } else { 'SOMETHING IS MISSING' }))

Log "Done. Log: $log"
