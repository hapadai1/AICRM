/**
 * 목록 표 공통 규격 (UI 정리 Phase 1).
 *
 * 화면마다 흩어져 있던 Table 기본값을 한곳으로 모은다.
 *  - size: small/middle 이 섞여 있었다 → middle 로 통일
 *  - scroll: 대부분 { x: 'max-content' } 였지만 빠진 화면이 있었다 → 기본값으로
 *  - 액션 열 잘림: 채촌 목록의 [+ 채촌] 버튼이 화면 밖으로 잘려 보이지 않았다.
 *    액션 열은 오른쪽에 고정해 가로 스크롤과 무관하게 항상 보이게 한다.
 *  - 로딩: 전 화면이 Spin 뿐이라 표가 통째로 사라졌다 나타나며 화면이 튀었다.
 *    첫 로딩은 Skeleton 으로 자리를 잡아 둔다(재조회는 기존대로 표 위에 스피너).
 */
import { Skeleton, Table } from 'antd';
import type { TableProps } from 'antd';
import type { ColumnGroupType, ColumnType } from 'antd/es/table';

/** 액션 열로 인식할 컬럼 key */
const ACTION_KEYS = new Set(['actions', 'action']);
/** 액션 열로 인식할 컬럼 제목 */
const ACTION_TITLES = new Set(['액션', '작업']);

function isActionColumn<T>(column: ColumnGroupType<T> | ColumnType<T>): boolean {
  const key = column.key !== undefined ? String(column.key) : '';
  const title = typeof column.title === 'string' ? column.title : '';
  return ACTION_KEYS.has(key) || ACTION_TITLES.has(title);
}

export interface DataTableProps<T> extends TableProps<T> {
  /**
   * 액션 열을 오른쪽에 고정할지. 기본 true.
   * 표가 화면보다 좁아 가로 스크롤이 없는 게 확실하면 꺼도 된다.
   */
  stickyActions?: boolean;
  /** 첫 로딩 때 보여줄 Skeleton 줄 수. 기본 6 */
  skeletonRows?: number;
}

export function DataTable<T extends object>({
  columns,
  loading,
  dataSource,
  stickyActions = true,
  skeletonRows = 6,
  scroll,
  size,
  ...rest
}: DataTableProps<T>) {
  // 첫 로딩(표시할 행이 아직 없음)에서는 표 대신 자리표시자를 그린다.
  // 재조회(행이 이미 있음)는 antd 기본 동작대로 표 위에 스피너를 얹는다.
  const isFirstLoad = !!loading && (dataSource?.length ?? 0) === 0;
  if (isFirstLoad) {
    return <Skeleton active title={false} paragraph={{ rows: skeletonRows, width: '100%' }} />;
  }

  const resolvedColumns = stickyActions
    ? columns?.map((column) =>
        isActionColumn(column) ? { ...column, fixed: 'right' as const } : column,
      )
    : columns;

  return (
    <Table<T>
      size={size ?? 'middle'}
      scroll={scroll ?? { x: 'max-content' }}
      columns={resolvedColumns}
      loading={loading}
      dataSource={dataSource}
      {...rest}
    />
  );
}

/** 목록 표 페이지네이션 기본값 — 페이지 크기 선택지를 화면마다 다르게 두지 않는다. */
export const DEFAULT_PAGE_SIZE = 30;
export const PAGE_SIZE_OPTIONS = [30, 50, 100];
