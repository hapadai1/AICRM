#!/usr/bin/env bash
#
# AICRM 복구 — backup.sh가 만든 백업 한 벌을 되돌린다.
#
# 되돌릴 수 없는 작업이므로 대상 DB 이름을 손으로 입력해 확인받는다.
# 서비스는 미리 내려 둔다: sudo systemctl stop aicrm-backend
#
# 사용법:
#   ops/restore.sh /var/backups/aicrm/20260728-010000
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/backend/.env}"

SRC="${1:-}"
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  echo "사용법: ops/restore.sh <백업 폴더>" >&2
  echo "예:     ops/restore.sh /var/backups/aicrm/20260728-010000" >&2
  exit 1
fi
[[ -f "$SRC/db.dump" ]] || { echo "[restore] db.dump이 없습니다: $SRC" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${DATABASE_URL:?DATABASE_URL이 .env에 없습니다}"

STORAGE_PATH="${FILE_STORAGE_PATH:-$ROOT_DIR/backend/storage}"
if [[ "$STORAGE_PATH" != /* ]]; then
  STORAGE_PATH="$ROOT_DIR/backend/${STORAGE_PATH#./}"
fi

# URL에서 DB 이름만 뽑아 확인 문구로 쓴다
DB_NAME="$(basename "${DATABASE_URL%%\?*}")"

echo "─────────────────────────────────────────────"
echo " 복구 대상 DB : $DB_NAME"
echo " 백업 폴더    : $SRC"
[[ -f "$SRC/manifest.txt" ]] && sed 's/^/ /' "$SRC/manifest.txt"
echo "─────────────────────────────────────────────"
echo "현재 데이터는 백업본으로 '덮어써집니다'. 되돌릴 수 없습니다."
read -r -p "계속하려면 DB 이름을 그대로 입력하세요 [$DB_NAME]: " CONFIRM
[[ "$CONFIRM" == "$DB_NAME" ]] || { echo "[restore] 취소했습니다."; exit 1; }

# --- 1) DB -----------------------------------------------------------------
# --clean --if-exists: 기존 객체를 지우고 덮어쓴다. 스키마째 되돌리므로
# 백업 시점 이후의 마이그레이션도 함께 사라진다(정상 — 그 시점으로 돌아가는 것).
echo "[restore] pg_restore ..."
pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$SRC/db.dump"

# --- 2) 업로드 파일 --------------------------------------------------------
if [[ -f "$SRC/storage.tar.gz" ]]; then
  echo "[restore] storage 복구 → $STORAGE_PATH"
  # 기존 폴더는 지우지 않고 옆에 치워 둔다 — 잘못된 복구에서 되돌릴 여지를 남긴다.
  if [[ -d "$STORAGE_PATH" ]]; then
    mv "$STORAGE_PATH" "${STORAGE_PATH}.before-restore-$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "$(dirname "$STORAGE_PATH")"
  tar -xzf "$SRC/storage.tar.gz" -C "$(dirname "$STORAGE_PATH")"
else
  echo "[restore] 경고: storage.tar.gz가 없어 파일은 복구하지 않았습니다." >&2
fi

echo "[restore] 완료. 서비스를 다시 올리세요: sudo systemctl start aicrm-backend"
echo "[restore] 확인:  curl -s localhost:3000/api/v1/health/ready"
