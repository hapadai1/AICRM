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
import type { ColumnGroupType, ColumnType, TablePaginationConfig } from 'antd/es/table';

/** 액션 열로 인식할 컬럼 key */
const ACTION_KEYS = new Set(['actions', 'action']);
/** 액션 열로 인식할 컬럼 제목 */
const ACTION_TITLES = new Set(['액션', '작업']);

function isActionColumn<T>(column: ColumnGroupType<T> | ColumnType<T>): boolean {
  const key = column.key !== undefined ? String(column.key) : '';
  const title = typeof column.title === 'string' ? column.title : '';
  return ACTION_KEYS.has(key) || ACTION_TITLES.has(title);
}

/**
 * 남는 가로 공간을 흡수하는 빈 열.
 *
 * 열마다 폭(COL)을 정해 둬도 표는 컨테이너를 채우려 하기 때문에, 남는 자리를 열들에
 * 비례 배분한다 — 그러면 열이 다섯 개인 화면이 열 개인 화면보다 더 벌어져서 폭을 정해 둔
 * 의미가 없어진다. 폭 없는 열을 하나 두면 남는 자리가 전부 그리로 가고 나머지는 선언한
 * 폭 그대로 있는다. 표가 컨테이너보다 넓을 때는 0폭이라 없는 것과 같다.
 */
const SPACER_COLUMN = { key: '__spacer', title: '', render: () => null };

/** 여백 열은 오른쪽 고정(액션) 열 앞에 넣는다 — 뒤에 두면 고정 열과 겹친다. */
function withSpacer<T>(columns: (ColumnGroupType<T> | ColumnType<T>)[]) {
  const firstFixedRight = columns.findIndex((c) => c.fixed === 'right');
  const at = firstFixedRight === -1 ? columns.length : firstFixedRight;
  return [...columns.slice(0, at), SPACER_COLUMN as ColumnType<T>, ...columns.slice(at)];
}

export interface DataTableProps<T> extends TableProps<T> {
  /**
   * 액션 열을 오른쪽에 고정할지. 기본 true.
   * 표가 화면보다 좁아 가로 스크롤이 없는 게 확실하면 꺼도 된다.
   */
  stickyActions?: boolean;
  /** 첫 로딩 때 보여줄 Skeleton 줄 수. 기본 6 */
  skeletonRows?: number;
  /** 총 건수 뒤에 붙일 단위. 기본 '건'(고객 목록은 '명'). */
  totalUnit?: string;
  /**
   * 표를 컨테이너 폭에 맞춰 채우고, 남는 가로 공간을 열들에 비례 배분한다.
   * 값(px)은 열 최소 폭의 합 — 창이 이보다 좁아지면 여기서부터 가로 스크롤로 넘긴다.
   *
   * 기본(미지정) 동작은 여백 열이 남는 공간을 흡수해 열 폭을 고정하는 것이다. 이 옵션을 켜면
   * 여백 열 대신 열들이 남는 폭을 나눠 갖는다 — layout은 여전히 fixed라, 값 길이가 아니라
   * 선언한 폭 비율대로 늘어나므로 검색 결과가 바뀌어도 열이 흔들리지 않는다.
   */
  fillWidth?: number;
}

/**
 * 목록 페이지네이션 공통 규격.
 * 화면은 current/pageSize/total/onChange 같은 데이터만 넘기고,
 * 보이는 모양(총 건수·페이지 크기 선택·상하단 배치)은 여기서 정한다.
 * 화면이 같은 키를 직접 넘기면 그 값이 이긴다(모달 등 예외용).
 */
function withListDefaults(
  config: TablePaginationConfig,
  totalUnit: string,
): TablePaginationConfig {
  return {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    showTotal: (total) => `총 ${total}${totalUnit}`,
    // 건수·페이지 이동을 표 위아래 양쪽에 둔다 — 한 페이지를 다 내려가야 다음 장으로
    // 넘어갈 수 있으면 목록을 훑는 동안 스크롤을 왕복하게 된다.
    position: ['topRight', 'bottomRight'],
    ...config,
  };
}

export function DataTable<T extends object>({
  columns,
  loading,
  dataSource,
  stickyActions = true,
  skeletonRows = 6,
  scroll,
  size,
  tableLayout,
  pagination,
  totalUnit = '건',
  fillWidth,
  sticky,
  ...rest
}: DataTableProps<T>) {
  // 첫 로딩(표시할 행이 아직 없음)에서는 표 대신 자리표시자를 그린다.
  // 재조회(행이 이미 있음)는 antd 기본 동작대로 표 위에 스피너를 얹는다.
  const isFirstLoad = !!loading && (dataSource?.length ?? 0) === 0;
  if (isFirstLoad) {
    return <Skeleton active title={false} paragraph={{ rows: skeletonRows, width: '100%' }} />;
  }

  const fixedColumns = stickyActions
    ? columns?.map((column) =>
        isActionColumn(column) ? { ...column, fixed: 'right' as const } : column,
      )
    : columns;
  // fillWidth를 켜면 여백 열을 두지 않는다 — 남는 폭을 열들이 비례 배분해 채운다.
  const resolvedColumns =
    fillWidth != null || !fixedColumns ? fixedColumns : withSpacer(fixedColumns);
  // fillWidth면 스크롤 기준 폭을 열 최소 폭 합으로 잡아, 창이 넓으면 100%로 채우고
  // 좁아지면 그 폭부터 가로 스크롤한다. 화면이 scroll을 직접 넘기면 그 값이 이긴다.
  const resolvedScroll =
    scroll ?? (fillWidth != null ? { x: fillWidth } : { x: 'max-content' });
  // fillWidth 표는 창이 좁으면 가로 스크롤이 필요하다. antd 일반 표는 모든 행이 스크롤
  // 영역 안에 있어 가로 막대가 표 맨 아래(대개 화면 밖)에 생겨 안 보인다 — sticky를 켜면
  // 막대가 화면 하단에 고정돼 항상 보인다(헤더도 상단 고정). 화면이 sticky를 직접 주면 그 값이 이긴다.
  const resolvedSticky = sticky ?? (fillWidth != null ? true : undefined);

  // pagination={false}(상세화면 안의 보조 표)는 그대로 두고, 목록 표만 규격을 입힌다.
  const resolvedPagination =
    pagination === false || pagination === undefined
      ? pagination
      : withListDefaults(pagination, totalUnit);

  return (
    <Table<T>
      size={size ?? 'middle'}
      // 열 폭(COL)을 선언한 대로 쓰려면 고정 레이아웃이어야 한다. auto로 두면 width는 힌트일 뿐이라
      // 브라우저가 값 길이에 맞춰 다시 나눈다 — 검색 결과가 바뀔 때마다 열이 흔들리던 원인이다.
      tableLayout={tableLayout ?? 'fixed'}
      scroll={resolvedScroll}
      sticky={resolvedSticky}
      columns={resolvedColumns}
      loading={loading}
      dataSource={dataSource}
      pagination={resolvedPagination}
      {...rest}
    />
  );
}

/** 목록 표 페이지네이션 기본값 — 페이지 크기 선택지를 화면마다 다르게 두지 않는다. */
export const DEFAULT_PAGE_SIZE = 30;
export const PAGE_SIZE_OPTIONS = [30, 50, 100];
