@echo off
rem ============================================================
rem  MY Premiere MCP - instalace (staci poklepat)
rem
rem  Pokud je vedle tohoto souboru slozka "offline", nainstaluje
rem  se vse z ni a neni potreba zadny internet.
rem
rem  Volitelne prepinace (pro pokrocile, spoustej z prikazove radky):
rem     instalace.bat -CheckOnly     jen kontrola prostredi, nic nemeni
rem     instalace.bat -NoLocalLLM    bez lokalniho LLM (usetri ~10 GB)
rem     instalace.bat -SkipModels    jen panel a MCP, bez modelu
rem ============================================================
title MY Premiere MCP - instalace
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%errorlevel%
echo.
if %RC% NEQ 0 (
    echo [CHYBA] Instalace neprobehla uplne. Podrobnosti najdes v install-log.txt
    echo         ve stejne slozce - ten staci poslat k diagnostice.
) else (
    echo [OK] Instalace probehla v poradku.
    echo      Restartuj Premiere Pro a otevri Okno - Rozsireni - MY Premiere MCP.
)
echo.
pause
exit /b %RC%
