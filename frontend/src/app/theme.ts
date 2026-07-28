/**
 * 전역 디자인 토큰 (UI 정리 Phase 1).
 *
 * 지금까지 색·여백·크기는 각 화면의 인라인 style에 hex로 흩어져 있었다.
 * (#1677ff 14회, #d9d9d9 11회 …) 그래서 값 하나를 바꾸려면 전 파일을 고쳐야 했다.
 * 이 파일이 그 단일 출처다. 화면에서 색이 필요하면 hex 대신
 * `theme.useToken()` 이나 아래 SEMANTIC_COLOR 를 쓴다.
 */
import type { ThemeConfig } from 'antd';

/** 기본 폭·높이 규격 — 목록 화면의 검색창·필터 폭을 여기에 맞춘다. */
export const LAYOUT = {
  /** 목록 상단 통합검색 입력 폭 */
  searchWidth: 280,
  /** 필터 Select 기본 폭 */
  filterWidth: 150,
  /** 페이지 좌우·상하 여백 */
  pagePadding: 24,
  /** 카드 사이 세로 간격 */
  sectionGap: 16,
} as const;

/**
 * 상태 이외의 의미색 — antd 토큰으로 표현되지 않는 값만 둔다.
 * 상태 배지 색은 기존 status-meta.ts / labels.ts 를 계속 쓴다.
 */
export const SEMANTIC_COLOR = {
  /** 정체·지연 등 주의 행 배경 */
  warnBg: '#fff2f0',
  /** 정체·지연 등 주의 행 테두리 */
  warnBorder: '#ff7875',
  /** 오늘 강조 배경 */
  todayBg: '#e6f4ff',
  /** 선택일 강조 배경 */
  selectedBg: '#fff7e6',
  /** 선택일 강조 테두리 */
  selectedBorder: '#faad14',
  /** 감사로그 변경행 강조 배경 */
  diffBg: '#fffbe6',
} as const;

export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 8,
    // 표·폼이 화면 대부분이라 기본 컨트롤 높이를 살짝 키워 터치·클릭 여유를 준다.
    controlHeight: 36,
    fontSize: 14,
    colorBgLayout: '#f5f6f8',
  },
  components: {
    // 표 헤더는 본문과 확실히 구분되게 — 화면마다 다르던 회색을 하나로 고정한다.
    Table: {
      headerBg: '#fafafa',
      headerColor: '#1f1f1f',
      headerSplitColor: 'transparent',
      rowHoverBg: '#f5f8ff',
      cellPaddingBlock: 12,
    },
    Card: {
      // 카드 제목 줄의 기본 높이 — size 를 섞어 쓰던 것을 default 하나로 통일한다.
      headerHeight: 52,
      headerFontSize: 16,
      bodyPadding: 20,
    },
    Layout: {
      siderBg: '#0f1729',
      headerBg: '#ffffff',
      headerPadding: '0 24px',
    },
    Menu: {
      darkItemBg: '#0f1729',
      darkSubMenuItemBg: '#0b1220',
      darkItemSelectedBg: '#1677ff',
    },
    Segmented: {
      itemSelectedBg: '#1677ff',
      itemSelectedColor: '#ffffff',
    },
  },
};
