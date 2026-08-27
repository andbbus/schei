#!/bin/bash
# Double-click this file in Finder to launch the YNAB-clone webapp.
# First run installs dependencies and seeds the database; later runs just start it.

cd "$(dirname "$0")" || exit 1
echo "▶  YNAB-clone starter"
echo

# --- dependencies ---
[ -d backend/node_modules ]  || { echo "Installing backend dependencies…";  npm --prefix backend install;  }
[ -d frontend/node_modules ] || { echo "Installing frontend dependencies…"; npm --prefix frontend install; }

# --- database (first run only) ---
if [ ! -f backend/prisma/dev.db ]; then
  echo "Creating and seeding the database…"
  ( cd backend && npm run db:push && npm run seed )
fi

# --- backup (this is the primary financial record — one snapshot per day, keep 14) ---
if [ -f backend/prisma/dev.db ]; then
  mkdir -p backups
  STAMP=$(date +%Y-%m-%d)
  if [ ! -f "backups/dev-$STAMP.db" ]; then
    sqlite3 backend/prisma/dev.db ".backup 'backups/dev-$STAMP.db'" 2>/dev/null \
      || cp backend/prisma/dev.db "backups/dev-$STAMP.db"
    ls -t backups/dev-*.db 2>/dev/null | tail -n +15 | xargs rm -f 2>/dev/null
    echo "Database backed up → backups/dev-$STAMP.db"
  fi
fi

PIDS=()

# --- backend (:3001) ---
if curl -s http://localhost:3001/api/health >/dev/null 2>&1; then
  echo "Backend already running on :3001"
else
  echo "Starting backend  (:3001)…"
  ( cd backend && npm run dev ) &
  PIDS+=($!)
  printf "  waiting for backend"
  until curl -s http://localhost:3001/api/health >/dev/null 2>&1; do printf "."; sleep 0.5; done
  echo " ready"
fi

# --- frontend (:5173) ---
if curl -s http://localhost:5173 >/dev/null 2>&1; then
  echo "Frontend already running on :5173"
else
  echo "Starting frontend (:5173)…"
  ( cd frontend && npm run dev ) &
  PIDS+=($!)
  printf "  waiting for frontend"
  until curl -s http://localhost:5173 >/dev/null 2>&1; do printf "."; sleep 0.5; done
  echo " ready"
fi

echo
echo "✓  Opening http://localhost:5173"
open http://localhost:5173

if [ ${#PIDS[@]} -gt 0 ]; then
  echo "   Press Ctrl-C (or close this window) to stop the servers."
  trap 'echo; echo "Stopping…"; kill "${PIDS[@]}" 2>/dev/null; exit 0' INT TERM
  wait
else
  echo "   Both servers were already running."
fi
