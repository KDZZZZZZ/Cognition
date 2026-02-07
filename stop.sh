#!/bin/bash

echo "===================================="
echo "  Stopping Knowledge IDE Servers"
echo "===================================="
echo ""

# Colors
GREEN='\033[0;32m'
NC='\033[0m'

# Kill processes on port 5173 (Frontend)
if lsof -Pi :5173 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}[INFO]${NC} Stopping frontend server..."
    kill -9 $(lsof -t -i:5173) 2>/dev/null || true
fi

# Kill processes on port 8000 (Backend)
if lsof -Pi :8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}[INFO]${NC} Stopping backend server..."
    kill -9 $(lsof -t -i:8000) 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}[INFO]${NC} All servers stopped successfully"
