@echo off
title Reset Data - Candidate Tracker
echo ================================================
echo   Eye to Eye Careers - Candidate Tracker
echo   Data Reset Utility
echo ================================================
echo.
echo WARNING: This will delete ALL stored data including:
echo   - Candidates
echo   - Submissions
echo   - Alerts
echo   - Monitoring history
echo.

set /p confirm="Are you sure you want to reset all data? (yes/no): "

if /i "%confirm%"=="yes" (
    echo.
    if exist "tracker-data.json" (
        del tracker-data.json
        echo Data file deleted successfully.
    ) else (
        echo No data file found. Nothing to reset.
    )
    echo.
    echo Data has been reset. Start the application to create a fresh database.
) else (
    echo.
    echo Operation cancelled. No data was deleted.
)

echo.
pause
