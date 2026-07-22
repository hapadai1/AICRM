/** 테스트 전용 환경. 개발 DB(aicrm_dev)가 아닌 aicrm_test를 사용한다. */
const testDbUrl =
  process.env.DATABASE_URL_TEST || 'postgresql://aicrm:aicrm@localhost:5432/aicrm_test';

// 안전장치: 테스트는 업무 데이터를 TRUNCATE하므로, DB 이름에 반드시 'test'가 있어야 한다.
// (실수로 DATABASE_URL_TEST가 aicrm_dev 등을 가리키면 개발 데이터가 날아가는 것을 막는다)
const testDbName = testDbUrl.split('/').pop().split('?')[0];
if (!/test/i.test(testDbName)) {
  throw new Error(
    `테스트 DB(${testDbName})의 이름에 'test'가 없습니다. 테스트는 데이터를 삭제하므로 ` +
      `aicrm_dev 같은 개발/운영 DB로는 실행할 수 없습니다. DATABASE_URL_TEST를 확인하세요.`,
  );
}
process.env.DATABASE_URL = testDbUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_ACCESS_EXPIRES = '30m';
process.env.REFRESH_TOKEN_DAYS = '14';
process.env.FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH || './storage-test';
