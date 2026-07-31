@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

 echo === Friberg Ultimate update / test / build ===
 echo Repository: %CD%
 echo.

 echo [1/7] Current branch and status
 git branch --show-current
 git status --short
 if errorlevel 1 goto :fail

 echo.
 echo [2/7] Pull current branch (fast-forward only)
 git pull --ff-only
 if errorlevel 1 (
   echo Pull was not completed. Resolve local changes or branch tracking first.
   goto :fail
 )

 echo.
 echo [3/7] Strict solver regression
 node tests\run-regression.js
 if errorlevel 1 goto :fail

 echo.
 echo [4/7] Automation core contract
 node tests\run-automation-core.js
 if errorlevel 1 goto :fail

 echo.
 echo [5/7] Ultimate architecture and all-answer contract
 node tests\run-ultimate-contract.js
 if errorlevel 1 goto :fail

 echo.
 echo [6/7] Repository security audit
 node tools\repository-security-audit.js
 if errorlevel 1 goto :fail

 echo.
 echo [7/7] Build and validate loadable extension
 powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\package-edge-extension.ps1
 if errorlevel 1 goto :fail
 node tests\run-delivery-contract.js
 if errorlevel 1 goto :fail

 echo.
 echo PASS
 echo Load this directory in Edge:
 echo %CD%\dist\friberg-assistant-extension
 echo.
 pause
 exit /b 0

:fail
 echo.
 echo FAILED. Read the first error above; no success is being claimed.
 pause
 exit /b 1
