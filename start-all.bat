@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Node.js 20+ fehlt. Bitte installieren. & pause & exit /b 1)
if not exist ".env" copy ".env.example" ".env" >nul
if not exist "node_modules\dotenv\package.json" goto install
if not exist "node_modules\yauzl\package.json" goto install
if not exist "node_modules\nodemailer\package.json" goto install
goto launch
:install
echo Installiere benoetigte Node-Pakete ...
call npm install
if errorlevel 1 (echo npm install fehlgeschlagen. & pause & exit /b 1)
:launch
if not exist "agent\agent-config.json" echo Agent wird erstmals gestartet und erstellt ein geheimes Token.
start "NEXUSCRAFT Agent" /min cmd /c "cd /d ""%~dp0agent"" && node agent.js"
timeout /t 3 /nobreak >nul
start "NEXUSCRAFT Web" /min cmd /c "cd /d ""%~dp0"" && node server.js"
echo NEXUSCRAFT gestartet: http://localhost:3000
timeout /t 4 >nul
endlocal
