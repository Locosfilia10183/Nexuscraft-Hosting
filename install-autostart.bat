@echo off
rem Startet NEXUSCRAFT automatisch bei jeder Windows-Anmeldung
schtasks /create /tn "NEXUSCRAFT" /tr "\"%~dp0start-all.bat\"" /sc onlogon /f
pause
