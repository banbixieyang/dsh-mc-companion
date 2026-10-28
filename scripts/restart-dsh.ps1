# Restart DeepSeek Harness so the linked bundles load their new code.
#
# Why a restart: the profile links dsh-mc-companion / dsh-mc-companion-ui from
# the workspace, and the Host only composes the plugin tree at start-up (the
# plugin-manager marks such changes "restart-required"). There is no
# unauthenticated reload endpoint (/api/* answers 401 except plugin routes).
#
# The script runs detached from the agent session, because killing the app ends
# the session that launched it. It writes its findings to logs/restart-verify.log
# so the next session can read them.

$ErrorActionPreference = 'Continue'
$exe = 'C:\Users\Lenovo\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$logDir = 'C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\dsh-mc-companion\logs'
$log = Join-Path $logDir 'restart-verify.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $log -Value $line -Encoding utf8
}

Set-Content -Path $log -Value ("restart requested {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding utf8

# Give the agent turn a moment to finish streaming before the app goes away.
Start-Sleep -Seconds 5

# 1. close gracefully, then force-kill if it lingers
$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
Write-Log ("stopping {0} process(es): {1}" -f $procs.Count, (($procs | Select-Object -ExpandProperty Id) -join ','))
foreach ($p in $procs) {
  try { $null = $p.CloseMainWindow() } catch { Write-Log ("close failed: {0}" -f $_.Exception.Message) }
}
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
}
$still = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($still) {
  Write-Log ("forcing stop of {0}" -f (($still | Select-Object -ExpandProperty Id) -join ','))
  $still | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

# 2. start again
if (-not (Test-Path $exe)) {
  Write-Log "ERROR exe not found: $exe"
  exit 1
}
Start-Process -FilePath $exe
Write-Log 'relaunched'

# 3. wait for the web server and look for the new plugin build
$newBuild = $false
for ($attempt = 0; $attempt -lt 60 -and -not $newBuild; $attempt++) {
  Start-Sleep -Seconds 2
  $hostProc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $hostProc) { continue }
  $ports = Get-NetTCPConnection -State Listen -OwningProcess $hostProc.Id -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty LocalPort -Unique
  foreach ($port in $ports) {
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/mc-companion/state" -f $port) -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -ne 200) { continue }
      $state = $r.Content | ConvertFrom-Json
      $tools = @($state.tools)
      $hasAutopilot = $null -ne $state.autopilot
      Write-Log ("port {0}: version={1} tools={2} autopilot={3}" -f $port, $state.version, $tools.Count, $hasAutopilot)
      if ($hasAutopilot -and $tools.Count -ge 16) {
        $newBuild = $true
        Write-Log ("OK new build loaded ({0} tools, autopilot present)" -f $tools.Count)
      } else {
        Write-Log 'still the old build; waiting for the loader'
      }
      break
    } catch {
      continue
    }
  }
}

if (-not $newBuild) {
  Write-Log 'WARN could not confirm the new build within 120s; check the panel manually'
}
Write-Log 'done'
