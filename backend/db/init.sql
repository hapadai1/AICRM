-- =============================================================================
-- AICRM DB 부트스트랩 스크립트
-- 역할(role)과 데이터베이스만 생성한다. 테이블/확장/제약은 Prisma 마이그레이션
-- (`prisma migrate deploy`)이 담당하므로 여기서 만들지 않는다.
--
-- 실행 (PostgreSQL 슈퍼유저로):
--   psql -U postgres -h localhost -f backend/db/init.sql
--
-- 접속 문자열(.env DATABASE_URL) 기준값:
--   postgresql://aicrm:aicrm@localhost:5432/aicrm_dev
--
-- [주의] 운영 배포 시 아래 비밀번호는 반드시 교체할 것.
-- 재실행해도 안전(idempotent)하도록 작성됨. psql 전용(\gexec 사용).
-- =============================================================================

-- 1) 애플리케이션 role 생성 (없을 때만)
DO
$$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aicrm') THEN
    CREATE ROLE aicrm WITH LOGIN PASSWORD 'aicrm';
  END IF;
END
$$;

-- 2) 데이터베이스 생성 (없을 때만)
--    CREATE DATABASE 는 트랜잭션/DO 블록 안에서 실행할 수 없어 \gexec 로 처리.
SELECT 'CREATE DATABASE aicrm_dev OWNER aicrm ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aicrm_dev')\gexec

-- 3) 스키마 권한 부여
\connect aicrm_dev
GRANT ALL ON SCHEMA public TO aicrm;
