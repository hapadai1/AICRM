// pm2 프로세스 관리 설정 — 백엔드/프론트 dev 서버를 상시 실행하고,
// 죽으면 자동 재시작하며, PC 재부팅 후에도 pm2 startup + save 로 되살아난다.
// 실행: pm2 start ecosystem.config.js  /  상태: pm2 status  /  로그: pm2 logs
module.exports = {
  apps: [
    {
      name: 'aicrm-backend',
      cwd: '/Users/nurier/Desktop/src/AICRM/backend',
      script: 'npm',
      args: 'run start:dev', // nest --watch 가 자체 파일 감시하므로 pm2 watch 는 끈다
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 3000,
      env: { NODE_ENV: 'development' },
    },
    {
      name: 'aicrm-frontend',
      cwd: '/Users/nurier/Desktop/src/AICRM/frontend',
      script: 'npm',
      args: 'run dev', // vite HMR 가 자체 감시
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 3000,
    },
  ],
};
