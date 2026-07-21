/**
 * MEAS-002 채촌 입력·수정 (설계서 09 §4.2).
 * 신규는 고객·채촌일·구분을 먼저 입력해 저장할 때 생성한다(유령 세션 방지).
 * 태블릿 가상 숫자 키패드로 치수를 입력하며, 현재 필드를 강조한다.
 */
import { ArrowLeftOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons';
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
  completeMeasurement,
  createMeasurement,
  deleteMeasurement,
  fetchMeasurement,
  reopenMeasurement,
  updateMeasurement,
} from '../../api/measurements';
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

const TYPE_OPTIONS: { label: string; value: MeasurementType }[] = [
  { label: '최초', value: 'INITIAL' },
  { label: '가봉', value: 'FITTING' },
  { label: '재채촌', value: 'REMEASURE' },
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

  return (
    <Row gutter={16}>
      <Col xs={24} lg={15} xl={16}>
        <Card style={{ marginBottom: 16 }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
              <div>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {isNew ? '신규 채촌' : `채촌 입력 — ${session?.customerName} (V${session?.versionNo})`}
                </Typography.Title>
                <Typography.Text type="secondary">
                  단위: cm (소수 허용) · 값이 없는 항목은 비워 둡니다.
                </Typography.Text>
              </div>
              {!isNew && <StatusBadge label={statusMeta.label} color={statusMeta.color} />}
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
                message="완료된 채촌입니다."
                description="값을 고치려면 완료를 해제한 뒤 저장하세요."
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

            <Space wrap size="middle" align="start">
              {isNew ? (
                <Space direction="vertical" size={4}>
                  <Typography.Text type="secondary">고객 *</Typography.Text>
                  <Select
                    showSearch
                    size="large"
                    style={{ minWidth: 280 }}
                    placeholder="고객 검색 (이름 또는 전화번호)"
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
                <Space direction="vertical" size={4}>
                  <Typography.Text type="secondary">고객</Typography.Text>
                  <Space>
                    <Tag color="blue">{session?.customerName}</Tag>
                    <Typography.Text type="secondary">{session?.customerPhone}</Typography.Text>
                  </Space>
                </Space>
              )}
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
            </Space>

            {!isNew && session && session.linkedOrderItems.length > 0 && (
              <Space wrap size={4}>
                <Typography.Text type="secondary">사용 품목:</Typography.Text>
                {session.linkedOrderItems.map((it) => (
                  <Tag key={it.id}>{it.displayName}</Tag>
                ))}
              </Space>
            )}
          </Space>
        </Card>

        {renderGroup('UPPER')}
        {renderGroup('LOWER')}
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
                <Can permission="MEASUREMENT_EDIT">
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Button
                      size="large"
                      block
                      style={{ height: 56, fontSize: 18 }}
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
                      block
                      style={{ height: 56, fontSize: 18 }}
                      disabled={readOnly || session?.completed}
                      loading={completeMutation.isPending}
                      onClick={() => completeMutation.mutate()}
                    >
                      완료
                    </Button>
                    <Button
                      danger
                      size="large"
                      block
                      icon={<DeleteOutlined />}
                      disabled={readOnly}
                      loading={deleteMutation.isPending}
                      onClick={confirmDelete}
                    >
                      삭제
                    </Button>
                  </Space>
                </Can>
              )}

              <Button
                size="large"
                block
                icon={<ArrowLeftOutlined />}
                onClick={() =>
                  navigate(session ? `/measurements?customerId=${session.customerId}` : '/measurements')
                }
              >
                채촌 목록으로
              </Button>
            </Space>
          </Card>
        </div>
      </Col>
    </Row>
  );
}
