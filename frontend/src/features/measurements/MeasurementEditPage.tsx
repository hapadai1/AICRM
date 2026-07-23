/**
 * MEAS-002 채촌 입력·수정 (설계서 09 §4.2).
 * 신규는 고객·채촌일·구분을 먼저 입력해 저장할 때 생성한다(유령 세션 방지).
 * 태블릿 가상 숫자 키패드로 치수를 입력하며, 현재 필드를 강조한다.
 */
import { DeleteOutlined, DiffOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { fetchCustomers } from '../../api/customers';
import type { MeasurementFieldDef, MeasurementType, MeasurementValues } from '../../api/measurements';
import {
  MEASUREMENT_FIELDS,
  MEASUREMENT_GROUP_LABELS,
  MEASUREMENT_TYPE_LABELS,
  completeMeasurement,
  createMeasurement,
  deleteMeasurement,
  fetchMeasurement,
  fetchMeasurements,
  reopenMeasurement,
  updateMeasurement,
} from '../../api/measurements';
import { BackButton } from '../../shared/BackButton';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { labelOf, metaOf } from '../../shared/status-meta';
import { MEASUREMENT_STATUS_META } from './meas-meta';
import { NumericKeypad } from './NumericKeypad';

interface FormState {
  measurementDate: string;
  measurementType: MeasurementType;
  /** 화면 입력은 문자열로 다루고 저장 시 숫자/문자로 나눈다 */
  values: Record<string, string>;
  fitPreference: string;
  bodyNotes: string;
  notes: string;
}

/** 채촌 구분 = 채촌을 하게 된 업무 단계 */
const TYPE_OPTIONS: { label: string; value: MeasurementType }[] = [
  { label: '스타일 컨설팅', value: 'INITIAL' },
  { label: '가봉', value: 'FITTING' },
  { label: '수선', value: 'REMEASURE' },
  { label: '기타', value: 'OTHER' },
];

const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  MEASUREMENT_FIELDS.map((f) => [f.key, f.label]),
);

/** 저장 payload: 빈 값은 null로 보내 해당 항목을 삭제한다 (설계서 09 §3.3) */
function toPayloadValues(values: Record<string, string>): MeasurementValues {
  const out: MeasurementValues = {};
  MEASUREMENT_FIELDS.forEach((f) => {
    const raw = (values[f.key] ?? '').trim();
    if (raw === '' || raw === '.') {
      out[f.key] = null;
    } else if (f.kind === 'number') {
      const n = Number(raw);
      out[f.key] = Number.isFinite(n) ? n : null;
    } else {
      out[f.key] = raw;
    }
  });
  return out;
}

function emptyForm(): FormState {
  return {
    measurementDate: dayjs().format('YYYY-MM-DD'),
    measurementType: 'INITIAL',
    values: {},
    fitPreference: '',
    bodyNotes: '',
    notes: '',
  };
}

export function MeasurementEditPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const isNew = id === undefined || id === 'new';

  const [customerId, setCustomerId] = useState(searchParams.get('customerId') ?? '');
  // 계약 목록에서 넘어오면 그 계약의 주문에 채촌을 연결한다 (계약별 채촌 상태 판단 근거).
  const relatedOrderId = searchParams.get('orderId');
  const [customerKeyword, setCustomerKeyword] = useState('');
  const [form, setForm] = useState<FormState | null>(isNew ? emptyForm() : null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const sessionQuery = useQuery({
    queryKey: ['measurements', 'detail', id],
    queryFn: () => fetchMeasurement(id as string),
    enabled: !isNew && !!id,
  });
  const session = sessionQuery.data;

  const customerQuery = useQuery({
    queryKey: ['customers', 'search', customerKeyword],
    queryFn: () => fetchCustomers({ q: customerKeyword || undefined, includeProspect: true, size: 20 }),
    enabled: isNew,
  });

  // 같은 고객의 다른 버전으로 바로 갈아탈 수 있게 버전 목록을 함께 읽는다 (별도 목록 화면 없이).
  const versionsQuery = useQuery({
    queryKey: ['measurements', 'versions', session?.customerId],
    queryFn: () => fetchMeasurements(session?.customerId as string),
    enabled: !isNew && !!session?.customerId,
  });

  // 세션 로드 시 폼 초기화 (백엔드 값은 항목 코드 맵으로 변환되어 온다)
  useEffect(() => {
    if (!session || form) return;
    const values: Record<string, string> = {};
    MEASUREMENT_FIELDS.forEach((f) => {
      const v = session.values[f.key];
      values[f.key] = v === null || v === undefined ? '' : String(v);
    });
    setForm({
      measurementDate: session.measurementDate,
      measurementType: session.measurementType as MeasurementType,
      values,
      fitPreference: session.fitPreference ?? '',
      bodyNotes: session.bodyNotes ?? '',
      notes: session.notes ?? '',
    });
  }, [session, form]);

  // 미저장 변경 이탈 경고 (§3.2)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const patch = (partial: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...partial } : f));
    setDirty(true);
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['measurements'] });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('입력값이 없습니다.');
      const created = await createMeasurement({
        customerId,
        measurementDate: form.measurementDate,
        measurementType: form.measurementType,
        relatedOrderId,
      });
      // 값은 생성 직후 저장한다 — 생성 API는 값이 빈 항목을 거부한다.
      return updateMeasurement(created.id, {
        values: toPayloadValues(form.values),
        fitPreference: form.fitPreference.trim() || null,
        bodyNotes: form.bodyNotes.trim() || null,
        notes: form.notes.trim() || null,
      });
    },
    onSuccess: (created) => {
      message.success(`채촌을 등록했습니다. (V${created.versionNo})`);
      setDirty(false);
      void invalidate();
      navigate(`/measurements/${created.id}`, { replace: true });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '채촌 등록에 실패했습니다.'),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!session || !form) throw new Error('저장할 데이터가 없습니다.');
      return updateMeasurement(session.id, {
        measurementDate: form.measurementDate,
        measurementType: form.measurementType,
        values: toPayloadValues(form.values),
        fitPreference: form.fitPreference.trim() || null,
        bodyNotes: form.bodyNotes.trim() || null,
        notes: form.notes.trim() || null,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['measurements', 'detail', id], updated);
      void invalidate();
      setDirty(false);
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '저장에 실패했습니다.'),
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      const saved = await saveMutation.mutateAsync();
      return completeMeasurement(saved.id);
    },
    onSuccess: (completed) => {
      message.success('채촌이 완료 처리되었습니다.');
      queryClient.setQueryData(['measurements', 'detail', id], completed);
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '완료 처리에 실패했습니다.'),
  });

  const reopenMutation = useMutation({
    mutationFn: () => reopenMeasurement(session?.id ?? ''),
    onSuccess: (reopened) => {
      message.success('완료를 해제했습니다. 값을 수정할 수 있습니다.');
      queryClient.setQueryData(['measurements', 'detail', id], reopened);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '완료 해제에 실패했습니다.'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMeasurement(session?.id ?? ''),
    onSuccess: () => {
      message.success('채촌 기록을 삭제했습니다.');
      void invalidate();
      navigate('/measurements');
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '삭제에 실패했습니다.'),
  });

  if (!isNew && (sessionQuery.isLoading || !form || !session)) {
    if (sessionQuery.error) {
      return (
        <Alert
          type="error"
          showIcon
          message="채촌 기록을 불러오지 못했습니다."
          description={sessionQuery.error instanceof ApiError ? sessionQuery.error.message : undefined}
          action={<Button onClick={() => navigate('/measurements')}>채촌 목록으로</Button>}
        />
      );
    }
    return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;
  }
  if (!form) return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;

  // 작업지시서 출력에 쓰인 채촌은 읽기 전용 (설계서 09 §2.1)
  const readOnly = session?.locked ?? false;
  const fieldOrder = MEASUREMENT_FIELDS.map((f) => f.key);

  const moveActive = (delta: number) => {
    if (!activeKey) {
      const first = fieldOrder[0];
      if (first) setActiveKey(first);
      return;
    }
    const idx = fieldOrder.indexOf(activeKey);
    const next = fieldOrder[Math.min(fieldOrder.length - 1, Math.max(0, idx + delta))];
    if (next) setActiveKey(next);
  };

  const handleKeypadPress = (key: string) => {
    if (!activeKey || readOnly) return;
    setForm((f) => {
      if (!f) return f;
      const cur = f.values[activeKey] ?? '';
      let next = cur;
      if (key === '.') {
        if (!cur.includes('.')) next = cur === '' ? '0.' : `${cur}.`;
      } else if (cur.length < 7) {
        next = cur + key;
      }
      if (next === cur) return f;
      return { ...f, values: { ...f.values, [activeKey]: next } };
    });
    setDirty(true);
  };

  const handleKeypadDelete = () => {
    if (!activeKey || readOnly) return;
    setForm((f) => {
      if (!f) return f;
      const cur = f.values[activeKey] ?? '';
      if (cur === '') return f;
      return { ...f, values: { ...f.values, [activeKey]: cur.slice(0, -1) } };
    });
    setDirty(true);
  };

  // 활성 항목이 있을 때 물리 키보드(숫자 키패드 포함)로도 입력을 받는다.
  useEffect(() => {
    if (!activeKey || readOnly) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 검색창 등 실제 입력 요소에 포커스가 있으면 가로채지 않는다.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key >= '0' && e.key <= '9') {
        handleKeypadPress(e.key);
        e.preventDefault();
      } else if (e.key === '.' || e.key === 'Decimal') {
        handleKeypadPress('.');
        e.preventDefault();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        handleKeypadDelete();
        e.preventDefault();
      } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        moveActive(1);
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        moveActive(-1);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        setActiveKey(null);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, readOnly]);

  const confirmDelete = () => {
    if (!session) return;
    modal.confirm({
      title: '이 채촌 기록을 삭제할까요?',
      okText: '삭제',
      okButtonProps: { danger: true },
      cancelText: '취소',
      content: `${session.customerName} · ${session.measurementDate} · V${session.versionNo}`,
      onOk: () => deleteMutation.mutateAsync(),
    });
  };

  const renderField = (def: MeasurementFieldDef) => {
    const value = form.values[def.key] ?? '';
    const active = activeKey === def.key;
    const style: CSSProperties = {
      border: active ? '2px solid #1677ff' : '1px solid #d9d9d9',
      background: readOnly ? '#fafafa' : active ? '#e6f4ff' : '#fff',
      borderRadius: 8,
      padding: '8px 12px',
      minHeight: 56,
      cursor: readOnly ? 'default' : 'pointer',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
    };
    // 문자 항목(사이즈)은 키패드가 아니라 직접 입력한다.
    const textInput = def.kind === 'text' && !readOnly;
    return (
      <div key={def.key} style={style} onClick={() => !readOnly && !textInput && setActiveKey(def.key)}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {def.label}
        </Typography.Text>
        {textInput ? (
          <Input
            variant="borderless"
            style={{ fontSize: 18, padding: 0 }}
            value={value}
            placeholder="입력"
            onFocus={() => setActiveKey(null)}
            onChange={(e) => patch({ values: { ...form.values, [def.key]: e.target.value } })}
          />
        ) : value ? (
          <Typography.Text strong style={{ fontSize: 20 }}>
            {value}
            {def.kind === 'number' ? ' cm' : ''}
          </Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: 18, color: '#bfbfbf' }}>입력</Typography.Text>
        )}
      </div>
    );
  };

  const renderGroup = (group: MeasurementFieldDef['group']) => (
    <Card key={group} title={MEASUREMENT_GROUP_LABELS[group]} size="small" style={{ marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
        {MEASUREMENT_FIELDS.filter((f) => f.group === group).map(renderField)}
      </div>
    </Card>
  );

  const statusMeta = metaOf(MEASUREMENT_STATUS_META, session?.status);
  // 버전 목록은 최신 순으로 온다 — 현재 버전 바로 다음 항목이 직전 버전이다.
  const versions = versionsQuery.data ?? [];
  const currentIndex = versions.findIndex((v) => v.id === session?.id);
  const previousVersion = currentIndex >= 0 ? versions[currentIndex + 1] : undefined;

  return (
    <Row gutter={16}>
      <Col xs={24} lg={15} xl={16}>
        <Card style={{ marginBottom: 16 }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* 머리말 — 고객·계약·버전/상태 한 줄. 아래 입력 필드와 겹치는 정보는 배지로 반복하지 않는다. */}
            <Space align="center" wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              {isNew ? (
                <Space wrap align="center" size="small">
                  <Typography.Title level={4} style={{ margin: 0 }}>
                    신규 채촌
                  </Typography.Title>
                  <Select
                    showSearch
                    style={{ minWidth: 280 }}
                    placeholder="고객 검색 (이름 또는 전화번호) *"
                    value={customerId || undefined}
                    filterOption={false}
                    onSearch={setCustomerKeyword}
                    loading={customerQuery.isLoading}
                    onChange={setCustomerId}
                    options={(customerQuery.data?.data ?? []).map((c) => ({
                      value: c.id,
                      label: `${c.name} (${c.phone})`,
                    }))}
                  />
                </Space>
              ) : (
                <Space wrap align="center" size="small">
                  <Typography.Title level={4} style={{ margin: 0 }}>
                    {session?.customerName}
                  </Typography.Title>
                  <Typography.Text type="secondary">{session?.customerPhone}</Typography.Text>
                  <Tag>{session?.contractNo ?? '계약 미연결'}</Tag>
                  {session?.linkedOrderItems.map((it) => (
                    <Tag key={it.id} color="geekblue">
                      {it.displayName}
                    </Tag>
                  ))}
                </Space>
              )}
              {!isNew && (
                <Space size={4}>
                  <Tag color="blue">V{session?.versionNo}</Tag>
                  <StatusBadge label={statusMeta.label} color={statusMeta.color} />
                </Space>
              )}
            </Space>

            {/* 입력 필드 한 줄 — 채촌일·구분, 그리고 다른 버전으로 갈아타기 */}
            <Space wrap size="middle" align="end">
              <Space direction="vertical" size={4}>
                <Typography.Text type="secondary">채촌일 *</Typography.Text>
                <DatePicker
                  size="large"
                  disabled={readOnly}
                  allowClear={false}
                  value={dayjs(form.measurementDate)}
                  onChange={(d) => d && patch({ measurementDate: d.format('YYYY-MM-DD') })}
                />
              </Space>
              <Space direction="vertical" size={4}>
                <Typography.Text type="secondary">채촌 구분 *</Typography.Text>
                <Segmented
                  size="large"
                  disabled={readOnly}
                  value={form.measurementType}
                  options={TYPE_OPTIONS}
                  onChange={(v) => patch({ measurementType: v as MeasurementType })}
                />
              </Space>
              {!isNew && versions.length > 1 && (
                <Space direction="vertical" size={4}>
                  <Typography.Text type="secondary">버전</Typography.Text>
                  <Select
                    size="large"
                    style={{ minWidth: 300 }}
                    value={session?.id}
                    onChange={(v) => navigate(`/measurements/${v}`)}
                    options={versions.map((v) => ({
                      value: v.id,
                      label: `V${v.versionNo} · ${v.measurementDate} · ${labelOf(
                        MEASUREMENT_TYPE_LABELS,
                        v.measurementType,
                      )} · ${v.completed ? '완료' : '작성중'}`,
                    }))}
                  />
                </Space>
              )}
            </Space>

            {readOnly && (
              <Alert
                type="warning"
                showIcon
                message="작업지시서 출력에 사용된 채촌입니다."
                description="값을 바꾸면 이미 나간 지시서와 어긋나므로 수정·삭제가 잠겨 있습니다. 목록에서 복사해 새 버전을 만들어 주세요."
              />
            )}
            {!readOnly && session?.completed && (
              <Alert
                type="info"
                showIcon
                message="완료된 채촌입니다. 값을 고치려면 완료를 해제한 뒤 저장하세요."
                action={
                  <Can permission="MEASUREMENT_EDIT">
                    <Button
                      size="small"
                      loading={reopenMutation.isPending}
                      onClick={() => reopenMutation.mutate()}
                    >
                      완료 해제
                    </Button>
                  </Can>
                }
              />
            )}

            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              단위: cm (소수 허용) · 값이 없는 항목은 비워 둡니다.
            </Typography.Text>
          </Space>
        </Card>

        {renderGroup('UPPER')}
        {renderGroup('LOWER')}
        {renderGroup('SHIRT')}
        {renderGroup('SHOES')}

        <Card title="기타" size="small" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary">선호핏</Typography.Text>
              <Input
                size="large"
                disabled={readOnly}
                value={form.fitPreference}
                onChange={(e) => patch({ fitPreference: e.target.value })}
                placeholder="예: 슬림 핏 선호, 소매는 짧게"
              />
            </div>
            <div>
              <Typography.Text type="secondary">체형 특이사항</Typography.Text>
              <Input.TextArea
                rows={3}
                disabled={readOnly}
                style={{ fontSize: 16 }}
                value={form.bodyNotes}
                onChange={(e) => patch({ bodyNotes: e.target.value })}
                placeholder="예: 오른쪽 어깨 처짐, 배 부분 여유 필요"
              />
            </div>
            <div>
              <Typography.Text type="secondary">비고</Typography.Text>
              <Input.TextArea
                rows={2}
                disabled={readOnly}
                style={{ fontSize: 16 }}
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            </div>
          </Space>
        </Card>

        {/* 목록·계약 상세 등 여러 경로로 들어오므로 하단에도 이전화면 복귀 버튼을 둔다 */}
        <Card>
          <BackButton />
        </Card>
      </Col>

      <Col xs={24} lg={9} xl={8}>
        <div style={{ position: 'sticky', top: 16 }}>
          <Card
            title={activeKey ? `입력 중: ${labelOf(FIELD_LABELS, activeKey)}` : '항목을 터치해 입력을 시작하세요'}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <NumericKeypad
                onPress={handleKeypadPress}
                onDelete={handleKeypadDelete}
                onPrev={() => moveActive(-1)}
                onNext={() => moveActive(1)}
                onDone={() => setActiveKey(null)}
                disabled={!activeKey || readOnly}
              />

              {isNew ? (
                <Can permission="MEASUREMENT_EDIT">
                  <Button
                    type="primary"
                    size="large"
                    block
                    style={{ height: 56, fontSize: 18 }}
                    icon={<SaveOutlined />}
                    disabled={!customerId}
                    loading={createMutation.isPending}
                    onClick={() => createMutation.mutate()}
                  >
                    등록
                  </Button>
                </Can>
              ) : (
                /* 주요 동작(저장·완료)은 위 한 줄, 보조 동작(비교·삭제)은 아래 한 줄로 묶는다. */
                <Can permission="MEASUREMENT_EDIT">
                  <Space direction="vertical" size="small" style={{ width: '100%' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        size="large"
                        style={{ flex: 1, height: 56, fontSize: 18 }}
                        icon={<SaveOutlined />}
                        disabled={readOnly || session?.completed}
                        loading={saveMutation.isPending && !completeMutation.isPending}
                        onClick={() =>
                          saveMutation.mutate(undefined, {
                            onSuccess: () => message.success('저장되었습니다.'),
                          })
                        }
                      >
                        저장
                      </Button>
                      <Button
                        type="primary"
                        size="large"
                        style={{ flex: 1, height: 56, fontSize: 18 }}
                        disabled={readOnly || session?.completed}
                        loading={completeMutation.isPending}
                        onClick={() => completeMutation.mutate()}
                      >
                        완료
                      </Button>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {previousVersion && (
                        <Button
                          style={{ flex: 1 }}
                          icon={<DiffOutlined />}
                          onClick={() =>
                            navigate(`/measurements/compare?left=${previousVersion.id}&right=${session?.id}`)
                          }
                        >
                          이전 버전과 비교
                        </Button>
                      )}
                      <Button
                        danger
                        style={{ flex: 1 }}
                        icon={<DeleteOutlined />}
                        disabled={readOnly}
                        loading={deleteMutation.isPending}
                        onClick={confirmDelete}
                      >
                        삭제
                      </Button>
                    </div>
                  </Space>
                </Can>
              )}
            </Space>
          </Card>
        </div>
      </Col>
    </Row>
  );
}
