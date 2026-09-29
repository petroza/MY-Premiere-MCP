# Natvrdo ukončí lokální Worker (celý strom procesů – venv python spouští podřízený interpret)
# a NÁŠ llama-server z tools\llama.cpp. Cizí llama-server (např. uživatelův Hermes na O:\Hermes)
# se nesmí dotknout – proto se porovnává celá cesta, ne jen název.
$root = Split-Path -Parent $PSScriptRoot
$ourLlama = Join-Path $root 'tools\llama.cpp\llama-server.exe'
$procs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'worker[\\/]server\.py' -or
    ($_.Name -eq 'llama-server.exe' -and $_.ExecutablePath -eq $ourLlama)
}
if (-not $procs) { 'Worker neběží'; return }
$procs | Select-Object ProcessId, Name, @{ n = 'Prikaz'; e = { $_.CommandLine.Substring(0, [Math]::Min(70, $_.CommandLine.Length)) } } |
    Format-Table -AutoSize | Out-String -Width 200
foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null }
Start-Sleep 2
$left = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -match 'worker[\\/]server\.py' -or
        ($_.Name -eq 'llama-server.exe' -and $_.ExecutablePath -eq $ourLlama)
    }).Count
"Ukonceno, zbyva procesu: $left"
