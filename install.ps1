# MYpremiereMCP - instalace (powershell -ExecutionPolicy Bypass -File O:\MYpremiereMCP\install.ps1)
# Vse potrebne (Python prostredi, modely, llama.cpp) se uklada do slozky aplikace. Ollama neni potreba.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
function Step($t) { Write-Host $t -ForegroundColor Cyan }
function Download($url, $out) {
    if (Test-Path $out) { return }
    Write-Host "   stahuji $(Split-Path $out -Leaf)"
    curl.exe -fSL --retry 3 -o "$out.part" $url
    if ($LASTEXITCODE -ne 0) { throw "Stazeni selhalo: $url" }
    Move-Item "$out.part" $out -Force
}

Step '1/7 Node zavislosti'
npm install --no-fund --no-audit

Step '2/7 CEP panel (junction do Adobe\CEP\extensions)'
$extRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$ext = Join-Path $extRoot 'com.pz.premieremcp'
New-Item -ItemType Directory -Force $extRoot | Out-Null
if (Test-Path $ext) {
    $item = Get-Item $ext -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { cmd /c rmdir "$ext" | Out-Null }
    else { throw "$ext existuje a neni to junction - odstran ho rucne." }
}
cmd /c mklink /J "$ext" "$root\panel" | Out-Null
foreach ($v in 11..15) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    if ((Get-ItemProperty $key -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode -ne '1') {
        Set-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -Type String
    }
}

Step '3/7 Python prostredi aplikace (.venv)'
$py = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { py -3.11 -m venv .venv }
& $py -m pip install --upgrade pip | Out-Null
& $py -m pip install faster-whisper sherpa-onnx numpy opencv-python-headless nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"

Step '4/7 Whisper large-v3 (models\whisper-large-v3)'
if (-not (Test-Path 'models\whisper-large-v3\model.bin')) {
    & $py -c "from faster_whisper import download_model; download_model('large-v3', output_dir='models/whisper-large-v3')"
}

Step '5/7 Diarizace (models\diarization)'
New-Item -ItemType Directory -Force models\diarization | Out-Null
$sherpa = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
if (-not (Test-Path 'models\diarization\sherpa-onnx-pyannote-segmentation-3-0\model.onnx')) {
    Download "$sherpa/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" 'models\diarization\seg.tar.bz2'
    tar -xjf models\diarization\seg.tar.bz2 -C models\diarization
    Remove-Item models\diarization\seg.tar.bz2
}
Download "$sherpa/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" 'models\diarization\3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'

Step '6/7 Lokalni LLM (llama.cpp + gemma3 12B)'
$llamaTag = 'b10984'
if (-not (Test-Path 'tools\llama.cpp\llama-server.exe')) {
    New-Item -ItemType Directory -Force tools\llama.cpp | Out-Null
    $gh = "https://github.com/ggml-org/llama.cpp/releases/download/$llamaTag"
    Download "$gh/llama-$llamaTag-bin-win-cuda-12.4-x64.zip" 'tools\llama.zip'
    Download "$gh/cudart-llama-bin-win-cuda-12.4-x64.zip" 'tools\cudart.zip'
    Expand-Archive tools\llama.zip -DestinationPath tools\llama.cpp -Force
    Expand-Archive tools\cudart.zip -DestinationPath tools\llama.cpp -Force
    Remove-Item tools\llama.zip, tools\cudart.zip
}
New-Item -ItemType Directory -Force models\llm | Out-Null
$gguf = 'models\llm\gemma3-12b-Q4_K_M.gguf'
if (-not (Test-Path $gguf)) {
    $local = 'O:\PZ_VIDEO_TAG\models\gemma3-12b-Q4_K_M.gguf'
    if ((Test-Path $local) -and ((Get-Item $local).PSDrive.Name -eq (Get-Item $root).PSDrive.Name)) {
        New-Item -ItemType HardLink -Path $gguf -Target $local | Out-Null
    } else {
        Download 'https://huggingface.co/ggml-org/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-Q4_K_M.gguf' $gguf
    }
}

Step '6b/7 Lokalni vision LLM (obrazova analyza - Qwen3-VL 4B)'
New-Item -ItemType Directory -Force models\llm-vision | Out-Null
$hf = 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main'
Download "$hf/Qwen3VL-4B-Instruct-Q4_K_M.gguf" 'models\llm-vision\Qwen3VL-4B-Instruct-Q4_K_M.gguf'
Download "$hf/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf" 'models\llm-vision\mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'

Step '7/7 Registrace MCP (Claude Code, Claude Desktop, Codex)'
node (Join-Path $root 'scripts\register.mjs')

Write-Host ''
Write-Host 'Hotovo. Restartuj Premiere Pro a otevri Okno > Rozsireni > MY Premiere MCP.' -ForegroundColor Green
