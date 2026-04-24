#!/bin/bash
# Runs prisma migrate deploy against the Neon production DB, automatically
# resolving migrations whose DDL already exists (constraint/table/enum label)
# from a prior db push. Safe to re-run.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL is not set. Run with:"
  echo "  DATABASE_URL='<neon-url>' ./scripts/migrate-prod.sh"
  exit 1
fi

cd "$(dirname "$0")/../server"

MAX_ITERATIONS=60
iteration=0

while [ $iteration -lt $MAX_ITERATIONS ]; do
  iteration=$((iteration + 1))
  echo ""
  echo "── migrate deploy (attempt $iteration) ──────────────────────────"

  output=$(npx prisma migrate deploy 2>&1) || true
  echo "$output"

  # Success
  if echo "$output" | grep -q "All migrations have been successfully applied\|No pending migrations"; then
    echo ""
    echo "✓ All migrations applied successfully."
    exit 0
  fi

  # P3009: a previous run left a failed migration record — name is in backticks
  if echo "$output" | grep -q "P3009"; then
    failed=$(echo "$output" | sed -n "s/.*The \`\([^\`]*\)\` migration.*/\1/p")
    if [ -z "$failed" ]; then
      echo ""
      echo "✗ P3009 error but could not parse the migration name. Review the output above."
      exit 1
    fi
    echo ""
    echo "→ Resolving pre-existing failed migration '$failed'."
    npx prisma migrate resolve --applied "$failed"
    continue
  fi

  # P3018: failed during this deploy run — name follows "Migration name:"
  failed=$(echo "$output" | awk '/Migration name:/{print $NF}')

  if [ -z "$failed" ]; then
    echo ""
    echo "✗ Deploy failed but could not parse the migration name. Review the output above."
    exit 1
  fi

  # Only auto-resolve errors that are safe to skip (already-exists variants)
  if echo "$output" | grep -qE "42710|42P07|already exists"; then
    echo ""
    echo "→ Schema already contains changes from '$failed' — marking applied."
    npx prisma migrate resolve --applied "$failed"
  else
    echo ""
    echo "✗ '$failed' failed with an unexpected error. Review the output above before resolving manually."
    exit 1
  fi
done

echo "✗ Reached max iterations ($MAX_ITERATIONS) without completing. Something may be wrong."
exit 1
