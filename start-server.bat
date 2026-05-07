@echo off
cd /d "%~dp0"
set NODE_ENV=development
start "" "http://localhost:5000"
npx tsx server/index.ts
pause 