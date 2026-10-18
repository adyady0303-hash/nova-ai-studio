@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 sau mai nou nu este instalat. Instaleaza Node.js si incearca din nou.
  pause
  exit /b 1
)
start "Nova AI Studio - server" cmd /k "cd /d ""%~dp0"" && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
endlocal
