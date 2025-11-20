# syntax=docker/dockerfile:1.5

FROM python:3.11-slim AS base

# Configure Python
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Set workdir
WORKDIR /app

# System dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Ensure sessions directory exists
RUN mkdir -p /app/sessions

EXPOSE 8080

CMD ["python", "main.py"]

