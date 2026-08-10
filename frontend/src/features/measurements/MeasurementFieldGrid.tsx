/**
 * 채촌 항목 카드 한 그룹(상의/하의/셔츠/구두) (2026-08-05 MeasurementEditPage에서 분리).
 * 항목 칸의 강조·인치 환산 표시·문자 항목 직접 입력을 담당한다 — 값·활성 상태는 페이지가 갖는다.
 */
import { Card, Input, Typography } from 'antd';
import type { CSSProperties } from 'react';
import type { MeasurementFieldDef } from '../../api/measurements';
import { MEASUREMENT_FIELDS, MEASUREMENT_GROUP_LABELS, formatInch } from '../../api/measurements';
import type { Unit } from './measurement-form';

export function MeasurementFieldGroup({
  group,
  values,
  activeKey,
  readOnly,
  unit,
  onActivate,
  onChangeText,
  registerRef,
}: {
  group: MeasurementFieldDef['group'];
  values: Record<string, string>;
  activeKey: string | null;
  readOnly: boolean;
  unit: Unit;
  onActivate: (key: string | null) => void;
  onChangeText: (key: string, value: string) => void;
  /** 하단 키패드가 가리지 않도록 스크롤할 때 쓰는 항목 DOM 등록 */
  registerRef: (key: string, el: HTMLDivElement | null) => void;
}) {
  const renderField = (def: MeasurementFieldDef) => {
    const value = values[def.key] ?? '';
    const active = activeKey === def.key;
    // 인치 보기는 파생 표시 전용 — 값은 cm로만 입력받는다 (설계서 v2 05 §3.2).
    const viewOnly = readOnly || unit === 'INCH';
    const style: CSSProperties = {
      border: active ? '2px solid #1677ff' : '1px solid #d9d9d9',
      background: viewOnly ? '#fafafa' : active ? '#e6f4ff' : '#fff',
      borderRadius: 8,
      padding: '8px 12px',
      minHeight: 56,
      cursor: viewOnly ? 'default' : 'pointer',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
    };
    // 문자 항목(사이즈)은 키패드가 아니라 직접 입력한다.
    const textInput = def.kind === 'text' && !viewOnly;
    // 숫자 항목은 폼에 cm로 들어 있으므로 인치 보기에서만 분수로 환산해 렌더한다.
    const numeric = def.kind === 'number' ? Number(value) : NaN;
    const display =
      def.kind === 'number' && unit === 'INCH' && Number.isFinite(numeric) ? formatInch(numeric) : value;
    return (
      <div
        key={def.key}
        ref={(el) => registerRef(def.key, el)}
        style={style}
        onClick={() => !viewOnly && !textInput && onActivate(def.key)}
      >
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {def.label}
        </Typography.Text>
        {textInput ? (
          <Input
            variant="borderless"
            style={{ fontSize: 17, padding: 0 }}
            value={value}
            placeholder="입력"
            onFocus={() => onActivate(null)}
            onChange={(e) => onChangeText(def.key, e.target.value)}
          />
        ) : value ? (
          <Typography.Text strong style={{ fontSize: 20 }}>
            {display}
            {def.kind === 'number' ? (unit === 'INCH' ? ' in' : ' cm') : ''}
          </Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: 18, color: '#bfbfbf' }}>
            {viewOnly ? '-' : '입력'}
          </Typography.Text>
        )}
      </div>
    );
  };

  return (
    <Card key={group} title={MEASUREMENT_GROUP_LABELS[group]} size="small" style={{ marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
        {MEASUREMENT_FIELDS.filter((f) => f.group === group).map(renderField)}
      </div>
    </Card>
  );
}
