/**
 * 렌탈 검색 팝업 — 스타일 컨설팅 목록의 렌탈 부위 행에서 띄운다.
 *
 * 조작 흐름을 [렌탈 관리 > 렌탈 예약] 화면과 같게 맞췄다 (현업 확정 2026-08-01):
 *   조건(컬러·사이즈·대여 기간) → [검색] → 달력에서 일자별 가용 수 → 날짜 클릭 →
 *   하단에 그 기간 대여 가능한 규격 목록 → [선택].
 * 부위 구분은 팝업이 이미 그 부위 전용이라 필터로 두지 않는다.
 *
 * 결과는 관리코드가 아니라 규격별 가용 수량으로 보여 준다 — 현장에서 실물과 코드가
 * 1:1로 맞지 않아 코드를 골라 봐야 근거가 없다. [선택]을 누르면 그 규격에서 하나를 집는다.
 *
 * 달력·목록은 렌탈 예약과 같은 가용 달력 API를 쓴다. 세션(기간·조건·실물)에는 [선택]을
 * 누를 때 한 번만 쓴다 — 검색만 하고 닫으면 계약에 아무것도 남지 않는다.
 *
 * 날짜 기간잠금(배정)은 계약완료 뒤 생기는 주문을 대상으로 하므로 여기서 하지 않는다 —
 * 렌탈 예약 화면이 계속 담당한다 (설계서 04 §4.3).
 */
import { CheckOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Calendar, DatePicker, Modal, Select, Space, Spin, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import type { RentalCalendarDay, RentalComponentType } from '../../api/rentals';
import {
  fetchAvailabilityCalendar,
  saveRentalLine,
  saveRentalPeriod,
  selectRentalLineItem,
  startRentalSelection,
} from '../../api/rentals';
import { useRentalCodeNames } from './rental-codes';

const { RangePicker } = DatePicker;

interface Props {
  open: boolean;
  contractItemId: string;
  contractItemComponentId: string;
  /** 팝업 제목 — "렌탈 정장 #1 · 상의(자켓)" */
  title: string;
  /** 이 부위의 품목 구분 — 컬러·사이즈 선택지를 그 품목 것만 받아오는 데 쓴다 */
  componentType?: RentalComponentType;
  /** 행에 이미 저장돼 있는 조건 (있으면 초기값으로 채운다) */
  colorCode: string | null;
  sizeCode: string | null;
  selectedInventoryItemId: string | null;
  onClose: () => void;
}

/** 대여 기간 내내 빌려줄 수 있는 규격 한 줄 — 후보 개체를 이 단위로 접는다. */
interface SkuRow {
  color: string;
  size: string;
  count: number;
  /** [선택]에서 쓸 대표 개체 — 어느 것이든 같은 규격이라 첫 번째를 쓴다 */
  pickId: string;
  /** 지금 선택돼 있는 개체가 이 규격에 속하는지 */
  isSelected: boolean;
}

/** 가용 수에 따른 글자색 — 0건은 회색, 소량은 주황, 여유는 초록 (렌탈 예약 달력과 동일). */
function countColor(count: number): string {
  if (count <= 0) return '#bfbfbf';
  if (count <= 2) return '#fa8c16';
  return '#52c41a';
}

/**
 * 기간 전체에 비어 있는 실물만 남겨 규격별로 접는다.
 *
 * 달력 API는 하루 단위 가용 목록을 주므로, 픽업일~반납일의 모든 날짜에 다 있는 실물이
 * 곧 그 기간에 빌려줄 수 있는 실물이다 (렌탈 선택 후보 API와 같은 판정).
 */
function intersectSkus(days: RentalCalendarDay[], selectedId: string | null): SkuRow[] {
  if (days.length === 0) return [];
  const meta = new Map<string, { color: string; size: string }>();
  const perDay: Array<Set<string>> = days.map((day) => {
    const ids = new Set<string>();
    for (const it of day.items) {
      ids.add(it.id);
      meta.set(it.id, { color: it.color, size: it.size });
    }
    return ids;
  });
  // 첫날 가용 실물 중 나머지 날에도 모두 남아 있는 것만 기간 내내 빌려줄 수 있다.
  const survivors = [...perDay[0]].filter((id) => perDay.every((ids) => ids.has(id)));

  const map = new Map<string, SkuRow>();
  for (const id of survivors) {
    const info = meta.get(id);
    if (!info) continue;
    const key = `${info.color}|${info.size}`;
    const row = map.get(key) ?? { color: info.color, size: info.size, count: 0, pickId: id, isSelected: false };
    row.count += 1;
    if (id === selectedId) row.isSelected = true;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size));
}

export function RentalCandidateModal({
  open,
  contractItemId,
  contractItemComponentId,
  title,
  componentType,
  colorCode,
  sizeCode,
  selectedInventoryItemId,
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const codes = useRentalCodeNames(componentType);

  // 검색 조건은 모달 안에서만 들고 있다가 [선택]을 누를 때 한 번에 저장한다 —
  // 검색 단계에서 저장하면 취소하고 닫아도 값이 남고, 기간이 바뀌면 같은 품목의
  // 다른 부위 선택까지 서버가 비운다.
  const [color, setColor] = useState<string | undefined>(colorCode ?? undefined);
  const [size, setSize] = useState<string | undefined>(sizeCode ?? undefined);
  const [period, setPeriod] = useState<[Dayjs, Dayjs] | null>(null);
  /** 달력이 보고 있는 달 겸 선택 날짜 — 날짜를 누르면 그날이 픽업일이 된다 */
  const [calendarValue, setCalendarValue] = useState<Dayjs>(dayjs());
  /** [검색]으로 확정된 조건 — 누르기 전에는 달력을 띄우지 않는다 */
  const [applied, setApplied] = useState<{ color?: string; size?: string } | null>(null);

  // 세션 시작 API는 현재본이 있으면 그대로 돌려준다(멱등) — 목록에서 바로 열어도 안전하다.
  const sessionQuery = useQuery({
    queryKey: ['rental-selection', 'session', contractItemId],
    queryFn: () => startRentalSelection(contractItemId),
    enabled: open && !!contractItemId,
    retry: false,
  });
  const session = sessionQuery.data ?? null;

  // 열 때마다 저장돼 있는 값으로 조건을 되돌린다(닫았다 다시 열면 직전 입력이 남지 않게).
  useEffect(() => {
    if (!open) return;
    setColor(colorCode ?? undefined);
    setSize(sizeCode ?? undefined);
    setApplied(null);
  }, [open, colorCode, sizeCode]);

  useEffect(() => {
    if (!open || !session) return;
    const saved: [Dayjs, Dayjs] | null =
      session.pickupDate && session.returnDueDate
        ? [dayjs(session.pickupDate), dayjs(session.returnDueDate)]
        : null;
    setPeriod(saved);
    setCalendarValue(saved ? saved[0] : dayjs());
    // 기간·컬러·사이즈가 이미 다 정해져 있으면 바로 결과를 보여 준다.
    if (saved && colorCode && sizeCode) setApplied({ color: colorCode, size: sizeCode });
  }, [open, session, colorCode, sizeCode]);

  /** 이 부위에 이미 적혀 있는 비고 — 조건을 저장할 때 함께 넘겨야 지워지지 않는다. */
  const savedNotes = useMemo(
    () =>
      session?.components.find((c) => c.contractItemComponentId === contractItemComponentId)?.notes ?? undefined,
    [session, contractItemComponentId],
  );

  // 달력(월 단위 가용 수) — 렌탈 예약 화면과 같은 API·같은 조건이다.
  const month = calendarValue.startOf('month');
  const monthQuery = useQuery({
    queryKey: [
      'rentals',
      'availability-calendar',
      'modal-month',
      month.format('YYYY-MM'),
      componentType,
      applied?.color,
      applied?.size,
    ],
    queryFn: () =>
      fetchAvailabilityCalendar({
        from: month.format('YYYY-MM-DD'),
        to: month.endOf('month').format('YYYY-MM-DD'),
        componentType,
        color: applied?.color,
        size: applied?.size,
      }),
    enabled: open && !!applied,
  });

  const byDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of monthQuery.data ?? []) map.set(day.date, day.availableCount);
    return map;
  }, [monthQuery.data]);

  // 하단 상세 — 고른 기간(픽업~반납) 내내 비어 있는 규격만 남긴다.
  const periodQuery = useQuery({
    queryKey: [
      'rentals',
      'availability-calendar',
      'modal-period',
      period?.[0].format('YYYY-MM-DD'),
      period?.[1].format('YYYY-MM-DD'),
      componentType,
      applied?.color,
      applied?.size,
    ],
    queryFn: () =>
      fetchAvailabilityCalendar({
        from: period![0].format('YYYY-MM-DD'),
        to: period![1].format('YYYY-MM-DD'),
        componentType,
        color: applied?.color,
        size: applied?.size,
      }),
    enabled: open && !!applied && !!period,
  });

  const skuRows = useMemo(
    () => intersectSkus(periodQuery.data ?? [], selectedInventoryItemId),
    [periodQuery.data, selectedInventoryItemId],
  );

  /** 달력에서 날짜를 누르면 그날이 픽업일 — 반납일은 쓰던 대여 일수를 그대로 유지한다. */
  const onPickDate = (date: Dayjs) => {
    const days = period ? Math.max(period[1].diff(period[0], 'day'), 0) : 1;
    setCalendarValue(date);
    setPeriod([date, date.add(days, 'day')]);
  };

  /**
   * [선택] — 이 팝업의 유일한 저장 지점.
   * 기간(품목 단위) → 조건(부위 단위) → 실물 순서로 써야 한다. 조건 저장은 서버가
   * 실물 선택을 비우므로 실물보다 먼저 가야 하고, 기간도 바뀌면 선택을 비운다.
   * 고른 규격을 그대로 조건으로 적어 두어야 목록이 선택한 물품의 컬러·사이즈를 읽어 쓴다.
   */
  const selectMutation = useMutation({
    mutationFn: async (row: SkuRow) => {
      if (!session) throw new Error('렌탈 선택 세션이 없습니다.');
      if (!period) throw new Error('대여 기간을 선택해 주세요.');
      let detail = session;
      const samePeriod =
        !!detail.pickupDate &&
        !!detail.returnDueDate &&
        dayjs(detail.pickupDate).isSame(period[0], 'day') &&
        dayjs(detail.returnDueDate).isSame(period[1], 'day');
      if (!samePeriod)
        detail = await saveRentalPeriod(detail.sessionId, {
          pickupDate: period[0].format('YYYY-MM-DD'),
          returnDueDate: period[1].format('YYYY-MM-DD'),
        });
      detail = await saveRentalLine(detail.sessionId, contractItemComponentId, {
        colorCode: row.color,
        sizeCode: row.size,
        notes: savedNotes,
      });
      return selectRentalLineItem(detail.sessionId, contractItemComponentId, {
        inventoryItemId: row.pickId,
        version: detail.version,
      });
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(['rental-selection', 'session', contractItemId], detail);
      void queryClient.invalidateQueries({ queryKey: ['rental-selection', 'progress'] });
      message.success('렌탈 재고를 선택했습니다.');
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  /** 선택 해제 — 조건·기간은 그대로 두고 고른 실물만 비운다. */
  const clearMutation = useMutation({
    mutationFn: () =>
      selectRentalLineItem(session!.sessionId, contractItemComponentId, {
        inventoryItemId: null,
        version: session!.version,
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(['rental-selection', 'session', contractItemId], detail);
      void queryClient.invalidateQueries({ queryKey: ['rental-selection', 'progress'] });
      message.success('선택을 해제했습니다.');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const busy = selectMutation.isPending || clearMutation.isPending;

  const columns: ColumnsType<SkuRow> = [
    { title: '컬러', dataIndex: 'color', width: 140, render: (v: string) => codes.colorName(v) },
    { title: '사이즈', dataIndex: 'size', width: 110, render: (v: string) => codes.sizeName(v) },
    {
      title: '가용',
      dataIndex: 'count',
      width: 80,
      align: 'center',
      render: (v: number) => (
        <Typography.Text strong type="success">
          {v}벌
        </Typography.Text>
      ),
    },
    {
      title: '',
      key: 'pick',
      width: 110,
      render: (_, row) =>
        row.isSelected ? (
          <Button size="small" danger loading={busy} onClick={() => clearMutation.mutate()}>
            선택 해제
          </Button>
        ) : (
          <Button
            size="small"
            type="primary"
            icon={<CheckOutlined />}
            loading={busy}
            onClick={() => selectMutation.mutate(row)}
          >
            선택
          </Button>
        ),
    },
  ];

  return (
    <Modal open={open} onCancel={onClose} title={title} width={720} destroyOnHidden footer={null}>
      {sessionQuery.error ? (
        <Alert
          type="error"
          showIcon
          message="렌탈 선택 세션을 열지 못했습니다."
          description={(sessionQuery.error as Error).message}
        />
      ) : sessionQuery.isLoading ? (
        <Spin style={{ display: 'block', margin: '64px auto' }} size="large" />
      ) : (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {/* 조건은 컬러·사이즈가 먼저다 — 날짜는 달력에서도 고를 수 있어 뒤에 둔다. */}
          <Space wrap align="start">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="컬러 전체"
              style={{ width: 160 }}
              loading={codes.isLoading}
              options={codes.colorOptions}
              value={color}
              onChange={setColor}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="사이즈 전체"
              style={{ width: 130 }}
              loading={codes.isLoading}
              options={codes.sizeOptions}
              value={size}
              onChange={setSize}
            />
            <RangePicker
              value={period}
              onChange={(v) => {
                const next = v as [Dayjs, Dayjs] | null;
                setPeriod(next);
                if (next) setCalendarValue(next[0]);
              }}
              placeholder={['픽업일', '반납 예정일']}
            />
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={monthQuery.isFetching}
              onClick={() => setApplied({ color, size })}
            >
              검색
            </Button>
          </Space>

          {applied ? (
            <>
              {/* 달력은 조건에 맞는 실물의 일자별 가용 수만 보여 준다(표시용) —
                  실제 기간잠금은 배정 시점 DB 제약이 막는다. */}
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: '0 8px' }}>
                <Calendar
                  fullscreen={false}
                  value={calendarValue}
                  onPanelChange={(value) => setCalendarValue(value)}
                  onSelect={(date, info) => {
                    if (info?.source === 'date') onPickDate(date);
                    else setCalendarValue(date);
                  }}
                  cellRender={(current, info) => {
                    if (info.type !== 'date') return info.originNode;
                    const count = byDate.get(current.format('YYYY-MM-DD'));
                    if (count === undefined) return null;
                    return (
                      <div style={{ fontSize: 11, lineHeight: '13px', color: countColor(count) }}>{count}</div>
                    );
                  }}
                />
              </div>

              {period ? (
                <>
                  <Typography.Text strong>
                    {period[0].format('YYYY-MM-DD')} → {period[1].format('YYYY-MM-DD')} 대여 가능 재고
                  </Typography.Text>
                  <Table<SkuRow>
                    rowKey={(r) => `${r.color}|${r.size}`}
                    size="small"
                    loading={periodQuery.isLoading}
                    dataSource={skuRows}
                    columns={columns}
                    pagination={false}
                    scroll={{ x: 'max-content', y: 220 }}
                    locale={{ emptyText: '이 기간에 빌려줄 수 있는 재고가 없습니다.' }}
                    rowClassName={(row) => (row.isSelected ? 'ant-table-row-selected' : '')}
                  />
                </>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message="달력에서 날짜를 누르면 그날부터의 대여 가능 재고가 아래에 표시됩니다."
                />
              )}

              {/* 기간은 품목 단위 값이라 같은 품목의 다른 부위 선택도 함께 풀린다 — 미리 알려 준다. */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                대여 기간은 품목 전체에 적용됩니다. 기간을 바꾸면 같은 품목의 다른 부위 선택은 다시
                골라야 합니다.
              </Typography.Text>
            </>
          ) : (
            <Alert
              type="info"
              showIcon
              message="컬러·사이즈(또는 대여 기간)를 정하고 [검색]을 누르면 달력에 일자별 가용 수가 표시됩니다."
            />
          )}
        </Space>
      )}
    </Modal>
  );
}
