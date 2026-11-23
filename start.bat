@echo off
cd /d "%~dp0"
echo === Kindle Signage Server ===

if not exist "node_modules" (
  echo Installing packages...
  call npm install
)

echo Starting server...
node server.js
pause
