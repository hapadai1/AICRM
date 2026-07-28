#!/usr/bin/env bash
#
# AICRM 배포 — 의존성 설치 → 마이그레이션 → 빌드 → 재기동 → 헬스체크.
#
# 온프레미스 단일 서버(백엔드 systemd + 프런트 정적파일 nginx) 전제. Docker 미사용.
# 배포 전 백업을 먼저 뜬다(마이그레이션이 스키마를 바꾸므로).
#
# 사용법:
#   ops/deploy.sh              # 현재 체크아웃 상태로 배포
#   ops/deploy.sh --skip-backup
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE="${SERVICE:-aicrm-backend}"
WEB_ROOT="${WEB_ROOT:-/var/www/aicrm}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/v1/health/ready}"
SKIP_BACKUP=0
[[ "${1:-}" == "--skip-backup" ]] && SKIP_BACKUP=1

echo "[deploy] 커밋 $(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- 0) 배포 전 백업 --------------------------------------------------------
if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  echo "[deploy] 배포 전 백업 ..."
  "$SCRIPT_DIR/backup.sh"
else
  echo "[deploy] 백업 생략(--skip-backup)"
fi

# --- 1) 백엔드 --------------------------------------------------------------
cd "$ROOT_DIR/backend"
echo "[deploy] backend 의존성 설치 ..."
npm ci --omit=dev --ignore-scripts
# prisma client는 devDependencies 없이도 생성돼야 하므로 명시 실행한다.
npx prisma generate

echo "[deploy] 마이그레이션 적용 ..."
npx prisma migrate deploy

echo "[deploy] backend 빌드 ..."
# 빌드에는 devDependencies(nest cli·typescript)가 필요하다. 빌드 후 다시 정리하지 않는
# 이유는 재기동 실패 시 롤백 빌드를 바로 돌려야 하기 때문.
npm ci --ignore-scripts
npm run build

# --- 2) 프런트 --------------------------------------------------------------
cd "$ROOT_DIR/frontend"
echo "[deploy] frontend 빌드 ..."
npm ci --ignore-scripts
npm run build

echo "[deploy] 정적파일 배포 → $WEB_ROOT"
sudo mkdir -p "$WEB_ROOT"
# --delete: 이전 빌드의 해시 파일이 남아 디스크를 먹는 것을 막는다.
sudo rsync -a --delete "$ROOT_DIR/frontend/dist/" "$WEB_ROOT/"

# --- 3) 재기동 --------------------------------------------------------------
echo "[deploy] 서비스 재기동: $SERVICE"
sudo systemctl restart "$SERVICE"

# --- 4) 헬스체크 ------------------------------------------------------------
echo -n "[deploy] 헬스체크 "
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" > /dev/null 2>&1; then
    echo "✓ ($i초)"
    echo "[deploy] 완료."
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " ✗"
echo "[deploy] 헬스체크 실패 — 로그를 확인하세요: sudo journalctl -u $SERVICE -n 100 --no-pager" >&2
exit 1
