@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js and run this file again.
  goto failed
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Check your Node.js installation.
  goto failed
)
call npm ci --no-audit --no-fund
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
echo Build complete: dist\index.html
if /i not "%~1"=="--no-pause" pause
exit /b 0

:failed
echo.
echo Build failed. See the error above. No new build was produced.
if /i not "%~1"=="--no-pause" pause
exit /b 1
