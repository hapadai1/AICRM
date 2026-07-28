#!/usr/bin/env bash
#
# AICRM 백업 — DB(pg_dump 커스텀 포맷) + 업로드 파일(storage) 한 벌.
#
# 매장 온프레미스 서버에서 매일 새벽 1회 도는 것을 전제로 한다(ops/README.md 참고).
# 백업본은 같은 디스크에만 두면 디스크 고장 시 함께 사라지므로, 완료 후
# BACKUP_MIRROR_DIR(NAS 마운트 등)로 한 벌 더 복사한다 — 설정 시에만 동작.
#
# 사용법:
#   ops/backup.sh                     # .env의 DATABASE_URL 사용
#   BACKUP_DIR=/mnt/nas/aicrm ops/backup.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# --- 설정 -------------------------------------------------------------------
ENV_FILE="${ENV_FILE:-$ROOT_DIR/backend/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aicrm}"
BACKUP_MIRROR_DIR="${BACKUP_MIRROR_DIR:-}"   # 비우면 미러링 생략
RETENTION_DAYS="${RETENTION_DAYS:-30}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[backup] 환경파일이 없습니다: $ENV_FILE" >&2
  exit 1
fi

# DATABASE_URL / FILE_STORAGE_PATH 만 읽는다 (set -a 로 export)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${DATABASE_URL:?DATABASE_URL이 .env에 없습니다}"
STORAGE_PATH="${FILE_STORAGE_PATH:-$ROOT_DIR/backend/storage}"
# 상대경로면 backend 기준으로 푼다 (앱이 그렇게 해석한다)
if [[ "$STORAGE_PATH" != /* ]]; then
  STORAGE_PATH="$ROOT_DIR/backend/${STORAGE_PATH#./}"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

echo "[backup] 시작 $STAMP → $DEST"

# --- 1) DB ------------------------------------------------------------------
# 커스텀 포맷(-Fc): 압축 + pg_restore로 선택 복구 가능. 스키마·데이터 모두 포함.
echo "[backup] pg_dump ..."
pg_dump --dbname="$DATABASE_URL" --format=custom --file="$DEST/db.dump"

# 덤프가 실제로 읽히는지 즉시 검증한다 — 복구 때 처음 알게 되는 사고를 막는다.
pg_restore --list "$DEST/db.dump" > "$DEST/db.toc.txt"
echo "[backup] pg_dump 완료 ($(du -h "$DEST/db.dump" | cut -f1)), 목차 $(wc -l < "$DEST/db.toc.txt")행"

# --- 2) 업로드 파일 ---------------------------------------------------------
# 계약서·작업지시서·채촌 사진 등. DB에는 경로만 있어 파일이 없으면 복구가 반쪽이다.
if [[ -d "$STORAGE_PATH" ]]; then
  echo "[backup] storage 압축 ($STORAGE_PATH) ..."
  tar -czf "$DEST/storage.tar.gz" -C "$(dirname "$STORAGE_PATH")" "$(basename "$STORAGE_PATH")"
  echo "[backup] storage 완료 ($(du -h "$DEST/storage.tar.gz" | cut -f1))"
else
  echo "[backup] 경고: storage 경로가 없습니다 — 건너뜁니다: $STORAGE_PATH" >&2
fi

# --- 3) 메타 ----------------------------------------------------------------
{
  echo "created_at=$(date -Iseconds)"
  echo "host=$(hostname)"
  echo "git_commit=$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "storage_path=$STORAGE_PATH"
} > "$DEST/manifest.txt"

# --- 4) 미러링 --------------------------------------------------------------
if [[ -n "$BACKUP_MIRROR_DIR" ]]; then
  echo "[backup] 미러 복사 → $BACKUP_MIRROR_DIR"
  mkdir -p "$BACKUP_MIRROR_DIR"
  cp -R "$DEST" "$BACKUP_MIRROR_DIR/"
fi

# --- 5) 보존기간 정리 -------------------------------------------------------
# RETENTION_DAYS보다 오래된 백업 폴더 삭제. 미러 쪽은 손대지 않는다(별도 정책).
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} +

echo "[backup] 완료: $DEST"
