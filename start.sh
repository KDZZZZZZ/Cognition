#!/bin/bash

set -e

echo "===================================="
echo "  Knowledge IDE - Startup Script"
echo "===================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}[ERROR]${NC} Node.js not found. Please install Node.js first."
    exit 1
fi

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}[ERROR]${NC} Python3 not found. Please install Python3 first."
    exit 1
fi

# Install frontend dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}[INFO]${NC} Installing frontend dependencies..."
    npm install
fi

# Install backend dependencies if needed
if [ ! -d "backend/venv" ]; then
    echo -e "${YELLOW}[INFO]${NC} Creating Python virtual environment..."
    cd backend
    python3 -m venv venv
    source venv/bin/activate
    echo -e "${YELLOW}[INFO]${NC} Installing backend dependencies..."
    pip install -r requirements.txt
    cd ..
else
    cd backend
    source venv/bin/activate
    cd ..
fi

# Function to cleanup background processes on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}[INFO]${NC} Shutting down servers..."
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start backend server
echo -e "${GREEN}[INFO]${NC} Starting backend server on http://localhost:8000..."
cd backend
source venv/bin/activate
python main.py &
BACKEND_PID=$!
cd ..

# Wait for backend to be ready
sleep 3

# Start frontend dev server
echo -e "${GREEN}[INFO]${NC} Starting frontend server on http://localhost:5173..."
echo ""
echo "===================================="
echo "  Servers Started Successfully!"
echo "  Frontend: http://localhost:5173"
echo "  Backend:  http://localhost:8000"
echo "  API Docs: http://localhost:8000/docs"
echo "===================================="
echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

npm run dev &
FRONTEND_PID=$!

# Wait for both processes
wait
