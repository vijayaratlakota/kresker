# Sets VS_SOURCE_SWEEP_SINCE in the live env file, so the new source-video cleanup
# leaves every upload that already exists alone and only deletes uploads made from now on.
#
#   * backs the env file up first (same folder, same owner and mode)
#   * never CHANGES an existing value: if the line is there, it is reported and left
#   * appends one comment line and one setting; prints only that setting, no other values
#   * takes effect at the next restart of the service (deploy\_cutover_node.ps1)
# Undo: delete the two lines (or restore the .bak file) and restart. Removing the setting
# is also how the old backlog is cleared on purpose later.
$ErrorActionPreference = 'Continue'
. 'c:\video translator\deploy\_remote.ps1'
$log = 'c:\video translator\deploy\_set_sweep_since.log'
$out = Remote @'
set -uo pipefail
ENVF=/opt/voicestudio/voicestudio.env
sudo test -f "$ENVF" || { echo "REFUSING: $ENVF not found"; exit 1; }
if sudo grep -qE '^VS_SOURCE_SWEEP_SINCE=' "$ENVF"; then
  echo "already set   : $(sudo grep -E '^VS_SOURCE_SWEEP_SINCE=' "$ENVF" | head -1)  (left as it is)"
  exit 0
fi
before=$(sudo stat -c '%U:%G %a' "$ENVF")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BK="$ENVF.bak-$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp -p "$ENVF" "$BK"
# the new line must start on a line of its own even if the file has no final newline
[ -n "$(sudo tail -c1 "$ENVF")" ] && echo | sudo tee -a "$ENVF" >/dev/null
printf '%s\n' \
  "# Source-video cleanup (backend-node worker.sweepSourceUploads) leaves uploads made before this alone. Added $TS." \
  "VS_SOURCE_SWEEP_SINCE=$TS" | sudo tee -a "$ENVF" >/dev/null
after=$(sudo stat -c '%U:%G %a' "$ENVF")
echo "set           : $(sudo grep -E '^VS_SOURCE_SWEEP_SINCE=' "$ENVF" | head -1)"
echo "backup        : $BK"
echo "owner/mode    : $before -> $after"
echo "lines         : $(sudo cat "$BK" | wc -l) before, $(sudo cat "$ENVF" | wc -l) now"
echo "takes effect  : at the next service restart"
'@
$out | Out-File -Encoding utf8 $log
$out
