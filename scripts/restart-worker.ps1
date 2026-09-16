# Natvrdo ukončí lokální Worker (celý strom procesů – venv python spouští podřízený interpret) i llama-server.
# Další volání MCP nástroje Worker spustí znovu s aktuálním kódem.
$pattern = 'worker[\\/]server\.py|llama-server'
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern }
if (-not $procs) { 'Worker neběží'; return }
$procs | Select-Object ProcessId, CreationDate, @{ n = 'Prikaz'; e = { $_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length)) } } | Format-Table -AutoSize | Out-String -Width 200
foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null }
Start-Sleep 2
$left = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern }).Count
"Ukonceno, zbyva procesu: $left"
