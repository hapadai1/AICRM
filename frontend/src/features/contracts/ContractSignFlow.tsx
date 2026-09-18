import { CheckOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Flex, List, Steps, Typography } from 'antd';
import { useState } from 'react';
import { CUSTOMER_CHECKLIST } from '../../api/contracts';
import { ContractSignPad } from './ContractSignPad';

/**
 * 계약서 서명 3단계 (매장 계약서 양식, 2026-09-17).
 *
 * 종이 계약서의 서명 두 줄을 그대로 받는다.
 * 1. 계약담당자 — "위 내용을 전달하였습니다." (로그인 직원이 기본 담당자)
 * 2. 고객 체크리스트 — 양식의 확인 문구 전체 동의
 * 3. 고객 — "위 내용을 이해하였습니다."
 *
 * 세 가지를 모두 받은 뒤에만 한 번에 저장한다(부분 서명본이 생기지 않는다).
 * 부모는 Modal 안에 `destroyOnHidden` 로 렌더해 열 때마다 처음 단계부터 시작하게 한다.
 */

export interface ContractSignResult {
  staffImageDataUrl: string;
  staffSignerName: string;
  checklistAgreed: boolean;
  imageDataUrl: string;
  signerName: string;
}

interface ContractSignFlowProps {
  defaultStaffName?: string;
  defaultCustomerName?: string;
  saving?: boolean;
  onSubmit: (result: ContractSignResult) => void;
  onCancel: () => void;
}

export function ContractSignFlow({
  defaultStaffName,
  defaultCustomerName,
  saving,
  onSubmit,
  onCancel,
}: ContractSignFlowProps) {
  const [step, setStep] = useState(0);
  const [staff, setStaff] = useState<{ imageDataUrl: string; signerName: string } | null>(null);
  const [agreed, setAgreed] = useState(false);

  return (
    <Flex vertical gap={16}>
      <Steps
        size="small"
        current={step}
        items={[{ title: '계약담당자 서명' }, { title: '체크리스트 동의' }, { title: '고객 서명' }]}
      />

      {step === 0 && (
        <ContractSignPad
          key="staff"
          defaultSignerName={staff?.signerName ?? defaultStaffName}
          description="위 내용을 전달하였습니다. — 계약담당자가 서명해 주세요."
          signerLabel="계약담당자"
          saveText="다음"
          onCancel={onCancel}
          onSave={(imageDataUrl, signerName) => {
            setStaff({ imageDataUrl, signerName });
            setStep(1);
          }}
        />
      )}

      {step === 1 && (
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">고객님께 아래 내용을 안내하고 동의를 받아 주세요.</Typography.Text>
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8 }}>
            <List
              size="small"
              dataSource={CUSTOMER_CHECKLIST}
              renderItem={(item) => (
                <List.Item>
                  <Flex gap={8} align="flex-start">
                    <CheckOutlined style={{ color: agreed ? '#52c41a' : '#d9d9d9', marginTop: 4 }} />
                    <Typography.Text style={{ fontSize: 13 }}>{item}</Typography.Text>
                  </Flex>
                </List.Item>
              )}
            />
          </div>
          <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)}>
            <Typography.Text strong>위 고객 체크리스트 내용을 모두 확인했고 동의합니다.</Typography.Text>
          </Checkbox>
          <Flex justify="space-between">
            <Button onClick={() => setStep(0)}>이전</Button>
            <Button type="primary" disabled={!agreed} onClick={() => setStep(2)}>
              다음
            </Button>
          </Flex>
        </Flex>
      )}

      {step === 2 && staff && (
        <Flex vertical gap={12}>
          <Alert
            type="success"
            showIcon
            message={`계약담당자 서명 완료 · ${staff.signerName}  /  체크리스트 동의 완료`}
          />
          <ContractSignPad
            key="customer"
            defaultSignerName={defaultCustomerName}
            description="위 내용을 이해하였습니다. — 고객님이 서명해 주세요. [서명 저장]을 누르면 서명완료가 됩니다."
            signerLabel="고객명"
            saving={saving}
            onCancel={onCancel}
            onSave={(imageDataUrl, signerName) =>
              onSubmit({
                staffImageDataUrl: staff.imageDataUrl,
                staffSignerName: staff.signerName,
                checklistAgreed: agreed,
                imageDataUrl,
                signerName,
              })
            }
          />
        </Flex>
      )}
    </Flex>
  );
}
