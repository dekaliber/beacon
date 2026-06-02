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
    echo "Replacing userId '$PROD_USER_ID' with '$LOCAL_CLERK_USER_ID'..."
    psql "$LOCAL_DATABASE_URL" -v prod="$PROD_USER_ID" -v local="$LOCAL_CLERK_USER_ID" <<'SQL'
      UPDATE accounts           SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE categories         SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE tags               SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE recurrence_rules   SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE annual_budgets     SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE budget_settings    SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE investment_settings SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE transfer_rules     SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE tax_assumptions    SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE pending_buys       SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE pending_sales      SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE asset_classes      SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE asset_class_targets SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE options_settings   SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE options_tickers    SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE options_position_groups SET "userId" = :'local' WHERE "userId" = :'prod';
      UPDATE options_positions  SET "userId" = :'local' WHERE "userId" = :'prod';
SQL
    echo "userId replacement complete."
  fi
fi

echo "Done."
