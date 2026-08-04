/**
 * 계약 1:1 제작 관리 — 머리글(목록에서 고른 행) + 흐름 두 개(맞춤 | 렌탈).
 *
 * 단계는 계약에 하나씩 서고 그 안에서 품목을 관리한다(2026-08-04 현업 확정).
 * 단계의 원천은 진행(journey) 단계 마스터다 — 제작 발주·가봉 입고·가봉 피팅·완성복 입고/출고,
 * 렌탈 수선 요청·입고·출고·반납이 이미 코드로 정의돼 있고 품목 단위 게이팅과 고객 연락 문구도
 * 그 위에 붙어 있다. 같은 뜻의 단계를 제작 쪽에 또 만들지 않는다.
 *
 * 맞춤과 렌탈은 밟는 단계가 아예 다르므로 좌우로 완전히 갈라 각자의 흐름을 세운다.
 * 한쪽만 있는 계약은 그 흐름이 화면 폭을 다 쓴다.
 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Col, Descriptions, Progress, Row, Space, Typography } from 'antd';
import { useParams } from 'react-router-dom';
import { fetchContract } from '../../api/contracts';
import { fetchCustomerJourneys } from '../../api/journeys';
import { fetchProductionItems } from '../../api/production';
import { BackButton } from '../../shared/BackButton';
import { ProductionFlowCard } from './ProductionFlowCard';
import { ProductionPrepCard } from './ProductionPrepCard';
import {
  DdayTag,
  ReceivedCell,
  WorkOrderCell,
  itemComposition,
  summarizeContract,
} from './production-summary';

export function ContractProductionPage() {
  const { id = '' } = useParams();

  const { data: contract } = useQuery({
    queryKey: ['contracts', id],
    queryFn: () => fetchContract(id),
    enabled: !!id,
  });

  const itemsQuery = useQuery({
    queryKey: ['production', 'items', id],
    queryFn: () => fetchProductionItems(id),
    enabled: !!id,
  });
  const items = itemsQuery.data ?? [];
  const customerId = items[0]?.customerId ?? '';

  // 진행은 주문에 매여 있다 — 계약 안에서 거래유형별로 갈린 주문이 곧 좌·우 흐름이다.
  const journeysQuery = useQuery({
    queryKey: ['journeys', 'customer', customerId],
    queryFn: () => fetchCustomerJourneys(customerId),
    enabled: !!customerId,
  });
  const journeys = journeysQuery.data ?? [];

  if (itemsQuery.error) {
    return (
      <Alert
        type="error"
        showIcon
        message="제작 관리 정보를 불러오지 못했습니다."
        description={(itemsQuery.error as Error).message}
      />
    );
  }

  const summary = summarizeContract(items);
  // 취소 품목은 진행에서 빼고 머리글에서만 알린다 — 단계 안에 두면 할 일처럼 보인다.
  const liveItems = items.filter((i) => i.itemStatus !== 'CANCELLED');
  const cancelledItems = items.filter((i) => i.itemStatus === 'CANCELLED');
  const customItems = liveItems.filter((i) => i.transactionType !== 'RENTAL');
  const rentalItems = liveItems.filter((i) => i.transactionType === 'RENTAL');

  /** 그 흐름의 주문에 걸린 진행 (트랙이 거래유형과 짝) */
  const journeyOf = (track: 'CUSTOM' | 'RENTAL', flowItems: typeof items) =>
    journeys.find(
      (j) => j.trackType === track && flowItems.some((i) => i.orderId === j.orderId),
    ) ?? null;

  // 진행이 없는 흐름은 그리지 않는다 — 계약완료 + 진행이 선 주문만 제작 대상이다.
  const customJourney = journeyOf('CUSTOM', customItems);
  const rentalJourney = journeyOf('RENTAL', rentalItems);
  const showCustom = customItems.length > 0 && !!customJourney;
  const showRental = rentalItems.length > 0 && !!rentalJourney;
  const split = showCustom && showRental;
  // 진행 조회 전에는 "없음"으로 단정하지 않는다(조회 중 빈 안내가 깜빡이는 것을 막는다).
  const journeysLoaded = !!customerId && journeysQuery.isSuccess;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 목록에서 고른 그 행이 머리글에 그대로 나온다 (계산은 production-summary 공유) */}
      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4} style={{ marginBottom: 4 }}>
              제작 관리 — {contract?.customerName ?? ''}
            </Typography.Title>
            <Typography.Text type="secondary">
              {[contract?.customerPhone, contract?.contractNo].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
          <Descriptions size="small" column={3} colon={false}>
            <Descriptions.Item label="품목 구성">
              {itemComposition(summary.categoryCounts) || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="건수">{summary.itemCount}</Descriptions.Item>
            <Descriptions.Item label="완성 예정일">
              <Space size={6}>
                {summary.dueDate ?? <Typography.Text type="secondary">미정</Typography.Text>}
                {summary.dueDate && <DdayTag due={summary.dueDate} />}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="제작 진행률">
              <Progress percent={summary.progressPct} size="small" style={{ width: 140 }} />
            </Descriptions.Item>
            <Descriptions.Item label="입고">
              <ReceivedCell summary={summary} />
            </Descriptions.Item>
            <Descriptions.Item label="작업지시서">
              <WorkOrderCell summary={summary} />
            </Descriptions.Item>
          </Descriptions>
          {cancelledItems.length > 0 && (
            <Typography.Text type="danger">
              취소된 품목 {cancelledItems.length}건 —{' '}
              {cancelledItems.map((i) => i.displayName).join(', ')}
            </Typography.Text>
          )}
        </Space>
      </Card>

      {/*
        준비는 맞춤·렌탈이 똑같이 밟는다 — 계약당 하나로 위에 세우고,
        아래 좌·우 카드에는 트랙마다 갈리는 단계만 남긴다(2026-08-04 현업 확정).
      */}
      {(showCustom || showRental) && (
        <ProductionPrepCard
          items={liveItems}
          contractedAt={contract?.contractedAt}
          contractId={id}
          customerId={customerId}
        />
      )}

      {journeysLoaded && !showCustom && !showRental ? (
        <Card>
          <Typography.Text type="secondary">이 계약에는 제작 대상 품목이 없습니다.</Typography.Text>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {showCustom && (
            <Col span={split ? 12 : 24}>
              <ProductionFlowCard
                title="맞춤 제작"
                trackType="CUSTOM"
                items={customItems}
                journey={customJourney}
              />
            </Col>
          )}
          {showRental && (
            <Col span={split ? 12 : 24}>
              <ProductionFlowCard
                title="렌탈"
                trackType="RENTAL"
                items={rentalItems}
                journey={rentalJourney}
              />
            </Col>
          )}
        </Row>
      )}

      {/* 계약 상세 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <BackButton />
    </Space>
  );
}
