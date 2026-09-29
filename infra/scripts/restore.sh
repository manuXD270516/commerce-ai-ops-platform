# Restore a SQL dump into an isolated Compose Postgres. Does not target production.
set -euo pipefail
DUMP="${1:?path to sql dump}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
START=$(date +%s)
docker compose -f "${ROOT}/compose.yaml" --env-file "${ROOT}/../.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-commerce}" -d "${POSTGRES_DB:-commerce}" < "${DUMP}"
END=$(date +%s)
echo "restore_seconds=$((END-START)) dump=${DUMP}"
