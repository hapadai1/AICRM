import {
  CheckOutlined,
  FileExcelOutlined,
  HighlightOutlined,
  SaveOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { BackButton } from '../../shared/BackButton';
import { CustomerPickerModal, type PickedCustomer } from '../../shared/CustomerPickerModal';
import {
  confirmContract,
  createContractDraft,
  downloadContractExcel,
  fetchContract,
  fetchContractTypes,
  fetchCustomerSummary,
  getSignature,
  saveSignature,
  updateContractDraft,
  type ContractConfirmResult,
  type ContractDetail,
  type ContractDraftInput,
} from '../../api/contracts';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { ContractLineEditor, createLine, linesTotal, type EditableLine } from './ContractLineEditor';
import { ContractSignPad } from './ContractSignPad';
import { formatKrw, TRANSACTION_TYPE_LABEL, TRANSACTION_TYPE_TAG_COLOR } from './labels';
import { useUnsavedWarning } from './use-unsaved-warning';

/** CONT-002 계약서 작성 — 고객 자동 연결, 계약 구분 기본 품목 복사, 임시저장·계약 확정 */

interface FormValues {
  contractTypeId?: string;
  contractedAt?: Dayjs;
  completionDueDate?: Dayjs;
  photoDate?: Dayjs;
  weddingDate?: Dayjs;
  totalAmount?: number;
  depositAmount?: number;
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
  const [signOpen, setSignOpen] = useState(false);

  // 고객 없이 진입(계약 관리 → 계약서 작성)하면 곧바로 고객 선택 팝업을 띄운다.
  const noCustomer = !customerIdParam && !contractIdParam;
  useEffect(() => {
    if (noCustomer) setPickerOpen(true);
  }, [noCustomer]);

  const handlePickCustomer = (picked: PickedCustomer) => {
    // URL 쿼리에 customerId를 실어 새로고침·뒤로가기에도 연결이 유지되게 한다.
    const next = new URLSearchParams(searchParams);
    next.set('customerId', picked.id);
    setSearchParams(next, { replace: true });
    setPickerOpen(false);
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
      depositAmount: draft.depositAmount,
      // 계약 비고 필드는 백엔드 스키마에 없어 불러오지 않는다 (docs/dev/08 §4).
    });
    // 품목 라인은 최상위가 아니라 현재 버전 아래에 있다 — api/contracts.ts 에서 평면화해 전달한다.
    setLines(
      draft.lines.map((l) =>
        createLine({
          id: l.id,
          transactionType: l.transactionType,
          productCategory: l.productCategory,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          note: l.note,
        }),
      ),
    );
  }, [draft, form]);

  const totalWatch = Form.useWatch('totalAmount', form);
  const depositWatch = Form.useWatch('depositAmount', form);
  const lineTotal = linesTotal(lines);
  const mismatch = lines.length > 0 && typeof totalWatch === 'number' && totalWatch !== lineTotal;
  const balance = (totalWatch ?? 0) - (depositWatch ?? 0);

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
      totalAmount: values.totalAmount ?? 0,
      depositAmount: values.depositAmount ?? 0,
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

  // 서명은 DRAFT 버전에 붙는다 (설계서 v2 03 §2.1). 서명 대상 버전 id·서명 상태를 추적한다.
  const draftVersionId = draftDetail?.versions.find((v) => v.versionStatus === 'DRAFT')?.id;

  const signatureQuery = useQuery({
    queryKey: ['contracts', draftId, 'signature', draftVersionId],
    queryFn: () => getSignature(draftId!, draftVersionId!),
    enabled: !!draftId && !!draftVersionId,
  });

  // 내용을 고치면(임시저장·서명하기가 서버에서 서명을 무효화하므로) 서명을 다시 받아야 한다 → dirty면 미서명 취급.
  const signed = !!signatureQuery.data?.signed && !dirty;
  const invalidateSignature = () =>
    queryClient.invalidateQueries({ queryKey: ['contracts', draftId, 'signature'] });

  const saveMutation = useMutation({
    mutationFn: async () => persistDraft(form.getFieldsValue()),
    onSuccess: (saved) => {
      setDirty(false);
      message.success(`임시 저장되었습니다. (${saved.contractNo})`);
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      // 내용 수정 시 백엔드가 서명을 초기화하므로 서명 상태를 다시 읽는다 (§2.6).
      void invalidateSignature();
    },
    onError: onApiError,
  });

  const signMutation = useMutation({
    mutationFn: (input: { imageDataUrl: string; signerName: string }) =>
      saveSignature(draftId!, draftVersionId!, { ...input, version: draftDetail?.version }),
    onSuccess: () => {
      setSignOpen(false);
      message.success('서명이 저장되었습니다. 계약을 확정할 수 있습니다.');
      void invalidateSignature();
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

  // [서명하기]: 최신 내용을 먼저 저장(서명 대상 버전 확보·이전 서명 무효화)한 뒤 서명 캔버스를 연다.
  const handleOpenSign = async () => {
    const values = await form.validateFields();
    if (lines.length === 0) {
      message.error('품목을 1개 이상 입력해 주세요.');
      return;
    }
    if (!values.totalAmount || values.totalAmount <= 0) {
      message.error('합계 금액을 입력해 주세요.');
      return;
    }
    try {
      await persistDraft(values);
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      void invalidateSignature();
      setSignOpen(true);
    } catch (e) {
      onApiError(e);
    }
  };

  const applyContractType = (typeId: string) => {
    const t = types?.find((x) => x.id === typeId);
    if (!t) return;
    const copyLines = () => {
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
    if (lines.length > 0) {
      modal.confirm({
        title: '기본 품목 복사',
        content: `현재 품목 라인을 '${t.name}'의 기본 품목으로 대체할까요?`,
        okText: '대체',
        cancelText: '현재 품목 유지',
        onOk: copyLines,
      });
    } else {
      copyLines();
    }
  };

  const handleConfirm = () => {
    // 서명이 확정의 전제조건이다 (설계서 v2 03 §2.4). 미서명이면 백엔드가 CONTRACT_SIGNATURE_REQUIRED 로 막는다.
    if (!signed) {
      message.error('먼저 [서명하기]로 서명을 완료해 주세요.');
      return;
    }
    modal.confirm({
      title: '계약 확정(계약완료)',
      okText: '계약 확정',
      cancelText: '취소',
      width: 480,
      content: (
        <Flex vertical gap={8}>
          <Typography.Text>
            계약을 확정하면 고객이 계약 고객으로 전환되고, 거래 방식별(맞춤/렌탈) 주문과 수량만큼의 주문
            품목이 생성됩니다. 확정 후 품목·수량 수정은 변경 계약에서만 가능합니다.
          </Typography.Text>
          <Typography.Text>
            품목 {lines.length}건 · 품목 합계 {formatKrw(lineTotal)} · 계약 금액 {formatKrw(totalWatch)}
          </Typography.Text>
          {signatureQuery.data?.signerName && (
            <Typography.Text type="secondary">서명자: {signatureQuery.data.signerName}</Typography.Text>
          )}
          {mismatch && (
            <Alert
              type="warning"
              showIcon
              message={`합계 금액이 품목 합계(${formatKrw(lineTotal)})와 다릅니다. 수기 합계 금액 기준으로 저장됩니다.`}
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
      <Card>
        <Flex justify="space-between" align="center" wrap gap={12}>
          <Space size={12} wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              계약서 작성
            </Typography.Title>
            {signed ? (
              <StatusBadge label="서명 완료" color="green" />
            ) : (
              <StatusBadge label="미서명" color="gold" />
            )}
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
            <Can permission="CONTRACT_SIGN">
              <Button
                icon={<HighlightOutlined />}
                loading={saveMutation.isPending}
                disabled={!customerId}
                onClick={() => void handleOpenSign()}
              >
                {signed ? '다시 서명' : '서명하기'}
              </Button>
            </Can>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              loading={confirmMutation.isPending}
              disabled={!customerId || !signed || saveMutation.isPending}
              onClick={handleConfirm}
            >
              계약완료(확정)
            </Button>
          </Space>
        </Flex>
        {signatureQuery.data?.signed && dirty && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="내용을 변경하면 서명이 초기화됩니다. 저장 후 다시 서명해 주세요."
          />
        )}
      </Card>

      <Card title="고객 정보">
        {customerId ? (
          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }}>
            <Descriptions.Item label="고객명">
              <Space>
                <Typography.Text strong>{customer?.name ?? '조회 중...'}</Typography.Text>
                {customer?.customerStatus === 'PROSPECT' && <Tag color="gold">미계약</Tag>}
                {customer?.customerStatus === 'CONTRACTED' && <Tag color="green">계약 고객</Tag>}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="전화번호">{customer?.phone ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="연결 경로">
              {appointmentId ? <Tag color="blue">예약에서 자동 연결</Tag> : <Tag>고객에서 연결</Tag>}
            </Descriptions.Item>
            {draftId && (
              <Descriptions.Item label="상태">
                <StatusBadge label="작성중(임시저장)" color="gold" />
              </Descriptions.Item>
            )}
          </Descriptions>
        ) : (
          <Alert
            type="info"
            showIcon
            message="고객을 먼저 선택해 주세요"
            description="계약서는 고객을 연결해 작성합니다. 아래 버튼으로 고객을 검색해 선택하세요."
            action={
              <Button type="primary" icon={<UserOutlined />} onClick={() => setPickerOpen(true)}>
                고객 선택
              </Button>
            }
          />
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

        <Card title="품목" style={{ marginBottom: 16 }}>
          <ContractLineEditor
            value={lines}
            onChange={(next) => {
              setLines(next);
              setDirty(true);
            }}
          />
        </Card>

        <Card title="금액">
          <Row gutter={16} align="bottom">
            <Col xs={12} md={5}>
              <Form.Item
                name="totalAmount"
                label="합계 금액(원)"
                rules={[{ required: true, message: '합계 금액을 입력해 주세요.' }]}
              >
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  step={100000}
                  formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={5}>
              <Form.Item name="depositAmount" label="계약금(원)">
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  step={100000}
                  formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={14}>
              <Form.Item label="잔금">
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {formatKrw(balance)}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
                  (합계 − 계약금, 자동 계산)
                </Typography.Text>
              </Form.Item>
            </Col>
          </Row>
          {mismatch && (
            <Alert
              type="warning"
              showIcon
              message={`합계 금액(${formatKrw(totalWatch)})이 품목 합계(${formatKrw(lineTotal)})와 다릅니다.`}
              description="합계 금액은 수기 입력값 기준으로 저장됩니다. 의도한 금액인지 확인해 주세요."
            />
          )}
        </Card>
      </Form>

      {/* 목록·계약 상세 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <Card>
        <BackButton />
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
            계약번호 <Typography.Text strong>{confirmResult?.contractNo}</Typography.Text> · 고객 상태가 계약
            고객(CONTRACTED)으로 전환되었습니다.
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

      {/* 서명 캔버스 — 열 때마다 새로 마운트해 캔버스 크기를 다시 계산한다 */}
      <Modal
        open={signOpen}
        title="계약서 서명"
        footer={null}
        width={680}
        destroyOnClose
        maskClosable={false}
        onCancel={() => setSignOpen(false)}
      >
        {draftVersionId && (
          <ContractSignPad
            defaultSignerName={customer?.name}
            saving={signMutation.isPending}
            onCancel={() => setSignOpen(false)}
            onSave={(imageDataUrl, signerName) => signMutation.mutate({ imageDataUrl, signerName })}
          />
        )}
      </Modal>
    </Flex>
  );
}
