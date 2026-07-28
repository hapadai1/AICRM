/**
 * 구성품 진행 스텝퍼 — 표의 한 행에서 "어디까지 왔고 다음이 무엇인지"를 그림으로 보여준다.
 *
 * 상태 배지 하나만으로는 자켓이 어디서 막혔는지 팬츠와 견줄 수 없다.
 * 전체 단계를 항상 같은 자리에 같은 폭으로 깔아 두어야 행끼리 세로로 비교된다 —
 * 그래서 지난 단계도 지우지 않고 남긴다.
 */
import { Tooltip, Typography } from 'antd';
import { COMPONENT_STATUS_RANK } from '../../api/production';
import { stepsFor } from './component-flow';

const DONE = '#52c41a';
const CURRENT = '#1677ff';
const PENDING = '#d9d9d9';

/** 단계 한 칸의 폭 — 행마다 같아야 세로 비교가 된다 */
const CELL = 34;

type StepState = 'done' | 'current' | 'pending';

interface ComponentProgressProps {
  status: string;
  /** 'RENTAL'이면 예약 → 입고 → 출고 흐름으로 그린다 */
  transactionType: string;
}

export function ComponentProgress({ status, transactionType }: ComponentProgressProps) {
  // 취소는 흐름 밖이다 — 진행 그림 대신 그 사실만 알린다.
  if (status === 'CANCELLED') {
    return <Typography.Text type="danger">취소됨</Typography.Text>;
  }

  const steps = stepsFor(transactionType);
  const currentIdx = steps.findIndex((s) => s.status === status);
  const currentRank = COMPONENT_STATUS_RANK[status];

  const stateOf = (idx: number): StepState => {
    if (idx === currentIdx) return 'current';
    if (currentIdx >= 0) return idx < currentIdx ? 'done' : 'pending';
    // 흐름에 없는 상태로 들어온 경우(코드 추가 등)에는 순번으로만 앞뒤를 가른다.
    const rank = COMPONENT_STATUS_RANK[steps[idx].status];
    if (currentRank === undefined || rank === undefined) return 'pending';
    return rank < currentRank ? 'done' : 'pending';
  };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {steps.map((step, i) => {
        const state = stateOf(i);
        const color = state === 'done' ? DONE : state === 'current' ? CURRENT : PENDING;
        // 지나간 선택 단계는 실제로 밟았는지 기록만으로 알 수 없다 — 흐리게 그려 단정하지 않는다.
        const uncertain = state === 'done' && step.optional;
        const tip = uncertain ? `${step.full} — 지난 단계 (건너뛰었을 수 있음)` : step.full;

        return (
          <div key={step.status} style={{ width: CELL, textAlign: 'center', position: 'relative' }}>
            {i > 0 && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: -CELL / 2,
                  top: 5,
                  width: CELL,
                  height: 2,
                  background: state === 'pending' ? '#f0f0f0' : DONE,
                }}
              />
            )}
            <Tooltip title={tip}>
              <span
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: state === 'pending' ? '#fff' : color,
                  border: state === 'pending' ? `2px solid ${PENDING}` : `2px solid ${color}`,
                  boxSizing: 'border-box',
                  opacity: uncertain ? 0.45 : 1,
                  boxShadow: state === 'current' ? `0 0 0 3px rgba(22,119,255,0.18)` : undefined,
                }}
              />
            </Tooltip>
            <div
              style={{
                fontSize: 11,
                lineHeight: '16px',
                marginTop: 3,
                whiteSpace: 'nowrap',
                color: state === 'current' ? CURRENT : 'rgba(0,0,0,0.45)',
                fontWeight: state === 'current' ? 600 : 400,
                opacity: uncertain ? 0.55 : 1,
              }}
            >
              {step.short}
            </div>
          </div>
        );
      })}
    </div>
  );
}
