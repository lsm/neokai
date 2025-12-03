#!/usr/bin/env bash
#
# E2E Test Database Cleanup Script
#
# Cleans up orphaned sessions from the test database.
# Run this manually or add to CI/CD between test runs.
#

set -e

DB_PATH="../cli/data/daemon.db"

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
  echo "❌ Database not found at: $DB_PATH"
  exit 1
fi

# Count sessions before cleanup
BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions;")
echo "📊 Sessions before cleanup: $BEFORE"

# Clean up all test data
echo "🧹 Cleaning up test data..."
sqlite3 "$DB_PATH" <<SQL
DELETE FROM sessions;
DELETE FROM events;
DELETE FROM sdk_messages;
VACUUM;
SQL

# Count sessions after cleanup
AFTER=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions;")
echo "✅ Sessions after cleanup: $AFTER"
echo "🎉 Database cleaned successfully!"
