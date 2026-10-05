# Zastavi vsechny AI procesy pluginu, aby uvolnily grafiku a pamet pro Premiere:
#  - vsechny llama-server.exe (Hermes z projektu i jinych instalaci, napr. O:\Hermes; lokalni a vision modely)
#  - lokalni Worker (worker\server.py) vcetne podrizenych procesu (Whisper, diarizace)
#  - Ollama, kdyz bezi
# Premiere ani panel se nezastavuji. Spousti tlacitko "Zastavit AI" v panelu, rucne:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-all.ps1
# Duvod (2026-10-05): dva Hermesy (35B) naraz drzely 11,8 z 12,3 GB grafiky a 33 GB RAM, Premiere s 4K
# zaznamy mela 2 GB a sekala se cely pocitac.
$ErrorActionPreference = 'SilentlyContinue'
$stopped = @()

foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'")) {
    $label = if ($p.CommandLine -match 'Qwen3\.6|hermes') { 'Hermes' } elseif ($p.CommandLine -match 'VL|mmproj') { 'vision model' } else { 'lokalni LLM' }
    taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
    $stopped += "$label (llama-server, PID $($p.ProcessId), $([math]::Round($p.WorkingSetSize / 1GB, 1)) GB RAM)"
}

# Ollama (pokud je nainstalovana) - po nacteni modelu taky drzi grafiku
foreach ($p in @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^ollama' })) {
    taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
    $stopped += "Ollama ($($p.Name), PID $($p.ProcessId))"
}

foreach ($p in @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'worker[\\/]server\.py' })) {
    taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
    $stopped += "Worker (PID $($p.ProcessId))"
}

Start-Sleep -Milliseconds 800
$vram = ''
try { $vram = (& nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1) } catch { }

if ($stopped.Count) { 'Zastaveno:'; $stopped | ForEach-Object { "  - $_" } }
else { 'Nebezel zadny AI proces pluginu.' }
if ($vram) { $v = $vram -split ',\s*'; "Grafika: obsazeno $([math]::Round([double]$v[0] / 1024, 1)) z $([math]::Round([double]$v[1] / 1024, 1)) GB" }
