#!/bin/bash
# Creates the non-superuser application role.
#
# This exists because Postgres superusers, and any role with BYPASSRLS, ignore
# Row-Level Security entirely. If the app connected as the same superuser that
# owns the tables, every RLS policy would be silently inert — and worse, the
# T11 isolation test would pass for the wrong reason.
#
# Runs once, on first initialisation of the data volume. Re-create it with
# `docker compose down -v && docker compose up -d`.
set -euo pipefail

APP_DB_USER="${APP_DB_USER:-revira_app}"

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "APP_DB_PASSWORD is not set; refusing to create a passwordless app role." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
	    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
	  ELSE
	    ALTER ROLE ${APP_DB_USER} WITH LOGIN PASSWORD '${APP_DB_PASSWORD}';
	  END IF;
	END
	\$\$;

	-- The whole point of this role: it must never bypass RLS.
	ALTER ROLE ${APP_DB_USER} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
EOSQL

echo "Application role '${APP_DB_USER}' ready (NOSUPERUSER, NOBYPASSRLS)."
