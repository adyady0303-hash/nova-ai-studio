@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 sau mai nou nu este instalat. Instaleaza Node.js si incearca din nou.
  pause
  exit /b 1
)

call :CheckNova 4173
if errorlevel 3 goto TRY_ALT_PORT
if errorlevel 2 goto TRY_ALT_PORT
if errorlevel 1 goto START_PRIMARY
goto OPEN_PRIMARY

:START_PRIMARY
start "Nova AI Studio - server" cmd /k "cd /d ""%~dp0"" && node server.js"
timeout /t 2 /nobreak >nul
call :CheckNova 4173
if errorlevel 3 goto TRY_ALT_PORT
if errorlevel 2 goto TRY_ALT_PORT
if errorlevel 1 goto START_FAILED
goto OPEN_PRIMARY

:OPEN_PRIMARY
echo Nova AI Studio v0.4.0 ruleaza pe portul 4173.
start "" "http://127.0.0.1:4173"
exit /b 0

:TRY_ALT_PORT
call :CheckNova 4174
if errorlevel 3 goto PORTS_IN_USE
if errorlevel 2 goto PORTS_IN_USE
if errorlevel 1 goto START_ALT
echo Nova AI Studio v0.4.0 ruleaza deja pe portul 4174. Deschid instanta existenta.
start "" "http://127.0.0.1:4174"
exit /b 0

:START_ALT
start "Nova AI Studio - server (4174)" cmd /k "cd /d ""%~dp0"" && set PORT=4174 && node server.js"
timeout /t 2 /nobreak >nul
call :CheckNova 4174
if errorlevel 1 goto ALT_START_FAILED
if errorlevel 2 goto ALT_START_FAILED
if errorlevel 3 goto ALT_START_FAILED
echo Nova AI Studio v0.4.0 ruleaza pe portul 4174.
start "" "http://127.0.0.1:4174"
exit /b 0

:PORTS_IN_USE
echo Porturile 4173 si 4174 sunt ocupate. Inchide o instanta veche Nova sau elibereaza un port.
pause
exit /b 1

:START_FAILED
echo Nova nu a raspuns pe portul 4173. Verifica fereastra serverului pentru detalii.
pause
exit /b 1

:ALT_START_FAILED
echo Nova nu a raspuns pe portul 4174. Verifica fereastra serverului pentru detalii.
pause
exit /b 1

:CheckNova
node -e "const h=require('http'),p=%1;const r=h.get('http://127.0.0.1:'+p+'/',x=>{let b='';x.setEncoding('utf8');x.on('data',c=>b+=c);x.on('end',()=>{if(x.statusCode!==200)process.exit(3);if(b.includes('NOVA_VERSION_0.4.0'))process.exit(0);if(b.includes('Nova AI Studio')&&b.includes('LOCAL'))process.exit(2);process.exit(3)});});r.on('error',e=>process.exit(e.code==='ECONNREFUSED'||e.code==='ECONNRESET'?1:3));r.setTimeout(1200,()=>{r.destroy();process.exit(3)});"
exit /b %errorlevel%

