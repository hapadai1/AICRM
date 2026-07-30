/**
 * 페이지 공통 뼈대 (UI 정리 Phase 1).
 *
 * 지금까지 화면마다 최상위 래퍼가 제각각이었다.
 *  - <Card> 한 장으로 전체를 감싼 화면 (고객·예약·채촌·제작·수선)
 *  - <Space>+<Card> 여러 장 (계약·렌탈·연락)
 *  - 카드 없이 raw <div> (감사로그)
 * 게다가 Card size 가 small/middle/large 로, Table size 가 small/middle 로 섞여 있어
 * 화면을 옮길 때마다 여백과 글자 크기가 미묘하게 달라졌다.
 *
 * 이 파일이 그 규격이다. 새 화면은 여기 있는 것만 조합해서 만든다.
 */
import { Card, Flex, Space } from 'antd';
import type { CardProps } from 'antd';
import type { ReactNode } from 'react';
import { LAYOUT } from '../app/theme';

interface PageShellProps {
  children: ReactNode;
}

/** 페이지 최상위 래퍼 — 섹션(카드) 사이 간격을 통일한다. */
export function PageShell({ children }: PageShellProps) {
  return (
    <Space direction="vertical" size={LAYOUT.sectionGap} style={{ width: '100%' }}>
      {children}
    </Space>
  );
}

/**
 * 페이지 안의 섹션 카드.
 * size 를 받지 않는다 — 크기가 섞이는 것이 기존 불일치의 주원인이었다.
 */
export function PageCard({ children, ...rest }: CardProps) {
  return <Card {...rest}>{children}</Card>;
}

interface ListToolbarProps {
  /** 왼쪽: 검색·필터 컨트롤 */
  filters?: ReactNode;
  /** 오른쪽: 기능 버튼 (등록·인쇄·동기화 등) — 버튼은 항상 이 자리다 */
  actions?: ReactNode;
  /** 필터 줄 아래에 붙는 보조 안내(건수·기간 안내 등) */
  info?: ReactNode;
}

/**
 * 목록 화면 상단 툴바.
 *
 * 기존에는 검색·필터 배치가 세 가지로 갈려 있었다.
 *  (a) Space wrap + Input/Segmented   (고객·채촌·스타일 컨설팅)
 *  (b) Row/Col 그리드                 (계약 관리)
 *  (c) Form layout="inline" 라벨+콜론  (렌탈 재고·렌탈 예약)
 * 특히 (c)는 "검색어 :" 처럼 라벨이 붙어 혼자 다른 시스템처럼 보였다.
 * 앞으로 필터는 라벨 없이 placeholder 로 뜻을 전달하고 전부 이 툴바에 넣는다.
 *
 * 기능 버튼은 예외 없이 오른쪽(actions)이다 — 렌탈 재고처럼 왼쪽에 두거나
 * 출고·반납처럼 좌우로 갈라 두지 않는다.
 */
export function ListToolbar({ filters, actions, info }: ListToolbarProps) {
  if (!filters && !actions && !info) return null;
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Flex justify="space-between" align="flex-start" gap={12} wrap>
        <Space wrap size={8}>
          {filters}
        </Space>
        {actions ? (
          <Space wrap size={8}>
            {actions}
          </Space>
        ) : null}
      </Flex>
      {info}
    </Space>
  );
}
