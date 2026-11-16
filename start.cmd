@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed in this folder.
  echo Run:  npm install
  pause
  exit /b 1
)

"node_modules\electron\dist\electron.exe" .
if errorlevel 1 pause
