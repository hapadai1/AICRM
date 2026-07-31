/**
 * STAT-001 건수 통계
 *
 * 대시보드는 "오늘 할 일"을 보는 화면이고, 이 화면은 "얼마나 했는지"를 기간으로 세는 화면이다.
 * 필터(단위·기간·분해·품목)는 상단 한 줄에만 두고 모든 카드가 같은 구간을 그린다 —
 * 카드마다 기간이 다르면 카드끼리 비교가 안 되기 때문이다.
 */
import { Col, DatePicker, Row, Segmented, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { StatsGranularity } from '../../api/stats';
import { COMPONENT_TYPE_CODES } from '../../api/code-labels';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { CountChartCard } from './CountChartCard';
import { OptionPopularityCard } from './OptionPopularityCard';
import { RentalPopularityCard } from './RentalPopularityCard';
import { defaultRangeOf, GRANULARITY_LABEL } from './period';
import type { StatsRangeState } from './stats-range';

const DATE_FMT = 'YYYY-MM-DD';

const GRANULARITY_OPTIONS = (['DAY', 'WEEK', 'MONTH'] as StatsGranularity[]).map((g) => ({
  label: `${GRANULARITY_LABEL[g]}별`,
  value: g,
}));

export function StatsPage() {
  const [granularity, setGranularity] = useState<StatsGranularity>('DAY');
  const [{ from, to }, setDates] = useState(() => defaultRangeOf('DAY'));
  const [breakdown, setBreakdown] = useState(true);
  // 인기 옵션은 구성품(상의·하의·베스트·셔츠·구두) 단위로 본다 — 옵션 단계가 부위별로 갈리기 때문이다.
  const [optionComponent, setOptionComponent] = useState(() => COMPONENT_TYPE_CODES[0] ?? 'JACKET');

  const range: StatsRangeState = { granularity, from, to };

  // 단위를 바꾸면 그 단위에 맞는 기본 기간으로 함께 옮긴다 —
  // 일 단위 30일 기간을 월 단위로 보면 칸이 두 개뿐이라 볼 게 없다.
  const changeGranularity = (next: StatsGranularity) => {
    setGranularity(next);
    setDates(defaultRangeOf(next));
  };

  return (
    <PageShell>
      <PageCard>
        <ListToolbar
          filters={
            <>
              <Segmented
                value={granularity}
                onChange={(v) => changeGranularity(v as StatsGranularity)}
                options={GRANULARITY_OPTIONS}
              />
              <DatePicker.RangePicker
                allowClear={false}
                value={[dayjs(from), dayjs(to)]}
                onChange={(values) => {
                  if (!values?.[0] || !values?.[1]) return;
                  setDates({ from: values[0].format(DATE_FMT), to: values[1].format(DATE_FMT) });
                }}
                presets={[
                  { label: '최근 7일', value: [dayjs().subtract(6, 'day'), dayjs()] },
                  { label: '최근 30일', value: [dayjs().subtract(29, 'day'), dayjs()] },
                  { label: '이번 달', value: [dayjs().startOf('month'), dayjs()] },
                  { label: '최근 3개월', value: [dayjs().subtract(3, 'month'), dayjs()] },
                  { label: '올해', value: [dayjs().startOf('year'), dayjs()] },
                ]}
              />
              <Segmented
                value={breakdown ? 'SPLIT' : 'TOTAL'}
                onChange={(v) => setBreakdown(v === 'SPLIT')}
                options={[
                  { label: '합계', value: 'TOTAL' },
                  { label: '구분별', value: 'SPLIT' },
                ]}
              />
            </>
          }
          info={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {from} ~ {to} · {GRANULARITY_LABEL[granularity]} 단위 ·{' '}
              {breakdown ? '구분별로 쪼개 표시' : '합계만 표시'} · 집계 기준은 업무 발생일(등록일 아님)
            </Typography.Text>
          }
        />
      </PageCard>

      {/*
        매출을 건수 앞에 둔다 — "얼마 벌었나"가 먼저 궁금한 숫자다.
        결제 테이블이 없고 거래가 전부 일시불이라(v2 확정) 매출 원천은 확정된 계약 금액이다.
      */}
      <Row gutter={[16, 16]}>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="매출 (계약 금액)"
            hint="계약 확정일 기준 총 계약금액. 구분별로 보면 계약 구분으로 쪼갠다. 일시불이라 계약금·잔금 구분이 없다."
            metric="CONTRACT_AMOUNT"
            range={range}
            form="BAR"
            breakdown={breakdown}
          />
        </Col>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="품목별 매출"
            hint="계약서 품목줄 금액 + 옵션 추가금액('옵션' 항목). 계약 총액은 수기 입력값이라 위 계약 금액과 다를 수 있다."
            metric="CONTRACT_ITEM_AMOUNT"
            range={range}
            form="BAR"
            breakdown={breakdown}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="예약 고객 건수"
            hint="예약일 기준. 구분별로 보면 예약 목적으로 쪼갠다."
            metric="APPOINTMENT"
            range={range}
            form="BAR"
            breakdown={breakdown}
          />
        </Col>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="계약 건수"
            hint="계약 확정일 기준. 구분별로 보면 계약 구분으로 쪼갠다."
            metric="CONTRACT"
            range={range}
            form="BAR"
            breakdown={breakdown}
          />
        </Col>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="계약 품목 건수"
            hint="계약 확정일 기준, 계약서에 담긴 품목 수량 합. 구분별로 보면 품목으로 쪼갠다."
            metric="CONTRACT_ITEM"
            range={range}
            form="BAR"
            breakdown={breakdown}
          />
        </Col>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="수선 건수"
            hint="수선 접수일 기준. 구분별로 보면 수선 구분으로 쪼갠다."
            metric="REPAIR"
            range={range}
            form="BAR"
            breakdown={breakdown}
          />
        </Col>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="제작 입고·출고 건수"
            hint="구성품의 실제 입고일·출고일 기준. 계열이 입고·출고로 고정이라 위 [합계/구분별]과 무관하다."
            metric="PRODUCTION_FLOW"
            range={range}
            form="LINE"
            breakdown={breakdown}
          />
        </Col>
        <Col xs={24} xxl={12}>
          <CountChartCard
            title="렌탈 출고·반납 건수"
            hint="렌탈 배정의 실제 출고일·반납일 기준. 계열이 출고·반납으로 고정이라 위 [합계/구분별]과 무관하다."
            metric="RENTAL_FLOW"
            range={range}
            form="LINE"
            breakdown={breakdown}
          />
        </Col>
        <Col xs={24} xxl={12}>
          <RentalPopularityCard range={range} />
        </Col>
        <Col xs={24}>
          {/*
            구성품 선택은 이 카드 안(헤더 탭)에 둔다. 상단 필터 줄은 모든 카드에 걸리는 값만
            두는 자리인데, 구성품은 이 카드 하나에만 걸리는 축이라 섞이면 오해를 준다.
          */}
          <OptionPopularityCard
            componentType={optionComponent}
            onComponentTypeChange={setOptionComponent}
            range={range}
          />
        </Col>
      </Row>
    </PageShell>
  );
}
