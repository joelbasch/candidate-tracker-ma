@echo off
title Eye to Eye Careers - Candidate Tracker
echo ================================================
echo   Eye to Eye Careers - Candidate Tracker
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

:: Check Node.js version
for /f "tokens=1,2,3 delims=." %%a in ('node -v') do (
    set NODE_MAJOR=%%a
)
set NODE_MAJOR=%NODE_MAJOR:v=%

:: Check if node_modules exists
if not exist "node_modules\" (
    echo Installing dependencies...
    echo.
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo ERROR: Failed to install dependencies.
        pause
        exit /b 1
    )
    echo.
)

echo Starting server...
echo.
echo The application will be available at: http://localhost:3001
echo Press Ctrl+C to stop the server.
echo.

:: Start the server
npm start
