@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

set "OUT=evidence\latest"
set "ZIP=evidence\friberg-evidence.zip"

if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"

 git rev-parse HEAD > "%OUT%\git-commit.txt" 2>&1
 git branch --show-current > "%OUT%\git-branch.txt" 2>&1
 git status --short > "%OUT%\git-status.txt" 2>&1
 git log --oneline -5 > "%OUT%\git-log.txt" 2>&1

 copy /y "extension\manifest.json" "%OUT%\manifest.json" >nul 2>&1

 node tests\run-regression.js > "%OUT%\regression.txt" 2>&1
 node tests\run-extension-contract.js > "%OUT%\extension-contract.txt" 2>&1
 node tests\run-automation-core.js > "%OUT%\automation-core.txt" 2>&1
 node tools\repository-security-audit.js > "%OUT%\security-audit.json" 2>&1

 if exist "diagnostics\latest.json" copy /y "diagnostics\latest.json" "%OUT%\diagnostic.json" >nul

 if exist "%ZIP%" del /q "%ZIP%"
 powershell -NoProfile -Command "Compress-Archive -Path 'evidence\latest\*' -DestinationPath 'evidence\friberg-evidence.zip' -Force"
 if errorlevel 1 goto :fail

 echo Evidence created:
 echo %CD%\%ZIP%
 pause
 exit /b 0

:fail
 echo Failed to create evidence package.
 pause
 exit /b 1
