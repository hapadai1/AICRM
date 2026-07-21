import { useEffect } from 'react';
import { App } from 'antd';
import { useBlocker } from 'react-router-dom';

/**
 * 저장되지 않은 변경이 있으면 라우트 이동·브라우저 닫기 전에 경고한다 (문서 03 §3.2).
 */
export function useUnsavedWarning(when: boolean) {
  const { modal } = App.useApp();
  const blocker = useBlocker(when);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    modal.confirm({
      title: '저장되지 않은 변경',
      content: '저장되지 않은 변경이 있습니다. 이 화면을 벗어나면 변경 내용이 사라집니다.',
      okText: '이동',
      okButtonProps: { danger: true },
      cancelText: '계속 작성',
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
  }, [blocker, modal]);

  useEffect(() => {
    if (!when) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [when]);
}
