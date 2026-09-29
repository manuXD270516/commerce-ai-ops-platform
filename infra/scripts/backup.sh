# Local backup of the Compose PostgreSQL volume. Cloud restore (RDS) is blocked without AWS credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT="${ROOT}/backups/${STAMP}.sql"
mkdir -p "${ROOT}/backups"
docker compose -f "${ROOT}/compose.yaml" --env-file "${ROOT}/../.env" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-commerce}" "${POSTGRES_DB:-commerce}" > "${OUT}"
echo "wrote ${OUT}"
