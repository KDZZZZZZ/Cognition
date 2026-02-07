@echo off
chcp 65001 >nul
echo ====================================
echo   Stopping Knowledge IDE Servers
echo ====================================
echo.

:: Kill processes on port 5173 (Frontend)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173') do (
    echo [INFO] Stopping frontend server (PID: %%a)
    taskkill /F /PID %%a >nul 2>nul
)

:: Kill processes on port 8000 (Backend)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000') do (
    echo [INFO] Stopping backend server (PID: %%a)
    taskkill /F /PID %%a >nul 2>nul
)

:: Kill any remaining Node.js and Python processes related to the project
taskkill /FI "WINDOWTITLE eq Knowledge IDE Backend" /F >nul 2>nul

echo.
echo [INFO] All servers stopped successfully
pause
