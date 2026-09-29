# Local backend for phone_check.js: port 8096, a throwaway database, the fake engine, mail
# to files, and no way to reach AWS, R2, Dodo, Google or Resend. Nothing leaves this machine.
param([string]$Stamp = (Get-Date -Format MMddHHmmss))
$ErrorActionPreference = 'Stop'
# The aws CLI off PATH, so no code path can reach a real AWS account.
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notlike '*Amazon\AWSCLIV2*' }) -join ';'
if (Get-Command aws -ErrorAction SilentlyContinue) { throw 'aws is still reachable - refusing to start' }
foreach ($k in 'VS_RESEND_API_KEY', 'VS_GOOGLE_CLIENT_ID', 'VS_GOOGLE_CLIENT_SECRET', 'VS_DODO_API_KEY', 'VS_DODO_WEBHOOK_SECRET', 'VS_R2_ENV_FILE', 'VS_DATA_DIR') {
    [Environment]::SetEnvironmentVariable($k, $null)
}
$env:VS_ENGINE_MODE = 'fake'
$env:VS_GPU_AUTO = '0'
$env:VS_MAIL_BACKEND = 'file'
$env:VS_R2_ENABLED = '0'
$env:VS_DODO_ENV = "c:\video translator\backend\data\_none_$Stamp.env"
$env:VS_GOOGLE_ENV = $env:VS_DODO_ENV
$env:VS_RESEND_ENV = $env:VS_DODO_ENV
$env:VS_COOKIE_INSECURE = '1'
$env:VS_PUBLIC_BASE_URL = 'http://127.0.0.1:5174'
$env:VS_FFPROBE = 'C:\Users\vijay\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.2-full_build\bin\ffprobe.exe'
$env:VS_DB_PATH = "c:\video translator\backend\data\vn_phone_$Stamp.db"
$env:VS_AWS_PROFILE = 'phone_check_no_such_profile'
$env:VS_ENGINE_PORT = '39199'
$env:VS_ENGINE_URL = 'http://127.0.0.1:39199'
Set-Location 'c:\video translator\backend-node'
& node dist\main.js --host 127.0.0.1 --port 8096
