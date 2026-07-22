const { execSync } = require('child_process');
const path = require('path');

/** 테스트 시작 전: aicrm_test DB에 마이그레이션과 시드를 적용한다. */
module.exports = async function globalSetup() {
  const backendDir = path.resolve(__dirname, '../../backend');
  const testDbUrl =
    process.env.DATABASE_URL_TEST || 'postgresql://aicrm:aicrm@localhost:5432/aicrm_test';
  const testDbName = testDbUrl.split('/').pop().split('?')[0];
  if (!/test/i.test(testDbName)) {
    throw new Error(
      `테스트 DB(${testDbName})의 이름에 'test'가 없습니다. migrate/seed가 개발 DB를 덮어쓰지 ` +
        `않도록 DATABASE_URL_TEST를 aicrm_test로 설정하세요.`,
    );
  }
  const env = { ...process.env, DATABASE_URL: testDbUrl };
  execSync('npx prisma migrate deploy', { cwd: backendDir, env, stdio: 'inherit' });
  execSync('npx prisma db seed', { cwd: backendDir, env, stdio: 'inherit' });
};
