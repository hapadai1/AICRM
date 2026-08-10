/**
 * 고객모드 - 고객 검색 (/c). 설계서 01 §4.1.
 *
 * 검색 필드만 노출한다(목록을 미리 그리지 않음 — 타 고객 노출 방지 P2).
 * 결과는 선택용 최소 정보(이름 + 마스킹 전화)만 보이고, 금액·상태 배지는 숨긴다.
 * 결과 없음이면 [신규 고객 등록]으로 유도한다(기존 customers API 재사용).
 */
import { PlusOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Empty, Form, Input, List, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  createCustomer,
  fetchCustomers,
  findCustomerByPhone,
  type CustomerBase,
  type CustomerListItem,
} from '../../api/customers';
import { maskPhone, useModeStore } from '../../app/mode-store';

interface NewCustomerForm {
  name: string;
  phone: string;
}

export function CustomerSearchPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const selectCustomer = useModeStore((s) => s.selectCustomer);

  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [form] = Form.useForm<NewCustomerForm>();

  const { data, isFetching } = useQuery({
    // 계약 전 고객도 찾아야 한다 — 예약만 하고 온 고객이 여기서 빠지면 안 된다.
    queryKey: ['customer-mode', 'search', q],
    queryFn: () => fetchCustomers({ q, scope: 'ALL', size: 20 }),
    enabled: q.length > 0,
  });

  const runSearch = () => setQ(keyword.trim());

  const pick = (c: { id: string; name: string; phone: string }) => {
    selectCustomer(c);
    navigate(`/c/${c.id}`);
  };

  const results = data?.data ?? [];
  const searched = q.length > 0;

  const openRegister = () => {
    const kw = keyword.trim();
    const digits = kw.replace(/\D/g, '');
    // 검색 결과에 이름·전화가 맞는 고객이 있으면 그 정보로 프리필한다(오타로 못 찾은 경우 대비).
    const matched = results.find(
      (c) => c.name === kw || (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits)),
    );
    if (matched) {
      form.setFieldsValue({ name: matched.name, phone: matched.phone });
      setRegisterOpen(true);
      return;
    }
    // 맞는 고객이 없으면 검색어가 숫자 위주면 전화로, 아니면 이름으로 프리필한다.
    const isPhone = digits.length >= 3 && digits.length >= kw.length - 3;
    form.setFieldsValue({
      name: isPhone ? '' : kw,
      phone: isPhone ? kw : '',
    });
    setRegisterOpen(true);
  };

  const submitRegister = async () => {
    let values: NewCustomerForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setRegisterLoading(true);
    try {
      // 같은 전화번호의 고객이 이미 있으면 중복 생성하지 않는다.
      // 예약으로 들어온 고객도 그 시점에 이미 고객으로 등록되므로(설계서 07 D2)
      // 별도 승격 없이 해당 고객으로 이동하면 된다.
      const existing = await findCustomerByPhone(values.phone.trim());
      if (existing) {
        message.info('이미 등록된 고객입니다. 해당 고객으로 이동합니다.');
        setRegisterOpen(false);
        pick({ id: existing.id, name: existing.name, phone: existing.phone });
        return;
      }
      const created: CustomerBase = await createCustomer({
        name: values.name.trim(),
        phone: values.phone.trim(),
      });
      message.success('신규 고객을 등록했습니다.');
      setRegisterOpen(false);
      pick({ id: created.id, name: created.name, phone: created.phone });
    } catch (err) {
      // 전화번호 중복 시 백엔드가 기존 고객 정보를 details로 내려주면 그 고객으로 이동.
      if (err instanceof ApiError && err.code === 'CUSTOMER_PHONE_DUPLICATE') {
        const ex = err.details?.existingCustomer as
          | { id: string; name: string; phone: string }
          | undefined;
        if (ex) {
          message.info('이미 등록된 전화번호입니다. 해당 고객으로 이동합니다.');
          setRegisterOpen(false);
          pick(ex);
          return;
        }
      }
      message.error(err instanceof ApiError ? err.message : '고객 등록에 실패했습니다.');
    } finally {
      setRegisterLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <Card>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          고객 검색
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          고객명 또는 전화번호를 입력하세요.
        </Typography.Paragraph>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="large"
            allowClear
            autoFocus
            placeholder="고객명 또는 전화번호"
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={runSearch}
          />
          <Button size="large" type="primary" onClick={runSearch}>
            검색
          </Button>
        </Space.Compact>

        {searched && (
          <div style={{ marginTop: 20 }}>
            {results.length > 0 ? (
              <List<CustomerListItem>
                loading={isFetching}
                dataSource={results}
                renderItem={(c) => (
                  <List.Item
                    style={{ cursor: 'pointer' }}
                    onClick={() => pick({ id: c.id, name: c.name, phone: c.phone })}
                    actions={[
                      <Button key="select" type="link">
                        선택
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<UserOutlined style={{ fontSize: 20 }} />}
                      title={c.name}
                      description={maskPhone(c.phone)}
                    />
                  </List.Item>
                )}
              />
            ) : (
              !isFetching && (
                <Empty description="검색 결과가 없습니다." style={{ marginTop: 12 }} />
              )
            )}
            <Button
              block
              icon={<PlusOutlined />}
              onClick={openRegister}
              style={{ marginTop: 12 }}
            >
              신규 고객 등록
            </Button>
          </div>
        )}
      </Card>

      <Modal
        title="신규 고객 등록"
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        onOk={submitRegister}
        okText="등록"
        cancelText="취소"
        confirmLoading={registerLoading}
        destroyOnHidden
      >
        <Form<NewCustomerForm> form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="고객명"
            rules={[{ required: true, message: '고객명을 입력해 주세요.' }]}
          >
            <Input placeholder="고객명" />
          </Form.Item>
          <Form.Item
            name="phone"
            label="전화번호"
            rules={[{ required: true, message: '전화번호를 입력해 주세요.' }]}
          >
            <Input placeholder="010-0000-0000" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
