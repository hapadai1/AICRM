const { execSync } = require('child_process');
const path = require('path');

/** 테스트 시작 전: aicrm_test DB에 마이그레이션과 시드를 적용한다. */
module.exports = async function globalSetup() {
  const backendDir = path.resolve(__dirname, '../../backend');
  const env = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL_TEST || 'postgresql://aicrm:aicrm@localhost:5432/aicrm_test',
  };
  execSync('npx prisma migrate deploy', { cwd: backendDir, env, stdio: 'inherit' });
  execSync('npx prisma db seed', { cwd: backendDir, env, stdio: 'inherit' });
};
