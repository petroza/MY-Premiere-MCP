# Hermes (Qwen3.6-35B-A3B) jako lokalni LLM backend pro MYpremiereMCP.
# Vse je ve slozce projektu (models\hermes, tools\llama.cpp-hermes) - nic mimo ni neni potreba.
#
#   .\scripts\hermes.ps1 start          spusti textove (vic pameti na kontext)
#   .\scripts\hermes.ps1 start -Vize    spusti s videnim (mmproj, pro popis obrazu)
#   .\scripts\hermes.ps1 stop
#   .\scripts\hermes.ps1 status
#
# Parametry vychazeji z overeneho nastaveni (puvodni O:\Hermes\switch-llm.ps1): 30 ze 40 MoE vrstev
# v RAM, aby se model i s videnim vesel do 12 GB VRAM (~42-54 tok/s). Automaticke --fit na Windows
# VRAM preplni a ovladac preleva do sdilene pameti (~10 tok/s).
#
# Pozn.: bez diakritiky zamerne - PowerShell 5.1 cte .ps1 bez BOM jako ANSI a diakritika skript rozbije.
param(
    [ValidateSet('start', 'stop', 'status')] [string]$Akce = 'status',
    [switch]$Vize,
    [int]$Port = 8000,
    [int]$Ctx = 65536,
    [int]$NCpuMoe = 30
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'tools\llama.cpp-hermes\llama-server.exe'
$model = Join-Path $root 'models\hermes\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'
$mmproj = Join-Path $root 'models\hermes\mmproj-Qwen3.6-35B-A3B-F16.gguf'
$log = Join-Path $root 'cache\hermes\llama-server.log'

function Stop-Hermes {
    # jen nas server - Ollama i pripadny cizi Hermes maji vlastni llama-server.exe, na ty nesahat
    Get-Process llama-server -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $server } | Stop-Process -Force
}

switch ($Akce) {
    'stop' { Stop-Hermes; Write-Host 'Hermes zastaven.'; exit 0 }
    'status' {
        $p = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
             Where-Object { $_.ExecutablePath -eq $server }
        if ($p) { Write-Host "Hermes z projektu bezi (pid $($p.ProcessId))." }
        else { Write-Host 'Hermes z tohoto projektu nebezi.' }
        try {
            $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            Write-Host "Na portu $Port odpovida server: $($h.status)"
        } catch { Write-Host "Na portu $Port nic neodpovida." }
        exit 0
    }
}

foreach ($f in @($server, $model)) {
    if (-not (Test-Path $f)) { throw "Chybi soubor: $f" }
}
if ($Vize -and -not (Test-Path $mmproj)) { throw "Chybi mmproj pro videni: $mmproj" }

Stop-Hermes
Start-Sleep -Seconds 1
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

# -a dflash: alias modelu, na ktery se odkazuje config.json (llmBackends.hermes.model)
$argy = @('-m', $model)
if ($Vize) { $argy += @('--mmproj', $mmproj) }
$argy += @('--temp', '0.6', '--top-p', '0.95', '--top-k', '20', '--min-p', '0',
           '-a', 'dflash', '--host', '127.0.0.1', '--port', $Port,
           '-np', '1', '--load-mode', 'none', '--jinja', '-fa', 'on',
           '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
           '-n', '8192', '--reasoning-budget', '2048', '--no-reasoning-preserve',
           '-c', $Ctx, '-ngl', '999', '--n-cpu-moe', $NCpuMoe)

Start-Process -FilePath $server -ArgumentList $argy -WindowStyle Hidden `
    -RedirectStandardError $log -RedirectStandardOutput "$log.out"
$rezim = if ($Vize) { 's videnim' } else { 'textove' }
Write-Host "Startuji Hermese $rezim na portu $Port - model se nacita..."

for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 2
    try {
        if ((Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2).status -eq 'ok') {
            Write-Host "Hermes je pripraveny (http://127.0.0.1:$Port)." -ForegroundColor Green
            exit 0
        }
    } catch { }
}
Write-Host "Server do 6 minut nenaskocil, mrkni do logu: $log" -ForegroundColor Yellow
exit 1
