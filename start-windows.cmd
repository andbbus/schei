@echo off
rem Double-click / shortcut entry point on Windows: start backend + frontend.
cd /d "%~dp0"
node scripts\start-all.mjs
pause
