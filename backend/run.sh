#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${PROJECT_ROOT}/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"
VENV_DIR="${PROJECT_ROOT}/.venv"
ENV_FILE="${PROJECT_ROOT}/.env"
export SESSION_DIR="${PROJECT_ROOT}/sessions"

# 1) Ensure required backend env exists
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[run.sh] Missing .env in ${PROJECT_ROOT}. Create it with API_ID, API_HASH, LOGIN and rerun."
  exit 1
fi

# 2) Build frontend if needed (first run or sources changed), skip if missing
if [[ ! -d "${FRONTEND_DIR}" ]]; then
  echo "[run.sh] No frontend directory. Skipping frontend build."
else
  NEED_BUILD=0
  if [[ ! -f "${FRONTEND_DIR}/dist/index.html" ]]; then
    NEED_BUILD=1
  elif find "${FRONTEND_DIR}/src" -type f -newer "${FRONTEND_DIR}/dist/index.html" | grep -q .; then
    NEED_BUILD=1
  fi

  if [[ "${NEED_BUILD}" -eq 1 ]]; then
    echo "[run.sh] Building frontend..."
    if ! command -v npm >/dev/null 2>&1; then
      echo "[run.sh] npm not found. Install Node.js (recommend v20) to build the frontend, or prebuild manually."
      exit 1
    fi
    pushd "${FRONTEND_DIR}" >/dev/null
    npm config set registry https://registry.npmjs.org/ >/dev/null 2>&1 || true
    if [[ -f package-lock.json ]]; then
      npm ci || npm i
    else
      npm i
    fi
    npm run build
    popd >/dev/null
  else
    echo "[run.sh] Frontend build is up-to-date."
  fi
fi

# 3) Python venv and dependencies
if [[ ! -d "${VENV_DIR}" ]]; then
  echo "[run.sh] Creating Python venv..."
  python3 -m venv "${VENV_DIR}"
fi

source "${VENV_DIR}/bin/activate"
pip install -r "${PROJECT_ROOT}/requirements.txt"

# 4) Start backend (serves frontend at /app)
echo "[run.sh] Starting backend at http://localhost:8080 (frontend at /app)"
exec python "${PROJECT_ROOT}/main.py"


