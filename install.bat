@echo off
title Installing Dependencies - Candidate Tracker
echo ================================================
echo   Eye to Eye Careers - Candidate Tracker
echo   Dependency Installation
echo ================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please download and install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Node.js version:
node -v
echo.

echo npm version:
npm -v
echo.

echo Installing dependencies...
echo.
npm install

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ================================================
    echo   Installation completed successfully!
    echo   Run 'start.bat' to launch the application.
    echo ================================================
) else (
    echo.
    echo ERROR: Installation failed. Please check the error messages above.
)

echo.
pause
