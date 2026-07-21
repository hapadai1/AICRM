# AICRM — 맞춤 정장 · 정장 렌탈 CRM

예약 → 계약 → 옵션 → 채촌 → 제작/렌탈 → 입출고/수선 → 완료 업무를 관리하는 내부 CRM.

## 문서
- 설계: [docs/plan/](docs/plan/) (통합개발설계서, 데이터모델설계서, 화면·API정의서)
- 개발: [docs/dev/](docs/dev/) (개발실행계획서, 구현표준정의서, 개발체크리스트)

## 사전 요구
- Node.js 20 LTS
- PostgreSQL 16 (로컬 설치, Docker 미사용)

## 실행 (로컬 개발)
```bash
# 1) 전용 DB 준비 (최초 1회) — 기존 DB를 사용하지 않고 새로 만든다
psql -d postgres -c "CREATE ROLE aicrm LOGIN PASSWORD 'aicrm' CREATEDB"
psql -d postgres -c "CREATE DATABASE aicrm_dev OWNER aicrm"
psql -d postgres -c "CREATE DATABASE aicrm_test OWNER aicrm"   # 테스트용

# 2) 백엔드
cd backend
cp .env.example .env
npm install
npx prisma migrate deploy                # 스키마 반영
npx prisma db seed                       # 권한·역할·admin 계정 등 시드
npm run start:dev                        # http://localhost:3000/api/v1

# 3) 프론트엔드
cd ../frontend
npm install
npm run dev                              # http://localhost:5173
```

초기 계정: `admin / admin1234!` (최초 로그인 후 변경 권장)

## 테스트
테스트 소스는 루트 [test/](test/) 폴더에서 통합 관리한다.
```bash
cd backend
npm test        # test/backend/*.spec.ts — aicrm_test DB에 마이그레이션·시드 후 실행
```

## 구조
- `backend/` NestJS 10 + Prisma + PostgreSQL
- `frontend/` React 18 + Vite + Ant Design 5
- `test/backend/` 백엔드 통합·단위 테스트 (Jest + supertest)
