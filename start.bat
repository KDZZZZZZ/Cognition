@echo off
chcp 65001 >nul
echo ====================================
echo   Knowledge IDE - Startup Script
echo ====================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

:: Check if Python is installed
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python not found. Please install Python first.
    pause
    exit /b 1
)

:: Install frontend dependencies if needed
if not exist "node_modules" (
    echo [INFO] Installing frontend dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install frontend dependencies
        pause
        exit /b 1
    )
)

:: Install backend dependencies if needed
if not exist "backend\venv" (
    echo [INFO] Creating Python virtual environment...
    cd backend
    python -m venv venv
    call venv\Scripts\activate.bat
    echo [INFO] Installing backend dependencies...
    pip install -r requirements.txt
    cd ..
) else (
    cd backend
    call venv\Scripts\activate.bat
    cd ..
)

:: Start backend server in background
echo [INFO] Starting backend server on http://localhost:8000...
start "Knowledge IDE Backend" cmd /c "cd backend && venv\Scripts\activate.bat && python main.py"

:: Wait for backend to be ready
timeout /t 3 /nobreak >nul

:: Start frontend dev server
echo [INFO] Starting frontend server on http://localhost:5173...
echo.
echo ====================================
echo   Servers Started Successfully!
echo   Frontend: http://localhost:5173
echo   Backend:  http://localhost:8000
echo   API Docs: http://localhost:8000/docs
echo ====================================
echo.
echo Press Ctrl+C to stop all servers
echo.

call npm run dev
