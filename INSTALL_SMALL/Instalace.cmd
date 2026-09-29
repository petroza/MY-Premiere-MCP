@echo off
rem ============================================================
rem  MY Premiere MCP - online instalace (staci poklepat)
rem
rem  Vse se stahne z internetu: kod z GitHubu, Node.js a Python
rem  (kdyz chybi), balicky a modely. Potreba ~15 GB mista
rem  (+23 GB s Hermesem) a pripojeni k internetu.
rem
rem  Volitelne prepinace (z prikazove radky):
rem     Instalace.cmd -Target D:\MYpremiereMCP   jina slozka
rem     Instalace.cmd -Hermes                    i Hermes (~23 GB)
rem     Instalace.cmd -NoLocalLLM                bez lokalniho LLM
rem     Instalace.cmd -SkipModels                jen panel a MCP
rem ============================================================
title MY Premiere MCP - online instalace
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-online.ps1" %*
set RC=%errorlevel%
echo.
if %RC% NEQ 0 (
    echo [CHYBA] Instalace neprobehla uplne - viz vypis vyse
    echo         a INSTALL\install-log.txt ve slozce aplikace.
) else (
    echo [OK] Hotovo. Restartuj Premiere Pro a otevri
    echo      Okno - Rozsireni - MY Premiere MCP.
)
echo.
pause
exit /b %RC%
