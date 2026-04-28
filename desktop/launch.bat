@echo off
:: VibeVoice Desktop — Windows launcher
:: Activates the conda environment and launches Electron.
:: Usage: launch.bat

setlocal

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

:: ---- conda activation (adjust env name if needed) ----
where conda >nul 2>&1
if %errorlevel% equ 0 (
    call conda activate tushanproject 2>nul
) else (
    echo WARNING: conda not found. Using system Python.
)

:: ---- install Python server deps if first run ----
pip show fastapi >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Python server dependencies...
    pip install -r "%ROOT%\server\requirements.txt"
)

:: ---- install Node.js deps if first run ----
if not exist "%ROOT%\node_modules" (
    echo Installing Node.js dependencies...
    cd /d "%ROOT%"
    npm install
)

:: ---- launch Electron ----
cd /d "%ROOT%"
npx electron .

endlocal
