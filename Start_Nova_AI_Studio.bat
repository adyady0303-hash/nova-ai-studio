@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 sau mai nou nu este instalat. Instaleaza Node.js si incearca din nou.
  pause
  exit /b 1
)

set "NOVA_PORT=4173"
:SELECT_PORT
call :CheckNova %NOVA_PORT%
if errorlevel 3 goto NEXT_PORT
if errorlevel 2 goto NEXT_PORT
if errorlevel 1 goto START_SERVER
goto OPEN_SERVER

:START_SERVER
start "Nova AI Studio - server" cmd /k "cd /d ""%~dp0"" && set PORT=%NOVA_PORT% && node server.js"
timeout /t 2 /nobreak >nul
call :CheckNova %NOVA_PORT%
if errorlevel 3 goto NEXT_PORT
if errorlevel 2 goto NEXT_PORT
if errorlevel 1 goto START_FAILED
goto OPEN_SERVER

:NEXT_PORT
set /a NOVA_PORT+=1
if %NOVA_PORT% GTR 4190 goto PORTS_BUSY
goto SELECT_PORT

:OPEN_SERVER
echo Nova AI Studio v0.5.0 ruleaza pe portul %NOVA_PORT%.
start "" "http://127.0.0.1:%NOVA_PORT%"
exit /b 0

:PORTS_BUSY
echo Porturile 4173-4190 sunt ocupate. Inchide un serviciu si incearca din nou.
pause
exit /b 1

:START_FAILED
echo Nova nu a raspuns pe portul %NOVA_PORT%. Verifica fereastra serverului pentru detalii.
pause
exit /b 1

:CheckNova
node -e "const h=require('http'),p=%1;const r=h.get('http://127.0.0.1:'+p+'/',x=>{let b='';x.setEncoding('utf8');x.on('data',c=>b+=c);x.on('end',()=>{if(x.statusCode!==200)process.exit(3);if(b.includes('NOVA_VERSION_0.5.0'))process.exit(0);if(b.includes('Nova AI Studio')&&b.includes('LOCAL'))process.exit(2);process.exit(3)});});r.on('error',e=>process.exit(e.code==='ECONNREFUSED'||e.code==='ECONNRESET'?1:3));r.setTimeout(1200,()=>{r.destroy();process.exit(3)});"
exit /b %errorlevel%

