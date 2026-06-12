#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ENV="$SCRIPT_DIR/../server/.env"

# Load local DATABASE_URL from server/.env
if [[ -f "$SERVER_ENV" ]]; then
  LOCAL_DATABASE_URL="$(grep '^DATABASE_URL=' "$SERVER_ENV" | cut -d'"' -f2)"
fi

if [[ -z "${NEON_DATABASE_URL:-}" ]]; then
  echo "Error: NEON_DATABASE_URL is not set."
  echo "Usage: NEON_DATABASE_URL='postgresql://...' LOCAL_CLERK_USER_ID='user_...' ./scripts/sync-prod-to-local.sh"
  exit 1
fi

if [[ -z "${LOCAL_DATABASE_URL:-}" ]]; then
  echo "Error: Could not read DATABASE_URL from server/.env"
  exit 1
fi

DUMP_FILE="$(mktemp /tmp/beacon-prod-dump.XXXXXX.dump)"
trap 'rm -f "$DUMP_FILE"' EXIT

echo "Dumping production database from Neon..."
pg_dump "$NEON_DATABASE_URL" --no-owner --no-acl -Fc -f "$DUMP_FILE"

echo "Restoring to local database..."
pg_restore --clean --if-exists --no-owner --no-acl -d "$LOCAL_DATABASE_URL" "$DUMP_FILE"

# Replace prod Clerk userId with local Clerk userId if provided
if [[ -n "${LOCAL_CLERK_USER_ID:-}" ]]; then
  echo "Detecting production userId..."
  PROD_USER_ID="$(psql "$LOCAL_DATABASE_URL" -At -c "SELECT \"userId\" FROM accounts WHERE \"userId\" IS NOT NULL LIMIT 1;")"

  if [[ -z "$PROD_USER_ID" ]]; then
    echo "Warning: could not detect production userId — skipping userId replacement."
  else
    echo "Replacing userId '$PROD_USER_ID' with '$LOCAL_CLERK_USER_ID' across all user-scoped tables..."
    # Data-driven: remap every table that has a "userId" column. This is
    # introspected from the live schema, so newly added user-scoped tables are
    # covered automatically — do NOT maintain a hardcoded table list here.
    USERID_TABLES="$(psql "$LOCAL_DATABASE_URL" -At -c \
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'userId' ORDER BY table_name;")"
    for tbl in $USERID_TABLES; do
      psql "$LOCAL_DATABASE_URL" \
        -c "UPDATE \"$tbl\" SET \"userId\" = '$LOCAL_CLERK_USER_ID' WHERE \"userId\" = '$PROD_USER_ID';"
    done
    echo "userId replacement complete."
  fi
fi

echo "Done."
