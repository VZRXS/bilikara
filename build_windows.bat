@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PYTHON_CMD="
where py >nul 2>nul && set "PYTHON_CMD=py"
if not defined PYTHON_CMD where python >nul 2>nul && set "PYTHON_CMD=python"
if not defined PYTHON_CMD where python3 >nul 2>nul && set "PYTHON_CMD=python3"

if not defined PYTHON_CMD (
  echo 未找到可用的 Python 命令。
  echo 请先安装 Python 3，并勾选 "Add python.exe to PATH"，或者安装 Python Launcher。
  pause
  exit /b 1
)

echo 使用 %PYTHON_CMD% 进行打包...
call %PYTHON_CMD% -m pip install --upgrade pip
if errorlevel 1 goto :error

call %PYTHON_CMD% -m pip install -r requirements-packaging.txt
if errorlevel 1 goto :error

call %PYTHON_CMD% build_bundle.py
if errorlevel 1 goto :error

echo.
echo 打包完成，产物在 dist 目录。
pause
exit /b 0

:error
echo.
echo 打包失败，请检查上面的报错信息。
pause
exit /b 1
