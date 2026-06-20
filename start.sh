#!/bin/bash

# Terminate background processes when script is exited
trap "kill 0" EXIT

echo "============================================="
echo "  Starting Resident Shift Allocation System  "
echo "============================================="

# 1. Start backend
echo "🚀 Starting FastAPI backend on http://localhost:8000..."
cd backend
./venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload &
BACKEND_PID=$!
cd ..

# Wait a second for backend to bind
sleep 1.5

# 2. Start frontend
echo "💻 Starting Vite React frontend..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo "---------------------------------------------"
echo "App is running."
echo "FastAPI Docs: http://localhost:8000/docs"
echo "Press Ctrl+C to terminate both servers."
echo "============================================="

# Wait for both background jobs
wait
