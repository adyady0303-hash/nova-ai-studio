@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 sau mai nou nu este instalat. Instaleaza Node.js si incearca din nou.
  pause
  exit /b 1
)

call :CheckNova
if errorlevel 2 goto PORT_IN_USE
if not errorlevel 1 (
  echo Nova AI Studio ruleaza deja pe portul 4173. Deschid instanta existenta.
  start "" "http://127.0.0.1:4173"
  exit /b 0
)

start "Nova AI Studio - server" cmd /k "cd /d ""%~dp0"" && node server.js"
timeout /t 2 /nobreak >nul
call :CheckNova
if errorlevel 2 goto PORT_IN_USE
if errorlevel 1 goto START_FAILED
start "" "http://127.0.0.1:4173"
exit /b 0

:PORT_IN_USE
echo Portul 4173 este ocupat de alt serviciu. Nova nu a pornit.
echo Inchide serviciul care foloseste portul sau seteaza PORT=4174 in comanda de pornire.
pause
exit /b 1

:START_FAILED
echo Nova nu a raspuns pe portul 4173. Verifica fereastra serverului pentru detalii.
pause
exit /b 1

:CheckNova
node -e "const h=require('http');const r=h.get('http://127.0.0.1:4173/',x=>{let b='';x.setEncoding('utf8');x.on('data',c=>b+=c);x.on('end',()=>process.exit(x.statusCode===200&&b.includes('Nova AI Studio')&&b.includes('LOCAL')?0:2));});r.on('error',e=>process.exit(e.code==='ECONNREFUSED'||e.code==='ECONNRESET'?1:2));r.setTimeout(1200,()=>{r.destroy();process.exit(2)});"
exit /b %errorlevel%

