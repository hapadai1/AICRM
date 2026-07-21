/** 테스트 전용 환경. 개발 DB(aicrm_dev)가 아닌 aicrm_test를 사용한다. */
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST || 'postgresql://aicrm:aicrm@localhost:5432/aicrm_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_ACCESS_EXPIRES = '30m';
process.env.REFRESH_TOKEN_DAYS = '14';
process.env.FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH || './storage-test';
