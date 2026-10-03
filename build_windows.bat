@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo Installing the locked desktop shell tooling...
call npm ci
if errorlevel 1 goto :error

echo.
echo Building Bilikara...
call npm run build
if errorlevel 1 goto :error

echo.
echo Build complete. Output is in the dist directory.
pause
exit /b 0

:error
echo.
echo Build failed. Check the error messages above.
pause
exit /b 1
