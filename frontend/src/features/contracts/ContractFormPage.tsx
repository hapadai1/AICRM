import {
  CheckOutlined,
  FileExcelOutlined,
  SaveOutlined,
  SkinOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Col,
  DatePicker,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { fetchCustomers } from '../../api/customers';
import { BackButton } from '../../shared/BackButton';
import { CustomerPickerModal, type PickedCustomer } from '../../shared/CustomerPickerModal';
import { CustomerRegisterModal } from '../customers/CustomerRegisterModal';
import { CustomerInfoGateModal, isCustomerInfoIncomplete } from './CustomerInfoGateModal';
import {
  confirmContract,
  createContractDraft,
  downloadContractExcel,
  fetchContract,
  fetchContractTypes,
  fetchCustomerSummary,
  updateContractDraft,
  type ContractConfirmResult,
  type ContractDetail,
  type ContractDraftInput,
} from '../../api/contracts';
import { StatusBadge } from '../../shared/StatusBadge';
import {
  ContractLineEditor,
  createLine,
  linesTotal,
  THOUSANDS,
  type EditableLine,
} from './ContractLineEditor';
import { formatKrw, TRANSACTION_TYPE_LABEL, TRANSACTION_TYPE_TAG_COLOR } from './labels';
import { useUnsavedWarning } from './use-unsaved-warning';

/** CONT-002 계약서 작성 — 고객 자동 연결, 계약 구분 기본 품목 복사, 임시저장·계약 확정 */

interface FormValues {
  contractTypeId?: string;
  contractedAt?: Dayjs;
  completionDueDate?: Dayjs;
  photoDate?: Dayjs;
  weddingDate?: Dayjs;
  /** 품목 합계로 자동 계산된다. [직접 입력]을 켜면 수기 조정(할인 등)도 가능하다. */
  totalAmount?: number;
  note?: string;
}

const fmt = (v?: Dayjs): string | undefined => (v ? v.format('YYYY-MM-DD') : undefined);

export function ContractFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const customerIdParam = searchParams.get('customerId') ?? undefined;
  const appointmentId = searchParams.get('appointmentId') ?? undefined;
  const contractIdParam = searchParams.get('contractId') ?? undefined;

  const [form] = Form.useForm<FormValues>();
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [draftId, setDraftId] = useState<string | undefined>(contractIdParam);
  // 서명 대상 DRAFT 버전 id·낙관적 잠금 값을 얻기 위해 마지막으로 확인된 상세를 보관한다.
  const [draftDetail, setDraftDetail] = useState<ContractDetail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ContractConfirmResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  // 고객 정보 보완 게이트를 통과(저장)했는지. 통과 후 재조회 전까지 모달이 다시 뜨지 않게 잡아둔다.
  const [gateDismissed, setGateDismissed] = useState(false);
  // 상단 고객 선택 필드의 검색어 — 이름·전화번호로 전 고객을 찾는다.
  const [customerKeyword, setCustomerKeyword] = useState('');
  // 합계 금액은 기본이 품목 합계 자동. 할인·에누리가 있을 때만 직접 입력으로 바꾼다.
  const [manualTotal, setManualTotal] = useState(false);
  // 직접 입력이 '초안을 열면서 자동으로' 켜졌는지 — 사용자가 켠 게 아니면 이유를 알려준다.
  const [manualByLoad, setManualByLoad] = useState(false);

  // 고객 없이 진입해도 팝업을 띄우지 않는다 — 계약서 상단의 고객 선택 필드에서 바로 검색한다.
  // 정보가 부족한 고객을 고른 경우에만 보완 팝업(CustomerInfoGateModal)이 이어서 뜬다.
  const selectCustomer = (id: string) => {
    // URL 쿼리에 customerId를 실어 새로고침·뒤로가기에도 연결이 유지되게 한다.
    const next = new URLSearchParams(searchParams);
    next.set('customerId', id);
    setSearchParams(next, { replace: true });
    setPickerOpen(false);
  };

  const handlePickCustomer = (picked: PickedCustomer) => selectCustomer(picked.id);

  /** 고객을 비우고 상단 선택 필드로 되돌린다 (정보 보완을 접고 다른 고객을 고를 때) */
  const resetCustomer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('customerId');
    setSearchParams(next, { replace: true });
    setGateDismissed(false);
    setCustomerKeyword('');
  };

  const { data: types } = useQuery({
    queryKey: ['contract-types', { includeInactive: false }],
    queryFn: () => fetchContractTypes(false),
  });

  const { data: draft } = useQuery({
    queryKey: ['contracts', contractIdParam],
    queryFn: () => fetchContract(contractIdParam!),
    enabled: !!contractIdParam,
  });

  const customerId = customerIdParam ?? draft?.customerId;
  const { data: customer } = useQuery({
    // 고객 상세(fetchcustomer)는 같은 ['customers', id] 키에 aggregate 전체를 캐싱한다.
    // 여기서 같은 키를 쓰면 그 캐시(평면 name 없음)를 읽어 "조회 중..."에서 멈춘다 → 전용 키로 분리한다.
    queryKey: ['customer-summary', customerId],
    queryFn: () => fetchCustomerSummary(customerId!),
    enabled: !!customerId,
  });

  // 고객 선택 필드용 검색 — 고객이 정해지기 전에만 조회한다.
  const customerSearchQuery = useQuery({
    queryKey: ['customers', 'search', customerKeyword],
    queryFn: () => fetchCustomers({ q: customerKeyword || undefined, scope: 'ALL', size: 20 }),
    enabled: !customerId,
  });

  /**
   * 고객 정보 보완 게이트 (설계서 07 §4.3).
   * 신규 작성만 대상이다 — 이어서 작성(?contractId=)은 이미 진행 중인 계약이라 막지 않는다.
   */
  const gateOpen = !contractIdParam && !gateDismissed && !pickerOpen && isCustomerInfoIncomplete(customer);

  // 임시저장된 초안 이어서 작성: 폼·품목 라인 채우기
  useEffect(() => {
    if (!draft) return;
    setDraftId(draft.id);
    setDraftDetail(draft);
    form.setFieldsValue({
      contractTypeId: draft.contractTypeId,
      contractedAt: draft.contractedAt ? dayjs(draft.contractedAt) : undefined,
      completionDueDate: draft.completionDueDate ? dayjs(draft.completionDueDate) : undefined,
      photoDate: draft.photoDate ? dayjs(draft.photoDate) : undefined,
      weddingDate: draft.weddingDate ? dayjs(draft.weddingDate) : undefined,
      totalAmount: draft.totalAmount,
      // 계약 비고 필드는 백엔드 스키마에 없어 불러오지 않는다 (docs/dev/08 §4).
    });
    // 품목 라인은 최상위가 아니라 현재 버전 아래에 있다 — api/contracts.ts 에서 평면화해 전달한다.
    const loaded = draft.lines.map((l) =>
      createLine({
        id: l.id,
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        note: l.note,
      }),
    );
    setLines(loaded);
    // 저장된 합계가 품목 합계와 다르면(할인 등) 수기 값을 지키기 위해 직접 입력 모드로 연다.
    const savedTotal = draft.totalAmount ?? 0;
    const mismatched = savedTotal > 0 && savedTotal !== linesTotal(loaded);
    setManualTotal(mismatched);
    setManualByLoad(mismatched);
  }, [draft, form]);

  const totalWatch = Form.useWatch('totalAmount', form);
  const lineTotal = linesTotal(lines);
  const totalAmount = manualTotal ? (totalWatch ?? 0) : lineTotal;
  /** 직접 입력 합계 − 품목 합계. 음수면 할인, 양수면 추가. */
  const totalDiff = totalAmount - lineTotal;

  // 자동 모드에서는 품목이 바뀔 때마다 합계 금액을 그대로 따라가게 한다.
  useEffect(() => {
    if (!manualTotal) form.setFieldsValue({ totalAmount: lineTotal });
  }, [manualTotal, lineTotal, form]);

  /** 계약 금액을 품목 합계로 되돌리고 자동 모드로 복귀한다(불일치 한 번에 해소). */
  const syncTotalToLines = () => {
    form.setFieldsValue({ totalAmount: lineTotal });
    setManualTotal(false);
    setManualByLoad(false);
    setDirty(true);
  };

  useUnsavedWarning(dirty && !confirmResult);

  const buildPayload = (values: FormValues): ContractDraftInput => {
    const selectedType = types?.find((t) => t.id === values.contractTypeId);
    return {
      customerId: customerId!,
      appointmentId,
      contractTypeId: values.contractTypeId,
      contractTypeName: selectedType?.name ?? draft?.contractTypeName ?? '미지정',
      contractedAt: fmt(values.contractedAt),
      completionDueDate: fmt(values.completionDueDate),
      photoDate: fmt(values.photoDate),
      weddingDate: fmt(values.weddingDate),
      // 자동 모드는 품목 합계를 그대로 보낸다(폼 값 동기화 타이밍에 기대지 않는다).
      totalAmount: manualTotal ? (values.totalAmount ?? 0) : lineTotal,
      note: values.note,
      lines: lines.map((l) => ({
        id: l.id,
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        note: l.note?.trim() || undefined,
      })),
    };
  };

  const persistDraft = async (values: FormValues): Promise<ContractDetail> => {
    const payload = buildPayload(values);
    const saved = draftId ? await updateContractDraft(draftId, payload) : await createContractDraft(payload);
    setDraftId(saved.id);
    setDraftDetail(saved);
    return saved;
  };

  const onApiError = (e: unknown) => {
    message.error(e instanceof ApiError ? e.message : '처리 중 오류가 발생했습니다.');
  };

  const saveMutation = useMutation({
    mutationFn: async () => persistDraft(form.getFieldsValue()),
    onSuccess: (saved) => {
      setDirty(false);
      message.success(`임시 저장되었습니다. (${saved.contractNo})`);
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
    },
    onError: onApiError,
  });

  // 확정은 서명 후 별도 액션이다. 재저장하면 서명이 무효화되므로 여기서는 저장하지 않고 확정만 호출한다.
  const confirmMutation = useMutation({
    mutationFn: async () =>
      confirmContract(draftId!, {
        version: draftDetail?.version ?? 1,
        confirmedDate: fmt(form.getFieldValue('contractedAt')),
      }),
    onSuccess: (result) => {
      setDirty(false);
      setConfirmResult(result);
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: onApiError,
  });

  const excelMutation = useMutation({
    mutationFn: () => downloadContractExcel(draftDetail!.id, draftDetail!.contractNo),
    onError: onApiError,
  });

  /** 계약 구분을 고르면 그 구분의 기본 품목으로 품목 라인을 곧바로 대체한다(확인창 없음). */
  const applyContractType = (typeId: string) => {
    const t = types?.find((x) => x.id === typeId);
    if (!t) return;
    setLines(
      t.lines.map((l) =>
        createLine({
          transactionType: l.transactionType,
          productCategory: l.productCategory,
          quantity: l.defaultQuantity,
        }),
      ),
    );
    setDirty(true);
  };

  const handleConfirm = () => {
    modal.confirm({
      title: '계약서 등록',
      okText: '등록',
      cancelText: '취소',
      width: 480,
      content: (
        <Flex vertical gap={8}>
          <Typography.Text>
            계약서를 등록하면 고객이 계약 고객으로 전환되고, 거래 방식별(맞춤/렌탈) 주문과 수량만큼의 주문
            품목이 생성됩니다. 이후 품목·수량 수정은 변경 계약에서만 가능합니다.
          </Typography.Text>
          <Typography.Text type="secondary">
            다음 순서는 스타일 컨설팅 → 서명 → 계약 완료입니다. 서명은 컨설팅을 모두 확정한 뒤
            계약 상세에서 받습니다.
          </Typography.Text>
          <Typography.Text>
            품목 {lines.length}건 · 품목 합계 {formatKrw(lineTotal)} · 계약 금액 {formatKrw(totalAmount)}
          </Typography.Text>
          {manualTotal && totalDiff !== 0 && (
            <Alert
              type="warning"
              showIcon
              message={`직접 입력한 합계 금액이 품목 합계(${formatKrw(lineTotal)})와 ${formatKrw(
                Math.abs(totalDiff),
              )} 차이납니다. 입력한 금액으로 저장됩니다.`}
            />
          )}
        </Flex>
      ),
      onOk: async () => {
        await confirmMutation.mutateAsync();
      },
    });
  };

  // 확정된 계약을 쿼리로 연 경우: 수정 불가 안내
  if (draft && draft.status !== 'DRAFT') {
    return (
      <Card>
        <Alert
          type="warning"
          showIcon
          message="확정된 계약입니다"
          description="확정 후 품목·수량 수정은 계약 상세의 변경 계약에서만 가능합니다."
          action={
            <Button type="primary" onClick={() => navigate(`/contracts/${draft.id}`)}>
              계약 상세로 이동
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      {/* 작업 표시줄 — 긴 폼에서 스크롤해도 상태·저장·서명 버튼이 따라온다. */}
      <Card
        styles={{ body: { padding: '12px 20px' } }}
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
        }}
      >
        <Flex justify="space-between" align="center" wrap gap={12}>
          <Space size={10} wrap>
            <Typography.Title level={5} style={{ margin: 0 }}>
              계약서 작성
            </Typography.Title>
            {draftDetail?.contractNo && <Tag>{draftDetail.contractNo}</Tag>}
            {dirty && <StatusBadge label="저장 안 됨" color="gold" />}
            <Typography.Text type="secondary">합계 {formatKrw(totalAmount)}</Typography.Text>
          </Space>
          <Space wrap>
            <Button
              icon={<SaveOutlined />}
              loading={saveMutation.isPending}
              disabled={!customerId || confirmMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              임시저장
            </Button>
            <Button
              icon={<FileExcelOutlined />}
              loading={excelMutation.isPending}
              disabled={!draftDetail}
              onClick={() => excelMutation.mutate()}
            >
              Excel 출력
            </Button>
            {/*
              서명은 여기서 받지 않는다. 흐름이 계약서 등록 → 스타일 컨설팅 → 서명 →
              계약 완료로 확정됐다(2026-07-28). 서명·완료는 계약 상세에서 한다.
            */}
            <Button
              type="primary"
              icon={<CheckOutlined />}
              loading={confirmMutation.isPending}
              disabled={!customerId || saveMutation.isPending}
              onClick={handleConfirm}
            >
              계약서 등록
            </Button>
          </Space>
        </Flex>
      </Card>

      <Card>
        {customerId ? (
          <Flex align="center" gap={16} wrap>
            <Avatar size={44} icon={<UserOutlined />} style={{ backgroundColor: '#1677ff' }} />
            <Flex vertical gap={2} flex="1 1 220px">
              <Space size={8} wrap>
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {customer?.name ?? '조회 중...'}
                </Typography.Text>
                {/* 미계약/계약 고객 배지는 제거했다 (설계서 07 D8) */}
                {draftId && <StatusBadge label="작성중(임시저장)" color="gold" />}
              </Space>
              <Space size={8} split={<Typography.Text type="secondary">·</Typography.Text>} wrap>
                <Typography.Text type="secondary">{customer?.phone ?? '-'}</Typography.Text>
                <Typography.Text type="secondary">
                  {appointmentId ? '예약에서 자동 연결' : '고객에서 연결'}
                </Typography.Text>
              </Space>
            </Flex>
            {/* 임시저장 전에만 고객을 바꿀 수 있다 (저장된 초안은 고객이 고정된다). */}
            {!draftId && (
              <Button icon={<UserOutlined />} onClick={resetCustomer}>
                고객 변경
              </Button>
            )}
          </Flex>
        ) : (
          // 고객 선택은 팝업이 아니라 계약서 상단 필드에서 한다.
          // 이름을 넣어 고르면 곧바로 연결되고, 신체 정보가 비어 있을 때만 보완 팝업이 이어진다.
          <Flex vertical gap={8}>
            <Flex align="center" gap={12} wrap>
              <Typography.Text strong>고객</Typography.Text>
              <Select
                showSearch
                autoFocus
                style={{ minWidth: 320, flex: '1 1 320px' }}
                placeholder="고객명 또는 전화번호로 검색"
                suffixIcon={<UserOutlined />}
                filterOption={false}
                notFoundContent={customerSearchQuery.isFetching ? '검색 중...' : '검색 결과가 없습니다.'}
                loading={customerSearchQuery.isFetching}
                onSearch={setCustomerKeyword}
                onChange={(v: string) => selectCustomer(v)}
                options={(customerSearchQuery.data?.data ?? []).map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.phone})`,
                }))}
              />
              <Button onClick={() => setPickerOpen(true)}>목록에서 찾기</Button>
              <Button type="dashed" onClick={() => setRegisterOpen(true)}>
                신규 등록
              </Button>
            </Flex>
            <Typography.Text type="secondary">
              고객을 선택하면 계약서에 연결됩니다. 목록에 없으면 신규 등록으로 바로 만들 수 있고, 작업지시서에 필요한
              정보가 비어 있으면 이어서 입력받습니다.
            </Typography.Text>
          </Flex>
        )}
      </Card>

      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={{ contractedAt: dayjs() }}
        onValuesChange={() => setDirty(true)}
      >
        <Card title="계약 정보" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                name="contractTypeId"
                label="계약 구분"
                rules={[{ required: true, message: '계약 구분을 선택해 주세요.' }]}
              >
                <Select
                  placeholder="계약 구분 선택 (기본 품목 라인 복사)"
                  options={(types ?? []).map((t) => ({ value: t.id, label: t.name }))}
                  onChange={(v: string) => applyContractType(v)}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item
                name="contractedAt"
                label="계약일"
                rules={[{ required: true, message: '계약일을 선택해 주세요.' }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item name="completionDueDate" label="완료 예정일">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item name="photoDate" label="촬영일">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item name="weddingDate" label="예식일">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="비고" style={{ marginBottom: 0 }}>
            <Input.TextArea rows={2} placeholder="계약 특이사항" maxLength={500} />
          </Form.Item>
        </Card>

        <Card
          title="품목"
          extra={
            <Typography.Text type="secondary">
              금액은 수량 × 단가로 자동 계산됩니다 (필요하면 직접 수정)
            </Typography.Text>
          }
          style={{ marginBottom: 16 }}
        >
          <ContractLineEditor
            value={lines}
            onChange={(next) => {
              setLines(next);
              setDirty(true);
            }}
          />
        </Card>

        <Card
          title="금액"
          extra={
            <Space size={8}>
              <Typography.Text type="secondary">직접 입력</Typography.Text>
              <Switch
                size="small"
                checked={manualTotal}
                onChange={(on) => {
                  setManualTotal(on);
                  setManualByLoad(false);
                  // 직접 입력으로 바꿀 땐 현재 자동 합계를 출발값으로 채워 준다.
                  if (on) form.setFieldsValue({ totalAmount: lineTotal });
                  setDirty(true);
                }}
              />
            </Space>
          }
        >
          <Flex vertical gap={12}>
            <Flex justify="space-between" align="flex-end" wrap gap={16}>
              <Flex vertical gap={4}>
                <Typography.Text type="secondary">합계 금액 (계약 금액)</Typography.Text>
                {manualTotal ? (
                  <Form.Item
                    name="totalAmount"
                    style={{ margin: 0 }}
                    rules={[{ required: true, message: '합계 금액을 입력해 주세요.' }]}
                  >
                    <InputNumber
                      className="num-input"
                      size="large"
                      style={{ width: 220, fontWeight: 700 }}
                      min={0}
                      step={100000}
                      formatter={THOUSANDS}
                    />
                  </Form.Item>
                ) : (
                  <Typography.Title level={2} style={{ margin: 0 }}>
                    {formatKrw(lineTotal)}
                  </Typography.Title>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {manualTotal
                    ? `품목 합계 ${formatKrw(lineTotal)} · 품목을 고쳐도 이 금액은 따라가지 않습니다`
                    : `품목 ${lines.length}건 · 수량 ${lines.reduce((s, l) => s + (l.quantity || 0), 0)}개 자동 합계`}
                </Typography.Text>
              </Flex>
              {/* 자동 모드에서도 폼 값은 유지해야 저장·검증이 동작한다. */}
              {!manualTotal && (
                <Form.Item name="totalAmount" hidden noStyle>
                  <InputNumber />
                </Form.Item>
              )}
            </Flex>
            {/*
              불일치는 알리기만 하지 말고 한 번에 고칠 수단을 준다.
              초안을 열며 자동으로 직접 입력이 켜진 경우에는 그 이유부터 밝힌다.
            */}
            {manualTotal && totalDiff !== 0 && (
              <Alert
                type={totalDiff < 0 ? 'info' : 'warning'}
                showIcon
                message={`계약 금액이 품목 합계보다 ${formatKrw(Math.abs(totalDiff))} ${
                  totalDiff < 0 ? '적습니다 (할인)' : '많습니다 (추가)'
                }`}
                description={
                  manualByLoad
                    ? '저장된 계약 금액이 품목 합계와 달라 직접 입력으로 열었습니다. 의도한 금액이면 그대로 두세요.'
                    : '의도한 금액이면 그대로 두세요.'
                }
                action={
                  <Button size="small" onClick={syncTotalToLines}>
                    품목 합계로 맞추기
                  </Button>
                }
              />
            )}
          </Flex>
        </Card>
      </Form>

      {/* 목록·계약 상세 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <Card>
        <Flex justify="space-between" align="center" wrap gap={12}>
          <BackButton />
          {/* 임시저장으로 계약(초안)이 만들어진 뒤에만 스타일 컨설팅으로 이어간다. */}
          <Tooltip
            title={
              !draftId
                ? '먼저 임시저장하면 스타일 컨설팅으로 이어갈 수 있습니다.'
                : dirty
                  ? '변경사항을 임시저장한 뒤 이동할 수 있습니다.'
                  : ''
            }
          >
            <Button
              type="primary"
              icon={<SkinOutlined />}
              disabled={!draftId || dirty}
              onClick={() => draftId && navigate(`/contracts/${draftId}/options`)}
            >
              스타일 컨설팅으로 이동
            </Button>
          </Tooltip>
        </Flex>
      </Card>

      {/* 계약 확정 결과: 생성된 주문 목록 표시 후 주문 상세 이동 */}
      <Modal
        open={!!confirmResult}
        closable={false}
        maskClosable={false}
        title="계약이 확정되었습니다"
        footer={
          <Button type="primary" onClick={() => navigate(`/contracts/${confirmResult?.contractId}`)}>
            계약 상세로 이동
          </Button>
        }
      >
        <Flex vertical gap={12}>
          <Typography.Text>
            계약번호 <Typography.Text strong>{confirmResult?.contractNo}</Typography.Text> 계약이
            확정되었습니다.
          </Typography.Text>
          <Typography.Text strong>생성된 주문</Typography.Text>
          <List
            size="small"
            bordered
            dataSource={confirmResult?.orders ?? []}
            locale={{ emptyText: '생성된 주문이 없습니다.' }}
            renderItem={(o) => (
              <List.Item
                actions={[
                  <Button key="open" type="link" onClick={() => navigate(`/orders/${o.id}`)}>
                    주문 상세
                  </Button>,
                ]}
              >
                <Space>
                  <Tag color={TRANSACTION_TYPE_TAG_COLOR[o.tradeType]}>{TRANSACTION_TYPE_LABEL[o.tradeType]}</Tag>
                  <Typography.Text strong>{o.orderNo}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </Flex>
      </Modal>

      <CustomerPickerModal
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onSelect={handlePickCustomer}
        title="고객 선택 — 계약서 작성"
      />

      {/* 목록에 없는 고객은 여기서 바로 등록하고, 성공하면 곧장 계약서에 연결한다. */}
      <CustomerRegisterModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onGoDetail={(id) => navigate(`/customers/${id}`)}
        onRegistered={(created) => selectCustomer(created.id)}
      />

      {/* 고객 선택 직후 신체 정보가 비어 있으면 채우고 넘어간다 (설계서 07 §4) */}
      {customer && (
        <CustomerInfoGateModal
          open={gateOpen}
          customer={customer}
          onDone={() => setGateDismissed(true)}
          onPickAgain={resetCustomer}
        />
      )}

    </Flex>
  );
}
