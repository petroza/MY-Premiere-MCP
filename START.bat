@echo off
setlocal
cd /d "%~dp0"

echo MY Premiere MCP - startuji...
echo.

echo [1/2] Zahrivam lokalni Worker (Whisper, diarizace, LLM)...
start "MYpremiereMCP Worker" /min ".venv\Scripts\python.exe" "worker\server.py"

echo [2/2] Spoustim Adobe Premiere Pro...
start "" "C:\Program Files\Adobe\Adobe Premiere Pro 2026\Adobe Premiere Pro.exe"

echo.
echo Az se Premiere otevre: Okno ^> Rozsireni ^> MY Premiere MCP
echo (Worker bezi na pozadi, prvni pozadavek uz na nej nebude cekat.)
echo.
pause
