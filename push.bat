@echo off
setlocal
cd /d "%~dp0"
python scripts\push_service.py %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo Push failed with exit code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)
endlocal
