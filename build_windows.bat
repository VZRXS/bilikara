@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PYTHON_CMD="
where py >nul 2>nul && set "PYTHON_CMD=py"
if not defined PYTHON_CMD where python >nul 2>nul && set "PYTHON_CMD=python"
if not defined PYTHON_CMD where python3 >nul 2>nul && set "PYTHON_CMD=python3"

if not defined PYTHON_CMD (
  echo Python was not found.
  echo Please install Python 3 and enable "Add python.exe to PATH", or install Python Launcher.
  echo.
  pause
  exit /b 1
)

echo Using %PYTHON_CMD% to install packaging dependencies...
call %PYTHON_CMD% -m pip install --upgrade pip
if errorlevel 1 goto :error

call %PYTHON_CMD% -m pip install -r requirements-packaging.txt
if errorlevel 1 goto :error

echo.
echo Building Bilikara...
call %PYTHON_CMD% build_bundle.py
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
