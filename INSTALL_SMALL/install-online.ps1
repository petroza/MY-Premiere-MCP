# MY Premiere MCP - mala online instalace.
# Vse se stahuje z internetu: kod aplikace z GitHubu, Node.js a Python pres winget (kdyz chybi),
# balicky (npm, pip) a modely (Whisper, diarizace, lokalni LLM). Pak se spusti hlavni instalator
# INSTALL\install.ps1 ze stazeneho kodu (kontroly, panel do Premiere, registrace MCP, overeni).
#
# Spousti se pres Instalace.cmd. Prepinace (predaji se hlavnimu instalatoru):
#   -Target <slozka>  kam instalovat (jinak se zepta; vychozi %USERPROFILE%\MYpremiereMCP)
#   -Hermes           stahnout i Hermes (~23 GB, silnejsi lokalni strih) - jinak se zepta
#   -NoLocalLLM       bez lokalniho LLM (usetri ~9 GB)
#   -SkipModels       jen panel a MCP, bez modelu
#   -Branch <vetev>   vetev na GitHubu (vychozi main)
#
# Pozn.: zamerne bez diakritiky - Windows PowerShell 5.1 cte .ps1 bez BOM jako ANSI.
param(
    [string]$Target,
    [switch]$Hermes,
    [switch]$NoLocalLLM,
    [switch]$SkipModels,
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$repo = 'petroza/MY-Premiere-MCP'

function Head($t) { Write-Host ''; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [OK]    $t" -ForegroundColor Green }
function Info($t) { Write-Host "          $t" -ForegroundColor DarkGray }
function Die($t, $fix) {
    Write-Host "  [CHYBA] $t" -ForegroundColor Red
    if ($fix) { Write-Host "          -> $fix" -ForegroundColor DarkYellow }
    exit 1
}
function Have($exe) { return [bool](Get-Command $exe -ErrorAction SilentlyContinue) }
function RefreshPath {
    # winget zapise PATH do registru, bezici proces ho nevidi - nacist znovu
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Py311 {
    if (Have 'py') { & py -3.11 -c "import sys" 2>$null; if ($LASTEXITCODE -eq 0) { return $true } }
    if (Have 'python') {
        $v = (& python -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null)
        if ($v -eq '3.11') { return $true }
    }
    return $false
}
function WingetInstall($id, $label) {
    if (-not (Have 'winget')) {
        Die "$label chybi a winget neni k dispozici" "Nainstaluj $label rucne a spust instalaci znovu."
    }
    Write-Host "          instaluji $label pres winget ..."
    & winget install -e --id $id --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { Die "Instalace $label pres winget selhala (kod $LASTEXITCODE)" "Nainstaluj $label rucne a spust instalaci znovu." }
    RefreshPath
}

Write-Host ''
Write-Host '  MY Premiere MCP - online instalace' -ForegroundColor White
Write-Host "  zdroj: https://github.com/$repo ($Branch)"

# ------------------------------------------------------------------ 1. kam
Head '1/4 Slozka aplikace'
if (-not $Target) {
    $def = Join-Path $env:USERPROFILE 'MYpremiereMCP'
    $in = Read-Host "  Kam nainstalovat? [Enter = $def]"
    $Target = if ($in.Trim()) { $in.Trim().Trim('"') } else { $def }
}
$Target = [IO.Path]::GetFullPath($Target)
$update = Test-Path (Join-Path $Target 'server\index.js')
New-Item -ItemType Directory -Force $Target | Out-Null
if ($update) { Ok "Aktualizace existujici instalace: $Target (modely, cache a config.json zustanou)" }
else { Ok "Nova instalace: $Target" }

if (-not $SkipModels -and -not $NoLocalLLM -and -not $Hermes -and -not (Test-Path (Join-Path $Target 'models\hermes'))) {
    $a = Read-Host '  Stahnout i Hermes - silnejsi lokalni strih bez kreditu (~23 GB, potreba GPU 12 GB+)? [a/N]'
    if ($a -match '^(a|ano|y|yes)$') { $Hermes = $true }
}

# ------------------------------------------------------------------ 2. predpoklady
Head '2/4 Node.js a Python'
foreach ($t in @('curl.exe', 'tar.exe')) { if (-not (Have $t)) { Die "$t nenalezen" 'Potreba Windows 10 1803 nebo novejsi.' } }
$nodeOk = $false
if (Have 'node') { $nodeOk = ([int](((& node -v) -replace '^v', '') -split '\.')[0]) -ge 18 }
if (-not $nodeOk) { WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js LTS' }
if (-not (Have 'node')) { Die 'Node.js se nepodarilo nainstalovat' 'Nainstaluj Node.js LTS z https://nodejs.org a spust instalaci znovu.' }
Ok "Node.js $(& node -v)"
if (-not $SkipModels) {
    if (-not (Py311)) { WingetInstall 'Python.Python.3.11' 'Python 3.11' }
    if (-not (Py311)) { Die 'Python 3.11 se nepodarilo nainstalovat' 'Nainstaluj Python 3.11 z python.org (zaskrtni Add to PATH) a spust instalaci znovu.' }
    Ok 'Python 3.11'
}

# ------------------------------------------------------------------ 3. kod z GitHubu
Head '3/4 Kod aplikace z GitHubu'
$tmp = Join-Path $env:TEMP ("mypremieremcp-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    $zip = Join-Path $tmp 'app.zip'
    & curl.exe -fSL --retry 3 --retry-delay 2 -o $zip "https://codeload.github.com/$repo/zip/refs/heads/$Branch"
    if ($LASTEXITCODE -ne 0) { Die 'Stazeni kodu z GitHubu selhalo' 'Zkontroluj internet / proxy (HTTPS_PROXY) a jestli je repozitar dostupny.' }
    Expand-Archive $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'server\index.js'))) { Die 'Stazeny archiv neobsahuje aplikaci' $null }
    # config.json pri aktualizaci nechat (muze byt upraveny, napr. Whisper na CPU)
    $xf = @()
    if ($update -and (Test-Path (Join-Path $Target 'config.json'))) { $xf = @('/XF', 'config.json') }
    & robocopy $src.FullName $Target /E /NFL /NDL /NJH /NJS /NC /NS /R:2 /W:2 @xf | Out-Null
    if ($LASTEXITCODE -ge 8) { Die "Kopirovani kodu selhalo (robocopy $LASTEXITCODE)" $null }
    $global:LASTEXITCODE = 0
    Ok "Kod rozbalen do $Target"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------ 4. hlavni instalator (online rezim)
Head '4/4 Instalace (zavislosti, modely, panel, registrace)'
$main = Join-Path $Target 'INSTALL\install.ps1'
$pass = @()
if ($Hermes) { $pass += '-Hermes' }
if ($NoLocalLLM) { $pass += '-NoLocalLLM' }
if ($SkipModels) { $pass += '-SkipModels' }
& powershell -NoProfile -ExecutionPolicy Bypass -File $main @pass
exit $LASTEXITCODE
