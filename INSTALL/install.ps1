# MYpremiereMCP - instalacni balicek s kontrolami.
# Spousti se pres Instalace.cmd (nebo: powershell -NoProfile -ExecutionPolicy Bypass -File INSTALL\install.ps1)
#
# Prepinace:
#   -CheckOnly    jen kontroly, nic nemeni (stejne jako Kontrola.cmd)
#   -NoLocalLLM   preskoci gemma3 12B + vision model + llama.cpp (~9 GB) - AI strih pres Claude/GPT funguje dal
#   -SkipModels   preskoci vsechny modely vcetne Whisperu (jen panel + MCP; prepis pak nepojede)
#
# Pozn.: kod i hlasky jsou zamerne bez diakritiky - konzole cmd.exe ji na ruznych strojich mrvi.
param(
    [switch]$CheckOnly,
    [switch]$NoLocalLLM,
    [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$logFile = Join-Path $PSScriptRoot 'install-log.txt'
$offline = Join-Path $PSScriptRoot 'offline'
$hasOffline = Test-Path (Join-Path $offline 'models\whisper-large-v3\model.bin')
$script:problems = @()
$script:warnings = @()

function Head($t) { Write-Host ''; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [OK]    $t" -ForegroundColor Green }
function Warn($t, $fix) {
    Write-Host "  [!]     $t" -ForegroundColor Yellow
    if ($fix) { Write-Host "          -> $fix" -ForegroundColor DarkYellow }
    $script:warnings += $t
}
function Fail($t, $fix) {
    Write-Host "  [CHYBA] $t" -ForegroundColor Red
    if ($fix) { Write-Host "          -> $fix" -ForegroundColor DarkYellow }
    $script:problems += $t
}
function Info($t) { Write-Host "          $t" -ForegroundColor DarkGray }

function Have($exe) {
    $c = Get-Command $exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source } else { return $null }
}
function WriteTextNoBom($path, $text) {
    # .NET zapisuje UTF-8 bez BOM; Set-Content -Encoding UTF8 (PS 5.1) by BOM pridal a rozbil JSON.parse.
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}
function NetOk($hostName) {
    try { return (Test-NetConnection -ComputerName $hostName -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue) }
    catch { return $false }
}

try { Start-Transcript -Path $logFile -Force | Out-Null } catch { }

Write-Host ''
Write-Host '  MY Premiere MCP - instalace' -ForegroundColor White
Write-Host "  slozka aplikace: $root"
Write-Host "  log: $logFile"

# ------------------------------------------------------------------ 1. KONTROLY PRED INSTALACI
Head '1/4 Kontroly prostredi'

Write-Host "  Windows $([Environment]::OSVersion.Version)  PowerShell $($PSVersionTable.PSVersion)"

# -- soubory projektu
$needed = @('server\index.js', 'panel\index.html', 'package.json', 'config.json', 'worker\server.py')
$missing = @($needed | Where-Object { -not (Test-Path (Join-Path $root $_)) })
if ($missing.Count -gt 0) {
    Fail "Ve slozce aplikace chybi soubory: $($missing -join ', ')" "Zkopiruj celou slozku projektu znovu (vcetne podslozek server, panel, worker)."
} else { Ok 'Soubory projektu jsou kompletni' }

# -- misto na disku
$needGB = 15
if ($NoLocalLLM) { $needGB = 5 }
if ($SkipModels) { $needGB = 1 }
try {
    $drive = (Get-Item $root).PSDrive
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGB -lt $needGB) { Fail "Na disku $($drive.Name): je $freeGB GB volnych, potreba ~$needGB GB" "Uvolni misto, nebo spust s -NoLocalLLM (usetri ~9 GB)." }
    else { Ok "Misto na disku: $freeGB GB volnych (potreba ~$needGB GB)" }
} catch { Warn 'Nepodarilo se zjistit volne misto na disku' $null }

# -- Node.js
$node = Have 'node'
if (-not $node) {
    Fail 'Node.js neni nainstalovany (prikaz "node" nenalezen)' 'Nainstaluj Node.js LTS z https://nodejs.org a otevri nove okno prikazove radky.'
} else {
    $nodeVer = (& node -v) -replace '^v', ''
    $nodeMajor = [int]($nodeVer -split '\.')[0]
    if ($nodeMajor -lt 18) { Fail "Node.js $nodeVer je prilis stary (potreba 18+)" 'Nainstaluj aktualni Node.js LTS z https://nodejs.org.' }
    else { Ok "Node.js $nodeVer ($node)" }
}
if (-not (Have 'npm')) { Fail 'npm nenalezen' 'Preinstaluj Node.js - npm je jeho soucasti.' }

# -- Python 3.11
$pyCmd = $null
if (Have 'py') {
    try { & py -3.11 -c "import sys" 2>$null; if ($LASTEXITCODE -eq 0) { $pyCmd = @('py', '-3.11') } } catch { }
}
if (-not $pyCmd -and (Have 'python')) {
    try {
        $v = (& python -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null)
        if ($v -eq '3.11') { $pyCmd = @('python') }
    } catch { }
}
if (-not $pyCmd) {
    if ($SkipModels) { Warn 'Python 3.11 nenalezen - preskakuji (-SkipModels)' $null }
    else { Fail 'Python 3.11 nenalezen' 'Nainstaluj Python 3.11 z https://www.python.org/downloads/release/python-3119/ a zaskrtni "Add python.exe to PATH".' }
} else { Ok "Python 3.11 ($($pyCmd -join ' '))" }

# -- nastroje Windows
foreach ($t in @('curl.exe', 'tar.exe')) {
    if (Have $t) { Ok "$t k dispozici" }
    else { Fail "$t nenalezen" 'Potreba Windows 10 1803+ (curl a tar jsou soucasti systemu).' }
}

# -- offline balik / sit
if ($hasOffline) {
    $offGB = [math]::Round(((Get-ChildItem $offline -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1GB, 1)
    Ok "Offline balik nalezen ($offGB GB) - internet neni potreba"
    foreach ($part in @('models\whisper-large-v3\model.bin', 'models\diarization', 'wheels', 'node_modules')) {
        if (-not (Test-Path (Join-Path $offline $part))) { Warn "V offline baliku chybi $part - tato cast se zkusi stahnout z internetu" $null }
    }
} else {
    $hosts = @('registry.npmjs.org')
    if (-not $SkipModels) { $hosts += 'huggingface.co' }
    if (-not $SkipModels -and -not $NoLocalLLM) { $hosts += 'github.com' }
    foreach ($h in $hosts) {
        if (NetOk $h) { Ok "Sit: $h dostupny" }
        else { Fail "Sit: $h je nedostupny (firewall/proxy?)" 'Ve firemni siti nastav proxy: setx HTTP_PROXY http://proxy:port a HTTPS_PROXY, nebo pouzij verzi s offline balikem (slozka INSTALL\offline).' }
    }
    if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) { Info "proxy z prostredi: $($env:HTTPS_PROXY)$($env:HTTP_PROXY)" }
}

# -- APPDATA musi byt lokalni (junction na sitovy disk nefunguje)
$extRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
if ($env:APPDATA -like '\\*') {
    Fail "APPDATA je na sitovem disku ($env:APPDATA) - CEP panel tam nejde propojit" 'Nutna lokalni instalace panelu - obrat se na IT (presmerovany profil).'
} else { Ok "APPDATA je lokalni ($env:APPDATA)" }

# -- Premiere Pro
$ppro = @()
foreach ($base in @("$env:ProgramFiles\Adobe", "${env:ProgramFiles(x86)}\Adobe")) {
    if (Test-Path $base) { $ppro += @(Get-ChildItem $base -Directory -Filter 'Adobe Premiere Pro*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) }
}
if ($ppro.Count -gt 0) { Ok "Premiere Pro: $($ppro -join ', ')" }
else { Warn 'Premiere Pro nenalezeno v Program Files' 'Panel se nainstaluje, ale bez Premiere ho nespustis. Pokud mas Premiere jinde, muzes pokracovat.' }

# -- GPU
$gpu = $null
if (Have 'nvidia-smi') {
    try { $gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>$null | Select-Object -First 1) } catch { }
}
if ($gpu) { Ok "GPU: $gpu" }
else { Warn 'NVIDIA GPU nenalezena - prepis pobezi na CPU (vyrazne pomaleji)' 'Instalace nastavi Whisper na CPU rezim automaticky.' }

# -- porty
foreach ($p in @(7880, 7881)) {
    $used = $null
    try { $used = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue } catch { }
    if ($used) { Warn "Port $p je obsazeny jinym programem" 'Bud bezi stara instance (pak OK), nebo port zabral jiny program - pak uprav config.json.' }
    else { Ok "Port $p je volny" }
}

if ($script:problems.Count -gt 0) {
    Write-Host ''
    Write-Host "  KONTROLA NEPROSLA - $($script:problems.Count) problem(u), nic se nemenilo:" -ForegroundColor Red
    $script:problems | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
    Write-Host "  Oprav vyse uvedene a spust instalaci znovu. Log: $logFile" -ForegroundColor Yellow
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}
Write-Host ''
Write-Host "  Kontroly prosly (varovani: $($script:warnings.Count))" -ForegroundColor Green

if ($CheckOnly) {
    Write-Host '  Rezim -CheckOnly: nic se neinstalovalo.' -ForegroundColor Cyan
    try { Stop-Transcript | Out-Null } catch { }
    exit 0
}

# ------------------------------------------------------------------ 2. INSTALACE
Set-Location $root

function Download($url, $out) {
    if (Test-Path $out) { Info "$(Split-Path $out -Leaf) uz je stazeny"; return }
    Write-Host "          stahuji $(Split-Path $out -Leaf) ..."
    & curl.exe -fSL --retry 3 --retry-delay 2 -o "$out.part" $url
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path "$out.part") { Remove-Item "$out.part" -Force }
        throw "Stazeni selhalo ($url). Pri firemni siti zkontroluj proxy (HTTPS_PROXY)."
    }
    Move-Item "$out.part" $out -Force
}

function CopyFromOffline($relPath, $label) {
    # robocopy vraci 0-7 jako uspech (1 = neco zkopirovano), 8+ je skutecna chyba
    $src = Join-Path $offline $relPath
    $dst = Join-Path $root $relPath
    if (-not (Test-Path $src)) { return $false }
    Write-Host "          kopiruji $label z offline baliku ..."
    & robocopy $src $dst /E /NFL /NDL /NJH /NJS /NC /NS /R:2 /W:2 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Kopirovani $label z offline baliku selhalo (robocopy $LASTEXITCODE)." }
    $global:LASTEXITCODE = 0
    return $true
}

Head '2/4 Instalace'

Write-Host '  [1] Node zavislosti'
$nodeDone = $false
if ($hasOffline -and -not (Test-Path (Join-Path $root 'node_modules\@modelcontextprotocol'))) {
    $nodeDone = CopyFromOffline 'node_modules' 'node_modules'
}
if (-not $nodeDone) {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install selhal - zkontroluj sit/proxy (npm config set proxy ...), nebo pouzij offline balik.' }
}

Write-Host '  [2] CEP panel (propojeni do Adobe\CEP\extensions)'
$ext = Join-Path $extRoot 'com.pz.premieremcp'
New-Item -ItemType Directory -Force $extRoot | Out-Null
if (Test-Path $ext) {
    $item = Get-Item $ext -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { cmd /c rmdir "$ext" | Out-Null }
    else { throw "$ext existuje a neni to propojeni (junction) - smaz tu slozku rucne a spust instalaci znovu." }
}
cmd /c mklink /J "$ext" "$root\panel" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Nepodarilo se vytvorit propojeni $ext -> $root\panel." }
foreach ($v in 11..15) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -Type String
}

Write-Host '  [3] Cesty podle teto instalace (mcp.json)'
# mcp.json MUSI ukazovat na server v teto slozce - pri kopirovani projektu jinam byla drive
# uvnitr stara absolutni cesta a panel se pak k nastrojum vubec nepripojil.
$serverPath = (Join-Path $root 'server\index.js') -replace '\\', '/'
$mcpJson = @"
{
  "mcpServers": {
    "premiere": {
      "command": "node",
      "args": ["$serverPath"]
    }
  }
}

"@
# UTF-8 BEZ BOM - Set-Content -Encoding UTF8 ve Windows PowerShellu 5.1 pridava BOM a ten rozbije
# JSON.parse na strane Node (a json.load v Pythonu) -> konfigurace by se vubec nenacetla.
WriteTextNoBom (Join-Path $root 'mcp.json') $mcpJson
Info "mcp.json -> $serverPath"

if (-not $SkipModels) {
    Write-Host '  [4] Python prostredi (.venv)'
    $py = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path $py)) { & $pyCmd[0] $pyCmd[1..($pyCmd.Count - 1)] -m venv .venv }
    if (-not (Test-Path $py)) { throw 'Vytvoreni .venv selhalo.' }
    & $py -m pip install --upgrade pip 2>$null | Out-Null
    $wheels = Join-Path $offline 'wheels'
    if ($hasOffline -and (Test-Path $wheels)) {
        Info 'instaluji Python balicky z offline baliku (bez internetu)'
        & $py -m pip install --no-index --find-links "$wheels" faster-whisper sherpa-onnx numpy opencv-python-headless nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
        if ($LASTEXITCODE -ne 0) { throw 'Instalace Python balicku z offline baliku selhala (chybejici wheel pro tuto verzi Pythonu? Potreba Python 3.11 64-bit).' }
    } else {
        & $py -m pip install faster-whisper sherpa-onnx numpy opencv-python-headless nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
        if ($LASTEXITCODE -ne 0) { throw 'pip install selhal - zkontroluj sit/proxy (pip config set global.proxy ...), nebo pouzij offline balik.' }
    }

    Write-Host '  [5] Whisper large-v3'
    if (Test-Path 'models\whisper-large-v3\model.bin') { Info 'Whisper uz je na miste' }
    elseif ($hasOffline -and (CopyFromOffline 'models\whisper-large-v3' 'Whisper large-v3')) { }
    else {
        & $py -c "from faster_whisper import download_model; download_model('large-v3', output_dir='models/whisper-large-v3')"
        if ($LASTEXITCODE -ne 0) { throw 'Stazeni Whisper modelu selhalo (huggingface.co nedostupny?).' }
    }

    Write-Host '  [6] Diarizace (kdo kdy mluvi)'
    if (Test-Path 'models\diarization\sherpa-onnx-pyannote-segmentation-3-0\model.onnx') { Info 'Diarizace uz je na miste' }
    elseif ($hasOffline -and (CopyFromOffline 'models\diarization' 'modely diarizace')) { }
    else {
        New-Item -ItemType Directory -Force models\diarization | Out-Null
        $sherpa = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
        Download "$sherpa/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" 'models\diarization\seg.tar.bz2'
        & tar.exe -xjf models\diarization\seg.tar.bz2 -C models\diarization
        Remove-Item models\diarization\seg.tar.bz2 -Force
        Download "$sherpa/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" 'models\diarization\3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
    }
} else {
    Warn 'Modely preskoceny (-SkipModels) - prepis zvuku nebude fungovat' 'Pozdeji spust instalaci znovu bez -SkipModels.'
}

if (-not $SkipModels -and -not $NoLocalLLM) {
    Write-Host '  [7] Lokalni LLM (llama.cpp + gemma3 12B + vision model)'
    if (Test-Path 'tools\llama.cpp\llama-server.exe') { Info 'llama.cpp uz je na miste' }
    elseif ($hasOffline -and (CopyFromOffline 'tools' 'llama.cpp')) { }
    else {
        $llamaTag = 'b10984'
        New-Item -ItemType Directory -Force tools\llama.cpp | Out-Null
        $gh = "https://github.com/ggml-org/llama.cpp/releases/download/$llamaTag"
        Download "$gh/llama-$llamaTag-bin-win-cuda-12.4-x64.zip" 'tools\llama.zip'
        Download "$gh/cudart-llama-bin-win-cuda-12.4-x64.zip" 'tools\cudart.zip'
        Expand-Archive tools\llama.zip -DestinationPath tools\llama.cpp -Force
        Expand-Archive tools\cudart.zip -DestinationPath tools\llama.cpp -Force
        Remove-Item tools\llama.zip, tools\cudart.zip -Force
    }
    if (Test-Path 'models\llm\gemma3-12b-Q4_K_M.gguf') { Info 'gemma3 12B uz je na miste' }
    elseif ($hasOffline -and (CopyFromOffline 'models\llm' 'gemma3 12B')) { }
    else {
        New-Item -ItemType Directory -Force models\llm | Out-Null
        Download 'https://huggingface.co/ggml-org/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-Q4_K_M.gguf' 'models\llm\gemma3-12b-Q4_K_M.gguf'
    }
    if (Test-Path 'models\llm-vision\Qwen3VL-4B-Instruct-Q4_K_M.gguf') { Info 'vision model uz je na miste' }
    elseif ($hasOffline -and (CopyFromOffline 'models\llm-vision' 'vision model')) { }
    else {
        New-Item -ItemType Directory -Force models\llm-vision | Out-Null
        $hf = 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main'
        Download "$hf/Qwen3VL-4B-Instruct-Q4_K_M.gguf" 'models\llm-vision\Qwen3VL-4B-Instruct-Q4_K_M.gguf'
        Download "$hf/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf" 'models\llm-vision\mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'
    }
} elseif (-not $SkipModels) {
    Warn 'Lokalni LLM preskocen (-NoLocalLLM)' 'Nastroje analyze_transcript / plan_edit_local / describe_frame nepobezi. Strih pres Claude/GPT funguje normalne.'
}

Write-Host '  [8] Nastaveni podle hardwaru (config.json)'
$cfgPath = Join-Path $root 'config.json'
$cfgRaw = Get-Content $cfgPath -Raw
$cfg = $cfgRaw | ConvertFrom-Json
if (-not $gpu -and $cfg.whisper.device -ne 'cpu') {
    # Zamerne cilena zamena v textu, ne round-trip pres ConvertTo-Json: ten by preformatoval
    # cely soubor a u jednoprvkovych poli (napr. "python") hrozi zmena na skalar -> rozbity config.
    $new = $cfgRaw -replace '("device"\s*:\s*)"cuda"', '$1"cpu"' -replace '("compute"\s*:\s*)"float16"', '$1"int8"'
    WriteTextNoBom $cfgPath $new
    Info 'bez NVIDIA GPU -> Whisper prepnut na CPU (device=cpu, compute=int8)'
} elseif ($gpu) {
    Info "GPU nalezena -> Whisper zustava na CUDA (device=$($cfg.whisper.device))"
}

Write-Host '  [9] Registrace MCP (Claude Code / Claude Desktop / Codex)'
& node (Join-Path $root 'scripts\register.mjs')

# ------------------------------------------------------------------ 3. OVERENI PO INSTALACI
Head '3/4 Overeni instalace'

if (Test-Path (Join-Path $root 'node_modules\@modelcontextprotocol')) { Ok 'Node zavislosti nainstalovany' }
else { Fail 'Chybi node_modules\@modelcontextprotocol' 'Spust znovu: npm install' }

& node --check (Join-Path $root 'server\index.js')
if ($LASTEXITCODE -eq 0) { Ok 'MCP server je syntakticky v poradku' } else { Fail 'server\index.js se nepodarilo nacist' 'Zkopiruj projekt znovu.' }

$extCheck = Join-Path $extRoot 'com.pz.premieremcp\index.html'
if (Test-Path $extCheck) { Ok "Panel propojen ($ext)" } else { Fail 'Propojeni panelu nefunguje' 'Spust instalaci znovu jako spravce.' }

$dbg = (Get-ItemProperty 'HKCU:\Software\Adobe\CSXS.11' -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
if ($dbg -eq '1') { Ok 'CEP PlayerDebugMode nastaven' } else { Fail 'CEP PlayerDebugMode se nepodarilo nastavit' 'Zkontroluj firemni politiku pro zapis do HKCU.' }

$mcpCheck = Get-Content (Join-Path $root 'mcp.json') -Raw | ConvertFrom-Json
$mcpTarget = $mcpCheck.mcpServers.premiere.args[0]
if (Test-Path $mcpTarget) { Ok "mcp.json ukazuje na existujici server" } else { Fail "mcp.json ukazuje na neexistujici cestu ($mcpTarget)" 'Spust instalaci znovu.' }

if (-not $SkipModels) {
    $py = Join-Path $root '.venv\Scripts\python.exe'
    if (Test-Path $py) {
        & $py -c "import faster_whisper, sherpa_onnx, numpy, cv2" 2>$null
        if ($LASTEXITCODE -eq 0) { Ok 'Python balicky (faster-whisper, sherpa-onnx, numpy, opencv) funguji' }
        else { Fail 'Python balicky se nepodarilo naimportovat' 'Spust instalaci znovu, nebo rucne: .venv\Scripts\python.exe -m pip install faster-whisper sherpa-onnx numpy opencv-python-headless' }
    } else { Fail 'Chybi .venv\Scripts\python.exe' 'Spust instalaci znovu.' }

    $w = Join-Path $root 'models\whisper-large-v3\model.bin'
    if ((Test-Path $w) -and ((Get-Item $w).Length -gt 1GB)) { Ok "Whisper model OK ($([math]::Round((Get-Item $w).Length/1GB,1)) GB)" }
    else { Fail 'Whisper model chybi nebo je neuplny' 'Smaz slozku models\whisper-large-v3 a spust instalaci znovu.' }

    $seg = Join-Path $root 'models\diarization\sherpa-onnx-pyannote-segmentation-3-0\model.onnx'
    if (Test-Path $seg) { Ok 'Model diarizace OK' } else { Fail 'Model diarizace chybi' 'Spust instalaci znovu.' }
}

if (-not $SkipModels -and -not $NoLocalLLM) {
    $g = Join-Path $root 'models\llm\gemma3-12b-Q4_K_M.gguf'
    if ((Test-Path $g) -and ((Get-Item $g).Length -gt 5GB)) { Ok 'Lokalni LLM (gemma3 12B) OK' }
    else { Fail 'Lokalni LLM chybi nebo je neuplny' 'Smaz models\llm\gemma3-12b-Q4_K_M.gguf a spust instalaci znovu (nebo pouzij -NoLocalLLM).' }
    if (Test-Path (Join-Path $root 'tools\llama.cpp\llama-server.exe')) { Ok 'llama.cpp OK' } else { Fail 'llama.cpp chybi' 'Spust instalaci znovu.' }
}

# ------------------------------------------------------------------ 4. VYSLEDEK
Head '4/4 Vysledek'
if ($script:problems.Count -gt 0) {
    Write-Host "  INSTALACE NEDOKONCENA - $($script:problems.Count) problem(u):" -ForegroundColor Red
    $script:problems | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
    Write-Host "  Posli log pro diagnostiku: $logFile" -ForegroundColor Yellow
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}
Write-Host '  HOTOVO - vse overeno.' -ForegroundColor Green
if ($script:warnings.Count -gt 0) {
    Write-Host "  Varovani ($($script:warnings.Count)) - instalace probehla, ale precti si je:" -ForegroundColor Yellow
    $script:warnings | ForEach-Object { Write-Host "   - $_" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '  Dalsi krok: restartuj Premiere Pro a otevri Okno > Rozsireni > MY Premiere MCP.' -ForegroundColor Green
Write-Host "  Log z instalace: $logFile"
try { Stop-Transcript | Out-Null } catch { }
