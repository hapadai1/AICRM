/**
 * 발주 창의 확인 한 줄 (2026-08-05 현업 확정).
 *
 * 제작 발주와 완성복 발주는 "무엇이 준비됐는지 보고 낸다"는 같은 일이라 같은 틀을 쓴다.
 * `됐는지(아이콘) · 무엇(이름) · 상태 낱말 · 부가정보 · 가는 곳(버튼)` 다섯 칸의 x를 고정해,
 * 두 창을 오가도 눈이 같은 자리를 읽게 한다.
 */
import type { ReactNode } from 'react';
import { CheckCircleFilled, MinusCircleOutlined } from '@ant-design/icons';
import { Typography } from 'antd';

export function PrepRow({
  label,
  done,
  detail,
  action,
  children,
}: {
  label: string;
  done: boolean;
  detail: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
        {done ? (
          <CheckCircleFilled style={{ color: '#52c41a', fontSize: 16 }} />
        ) : (
          <MinusCircleOutlined style={{ color: '#bfbfbf', fontSize: 16 }} />
        )}
        <Typography.Text style={{ width: 96, flexShrink: 0 }}>{label}</Typography.Text>
        <Typography.Text
          type={done ? undefined : 'secondary'}
          style={{ width: 48, flexShrink: 0 }}
          strong={done}
        >
          {done ? '완료' : '미완료'}
        </Typography.Text>
        <div style={{ flex: 1, minWidth: 0 }}>{detail}</div>
        {action}
      </div>
      {children}
    </>
  );
}
