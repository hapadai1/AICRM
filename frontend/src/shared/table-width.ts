/**
 * 목록 표 열 폭 자동 조정.
 *
 * 열에 width 를 하나도 주지 않고 열 ellipsis 옵션도 쓰지 않으면 antd(rc-table)는 table-layout 을
 * auto 로 두므로, 브라우저가 실제 값 길이에 맞춰 열 폭을 나눈다. 표에는 scroll={{ x: 'max-content' }} 를
 * 함께 줘야 내용이 넘칠 때만 가로 스크롤이 생기고, 모자랄 때는 min-width:100% 로 컨테이너를 채운다.
 *
 * 열 하나라도 width 를 주면 나머지 열이 그 폭에 끌려다니고, ellipsis: true 는 표 전체를 고정
 * 레이아웃으로 되돌리므로 둘 다 쓰지 않는다. 길이를 못 믿는 텍스트 열은 셀 안에서
 * <Typography.Text ellipsis style={{ maxWidth }}> 로 잘라 열이 무한정 넓어지는 것만 막는다.
 */

/**
 * 값이 중간에 접히지 않게 줄바꿈을 막는다.
 * @param minWidth 값이 제목보다 짧아 열이 지나치게 좁아지는 경우에만 최소 폭(px)을 준다.
 */
export function autoWidth(minWidth?: number) {
  const style = { whiteSpace: 'nowrap' as const, ...(minWidth ? { minWidth } : {}) };
  return { onHeaderCell: () => ({ style }), onCell: () => ({ style }) };
}

/**
 * 값이 길어 열이 무한정 넓어지는 걸 막는다. 셀 안쪽 요소에 상한 폭을 줘서 그 폭을 넘으면 줄을 바꾼다.
 * 열에 width 를 주는 대신 안쪽에서 접으므로 표 레이아웃(auto)은 그대로 둔다.
 * @param maxWidth 이 폭을 넘으면 줄바꿈한다.
 */
export function wrapAt(maxWidth: number) {
  return { whiteSpace: 'normal' as const, maxWidth, display: 'inline-block' as const };
}
