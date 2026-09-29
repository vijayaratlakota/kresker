# Remote execution helper for the web server. Dot-sourced by the provisioning scripts.
#
# THREE THINGS THAT COST TIME HERE, RECORDED SO THEY ARE NOT REPEATED:
#
#   1. Passing the remote command inline through Start-Process -ArgumentList with nested
#      quotes made ssh sit waiting for input until the step timed out. It looked exactly
#      like a firewall problem; port 22 was open the whole time.
#   2. `Start-Process -PassThru` WITHOUT `-Wait`, then $p.WaitForExit(), returned with the
#      redirect files still empty and no exit code. With `-Wait` it works - but the plain
#      `&` call operator is simpler and captures both streams with `2>&1`, so that is what
#      is used now.
#   3. ssh and scp split the value of `-o` on whitespace, so UserKnownHostsFile must not
#      contain a space. The workspace path does, hence known_hosts lives under ~/.ssh.
$script:SSH = "$env:SystemRoot\System32\OpenSSH\ssh.exe"
$script:SCP = "$env:SystemRoot\System32\OpenSSH\scp.exe"
$script:KEY = Join-Path $env:USERPROFILE '.ssh\kresker-web.pem'
$script:KNOWN = Join-Path $env:USERPROFILE '.ssh\kresker_known_hosts'
$script:WEBIP = (Get-Content 'c:\video translator\deploy\_webip.txt' -Raw).Trim()
$script:RemoteSeq = 0

if (-not (Test-Path $script:KNOWN)) { New-Item -ItemType File -Path $script:KNOWN -Force | Out-Null }

function SshArgs() {
    return @(
        '-i', $script:KEY,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', "UserKnownHostsFile=$($script:KNOWN)",
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=25',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=240',
        '-o', 'LogLevel=ERROR'
    )
}

# Run a bash script body on the box. Returns the combined output as a single string.
#
# ALWAYS via scp, never inline, and that is not caution - it is required.
#
# An inline body is parsed TWICE: once by ssh building its argv, then again by the remote
# shell. Anything containing quotes, backslashes or `$` comes apart. It cost a whole
# provisioning round: every `sed "s/^/  /"` returned `unterminated s command` and every
# `awk "NR<=3{print \$0}"` became `=3{print: No such file or directory`, which reads like
# broken sed and awk rather than a transport problem.
#
# Copied to a file and run by path, the script is read verbatim from disk and parsed once.
#
# `exec 2>&1` is injected at the top so the remote side merges its own streams. Letting
# PowerShell capture ssh's stderr with `2>&1` instead wraps each line in a
# NativeCommandError, which stringifies to the useless literal
# "System.Management.Automation.RemoteException".
function Remote($body, $label = 'step') {
    $script:RemoteSeq++
    $n = $script:RemoteSeq
    $lf = "exec 2>&1`n" + ($body -replace "`r`n", "`n")
    $tmp = Join-Path $env:TEMP "rs_$n.sh"
    [System.IO.File]::WriteAllText($tmp, $lf, (New-Object System.Text.UTF8Encoding $false))

    & $script:SCP @(SshArgs) $tmp "ubuntu@$($script:WEBIP):/tmp/rs_$n.sh" | Out-Null
    if ($LASTEXITCODE -ne 0) { return "SCP FAILED for $label (exit $LASTEXITCODE)" }

    $lines = & $script:SSH @(SshArgs) "ubuntu@$($script:WEBIP)" "bash /tmp/rs_$n.sh"
    $text = (($lines | ForEach-Object { [string]$_ }) -join "`n")
    if (-not $text.Trim()) { $text = "(no output; ssh exit $LASTEXITCODE)" }
    return $text
}

# Copy a local file or directory up. Returns $true on success.
function Push-Remote($localPath, $remotePath, [switch]$Recurse) {
    $a = SshArgs
    if ($Recurse) { $a += '-r' }
    & $script:SCP @a $localPath "ubuntu@$($script:WEBIP):$remotePath" 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}
