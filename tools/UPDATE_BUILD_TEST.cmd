@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

 echo === Friberg Race Lite update / test / build ===
 echo Repository: %CD%
 echo.

 echo [1/6] Current branch and status
 git branch --show-current
 git status --short
 if errorlevel 1 goto :fail

 echo.
 echo [2/6] Pull current branch (fast-forward only)
 git pull --ff-only
 if errorlevel 1 (
   echo Pull was not completed. Resolve local changes or branch tracking first.
   goto :fail
 )

 echo.
 echo [3/6] Strict solver regression
 node tests\run-regression.js
 if errorlevel 1 goto :fail

 echo.
 echo [4/6] Pure race contract and all-646 simulation
 node tests\run-race-lite-contract.js
 if errorlevel 1 goto :fail

 echo.
 echo [5/6] Repository security audit
 node tools\repository-security-audit.js
 if errorlevel 1 goto :fail

 echo.
 echo [6/6] Build minimal seven-file race extension
 powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\package-edge-extension.ps1
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
