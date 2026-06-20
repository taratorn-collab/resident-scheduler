# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
# Build the production React app with VITE_API_BASE="" so fetches use relative URLs
ENV VITE_API_BASE=""
RUN npm run build

# Stage 2: Create the final production image
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy backend requirements and install them
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source files
COPY backend/ ./

# Copy built frontend assets from Stage 1 into /app/dist
COPY --from=frontend-builder /app/frontend/dist /app/dist

# Set env variables
ENV STATIC_DIR=/app/dist
ENV PORT=8000

EXPOSE 8000

# Start FastAPI server
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
