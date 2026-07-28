# AICRM 운영 배포 · 백업 가이드

매장 온프레미스 단일 서버 기준. **Docker를 쓰지 않는다**(개발실행계획서 전제).
백엔드는 systemd 서비스, 프런트는 정적 빌드를 nginx가 서빙한다.

| 구성요소 | 위치 | 비고 |
|---|---|---|
| 소스 | `/opt/aicrm` | 이 저장소 체크아웃 |
| 백엔드 | systemd `aicrm-backend` → `node dist/main.js` (127.0.0.1:3000) | 외부에 직접 노출하지 않는다 |
| 프런트 | `/var/www/aicrm` (nginx :80) | `frontend/dist` 빌드 산출물 |
| DB | PostgreSQL 16 로컬, DB명 `aicrm` | 개발용 `aicrm_dev`와 분리 |
| 업로드 파일 | `/var/lib/aicrm/storage` | 계약서·작업지시서·채촌 사진 |
| 백업 | `/var/backups/aicrm/<타임스탬프>/` | 매일 03:20, 30일 보존 |

---

## 1. 최초 설치

### 1.1 사전 준비

```bash
# Node.js 20 LTS, PostgreSQL 16, nginx, rsync 설치는 배포판 패키지로 진행한다.
sudo useradd --system --home /opt/aicrm --shell /usr/sbin/nologin aicrm

sudo mkdir -p /opt/aicrm /var/lib/aicrm/storage /var/backups/aicrm /var/www/aicrm
sudo chown -R aicrm:aicrm /opt/aicrm /var/lib/aicrm /var/backups/aicrm
```

### 1.2 DB

```bash
sudo -u postgres psql -c "CREATE ROLE aicrm LOGIN PASSWORD '강한비밀번호'"
sudo -u postgres psql -c "CREATE DATABASE aicrm OWNER aicrm"
# 렌탈 기간 겹침 방지 제약(EXCLUDE)에 btree_gist가 필요하다 — 마이그레이션이 생성하지만
# 확장 생성 권한이 없으면 실패하므로 미리 만들어 둔다.
sudo -u postgres psql -d aicrm -c "CREATE EXTENSION IF NOT EXISTS btree_gist"
```

### 1.3 소스·환경파일

```bash
sudo -u aicrm git clone <저장소> /opt/aicrm
cd /opt/aicrm
sudo -u aicrm cp backend/.env.production.example backend/.env
sudo -u aicrm vi backend/.env          # DATABASE_URL·JWT_SECRET 반드시 교체
sudo chmod 600 backend/.env
```

`JWT_SECRET` 생성: `openssl rand -base64 48`

### 1.4 서비스 등록

```bash
sudo cp ops/aicrm-backend.service /etc/systemd/system/
sudo cp ops/aicrm-backup.service ops/aicrm-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aicrm-backend
sudo systemctl enable --now aicrm-backup.timer

sudo cp ops/nginx-aicrm.conf /etc/nginx/sites-available/aicrm
sudo ln -s /etc/nginx/sites-available/aicrm /etc/nginx/sites-enabled/aicrm
sudo nginx -t && sudo systemctl reload nginx
```

### 1.5 초기 데이터

```bash
cd /opt/aicrm/backend
sudo -u aicrm npx prisma migrate deploy
sudo -u aicrm npx prisma db seed        # 권한 47·역할 3·admin 계정·기준정보
```

**초기 계정 `admin / admin1234!` 로 로그인한 뒤 즉시 비밀번호를 바꾼다.**
데모 시드(`seed:demo` 등)는 운영에서 실행하지 않는다 — 가짜 고객·계약이 들어간다.

---

## 2. 배포 (업데이트)

```bash
cd /opt/aicrm
sudo -u aicrm git pull
sudo ops/deploy.sh
```

`deploy.sh`가 하는 일: **배포 전 백업 → 의존성 설치 → 마이그레이션 → 백엔드·프런트 빌드 →
정적파일 동기화 → 서비스 재기동 → 헬스체크(최대 30초)**. 헬스체크가 실패하면 0이 아닌 코드로
끝나므로, 실패를 못 보고 넘어가지 않는다.

```bash
sudo journalctl -u aicrm-backend -n 100 --no-pager   # 실패 시 로그
```

### 롤백

```bash
cd /opt/aicrm
sudo -u aicrm git checkout <이전_커밋>
sudo ops/deploy.sh --skip-backup
```

> **마이그레이션은 되돌아가지 않는다.** 스키마를 바꾼 배포를 되돌리려면 코드만 되돌릴 게 아니라
> 배포 직전 백업으로 복구해야 한다(3.2). 컬럼 삭제가 포함된 배포는 특히 그렇다.

---

## 3. 백업 · 복구

### 3.1 백업

매일 03:20 자동 실행(`aicrm-backup.timer`). 한 벌은 다음 3개다.

| 파일 | 내용 |
|---|---|
| `db.dump` | `pg_dump -Fc` 전체 덤프 |
| `db.toc.txt` | `pg_restore --list` 결과 — **덤프가 실제로 읽히는지 백업 시점에 검증한 흔적** |
| `storage.tar.gz` | 업로드 파일 전체 |
| `manifest.txt` | 생성 시각·호스트·git 커밋 |

```bash
sudo -u aicrm ops/backup.sh                    # 수동 실행
systemctl list-timers aicrm-backup.timer       # 다음 실행 시각 확인
sudo journalctl -u aicrm-backup -n 50          # 지난 실행 결과
```

**같은 디스크에만 두면 디스크 고장 시 함께 사라진다.** NAS·외장 디스크를 마운트하고
`aicrm-backup.service`의 `BACKUP_MIRROR_DIR` 주석을 풀어 한 벌 더 복사한다.

### 3.2 복구

```bash
sudo systemctl stop aicrm-backend
sudo -u aicrm ops/restore.sh /var/backups/aicrm/20260728-032000
sudo systemctl start aicrm-backend
curl -s localhost:3000/api/v1/health/ready
```

DB 이름을 손으로 입력해야 진행된다(오조작 방지). 기존 업로드 폴더는 지우지 않고
`storage.before-restore-<시각>`으로 치워 둔다.

### 3.3 복구 훈련

백업은 **복구해 본 적이 있어야** 백업이다. 분기 1회, 운영과 별개의 DB로 복구를 시연한다.

```bash
sudo -u postgres psql -c "CREATE DATABASE aicrm_restore_test OWNER aicrm"
pg_restore --dbname="postgresql://aicrm:...@localhost:5432/aicrm_restore_test" \
  --clean --if-exists --no-owner /var/backups/aicrm/<최신>/db.dump
# 확인 후 삭제
sudo -u postgres psql -c "DROP DATABASE aicrm_restore_test"
```

---

## 4. 점검

```bash
curl -s localhost:3000/api/v1/health         # 앱 기동 여부
curl -s localhost:3000/api/v1/health/ready   # DB 연결까지
systemctl status aicrm-backend nginx postgresql
df -h /var/lib/aicrm /var/backups            # 업로드·백업 디스크 여유
```

`/api/v1/health*`는 인증 없이 열려 있는 유일한 조회 엔드포인트이며 업무 데이터를 내보내지 않는다.
서버를 외부에 노출한다면 nginx에서 `/api/v1/health`를 사내망으로 제한한다.

---

## 5. 운영 주의사항

- **`.env`의 `JWT_SECRET`을 바꾸면 전 사용자가 즉시 로그아웃된다.** 영업시간에 바꾸지 않는다.
- **업로드 파일과 DB는 함께 백업·복구한다.** DB에는 파일 경로만 있어 한쪽만 되돌리면 첨부가 깨진다.
- **데모 시드를 운영에서 돌리지 않는다.** `npm run seed:demo`·`seed:more` 등은 가짜 데이터를 만든다.
  운영에서 필요한 것은 `prisma db seed`(권한·역할·기준정보)뿐이며 upsert라 재실행이 안전하다.
- **스케줄러가 없다.** 알림 발송은 사용자가 확인창에서 눌러야 나간다(자동 배치 없음).
- **외부 연동은 아직 스텁이다.** 네이버 예약 수집·알림톡 발송은 어댑터만 있고 실제로 나가지 않는다
  (`docs/dev/v2/08_잔여개발_항목_및_개발방안.md` D 항목). 운영 전환 시 이 부분을 먼저 확인한다.
