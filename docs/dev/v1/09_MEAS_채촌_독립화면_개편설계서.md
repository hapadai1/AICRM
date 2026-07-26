# MEAS 채촌 독립 화면 개편 설계서 v1.0

- 작성일: 2026-07-21
- 상위 문서: `01_개발실행계획서.md`, `02_구현표준정의서.md`, `04_연동정합화_계약.md`, `08_2차_정합화_계획.md`
- 대상 화면: MEAS-001 채촌 목록 / MEAS-002 채촌 입력·수정 / MEAS-003 채촌 비교
- 대상 코드: `backend/src/modules/measurements/*`, `frontend/src/api/measurements.ts`, `frontend/src/features/measurements/*`

---

## 1. 배경과 문제 정의

채촌(採寸)은 **맞춤 제작 주문의 한 단계**로 설계·구현되었다. 그 결과 현재 화면은 다음 제약을 갖는다.

| # | 현상 | 근거 |
|---|---|---|
| P1 | 채촌 목록이 **고객 단위로만** 열린다. 고객을 먼저 고르지 않으면 아무것도 보이지 않는다 | `GET /customers/:customerId/measurements` 단일 조회 경로만 존재 |
| P2 | 전체 채촌 기록을 **날짜·구분·담당자로 검색할 수단이 없다** | 목록 API에 검색 파라미터 자체가 없음 |
| P3 | **삭제(D)가 없다.** 잘못 만든 세션이 영구히 남는다 | 컨트롤러에 DELETE 라우트 없음 |
| P4 | 완료(COMPLETED)된 세션은 **수정이 전면 차단**된다. 오타 하나도 복사(clone)로만 고칠 수 있어 버전이 불필요하게 늘어난다 | `assertEditable()`이 `completedAt !== null`이면 무조건 거부 |
| P5 | 메뉴상 채촌이 '맞춤 제작' 하위에 있어 **렌탈 고객·상담 단계 고객의 채촌**을 다루는 자리가 없다 | `AppLayout.tsx` 메뉴 트리 |
| P6 | 저장 요청이 백엔드 DTO와 **필드명이 어긋나** 조용히 버려지거나 400이 된다 (`measuredDate`↔`measurementDate`, `type`↔`measurementType`, 값 객체↔값 배열, `preferredFit`↔`fitPreference`, `memo`↔`notes`) | `api/measurements.ts`의 요청부 vs `measurements.dto.ts` |

**개편 목표**: 채촌을 **주문에 종속되지 않은 독립 업무 화면**으로 승격한다. 고객·날짜로 검색하고, 등록·조회·수정·삭제가 모두 가능하며, 한 고객의 여러 채촌 기록을 골라 비교한다. 주문 품목과의 연결(`order_item_measurements`)은 **채촌의 부가 기능**으로 남긴다 — 주문이 채촌을 소유하지 않는다.

### 1.1 확정된 정책 결정

| 항목 | 결정 |
|---|---|
| 메뉴 위치 | **최상위 독립 메뉴 '채촌'** (고객·계약과 동일 레벨). '맞춤 제작' 그룹에서 제거 |
| 완료 세션 수정·삭제 | **작업지시서(work_order_versions)에서 참조되지 않았다면 허용.** 참조되면 잠금 |
| 비교 | **2개 비교 유지.** 단 비교 대상 선택은 항상 **같은 고객의 기록 목록**에서 고른다 |
| 검색 조건 | 고객명·전화번호 키워드(필수 축) + 채촌일 기간 + 구분 + 상태 + (고객 상세에서 진입 시) 고객 고정 |

> 기간 필터는 사용자 요청 원문("고객, 날짜 등으로 검색")에 따라 함께 제공한다.

---

## 2. 도메인 모델 (변경 없음)

스키마 변경은 하지 않는다. 기존 모델이 독립 화면 요구를 이미 충족한다.

```
Customer 1 ── N MeasurementSession ── N MeasurementValue
                     │  (customer_id, version_no) unique
                     │  measurement_date / measurement_type / completed_at
                     │
                     ├── N OrderItemMeasurement  (품목이 "사용 중"인 채촌 = is_current)
                     └── N WorkOrderVersion      (source_measurement_session_id = 출력 근거)
```

- `MeasurementSession.customerId`가 **NOT NULL**, `relatedOrderId`가 **NULLABLE** — 이미 "주문 없이 존재하는 채촌"을 표현할 수 있다. P5의 원인은 스키마가 아니라 화면·API였다.
- **버전(version_no)은 고객 단위 일련번호**다. 채촌을 지워도 번호를 재사용하지 않는다(`max+1` 유지).
- 낙관적 잠금 컬럼(`row_version`)이 없다. 채촌은 태블릿 1인 작업이라 동시 편집 위험이 낮아 **이번 범위에서 추가하지 않는다.** 프런트가 보내던 무의미한 `version` 필드는 제거한다.

### 2.1 잠금(편집 가능) 판정

```
locked  ⇔  work_order_versions에 source_measurement_session_id = 세션ID 인 행이 1건 이상
```

- `locked = false` → 수정·삭제 가능 (완료 여부 무관)
- `locked = true`  → 수정·삭제 거부. `MEASUREMENT_LOCKED` 오류로 "복사 후 새 버전" 안내

품목 연결(`order_item_measurements`)만 있는 경우는 **잠그지 않는다.** 아직 출력물이 나가지 않았으므로 정정이 자유로워야 한다. 다만 삭제 시에는 연결 행을 함께 정리하고, 사용자에게 연결 품목명을 보여 준 뒤 확인받는다.

---

## 3. API 설계

기존 라우트는 유지하고 **2개를 추가, 1개의 정책을 완화**한다.

| 메서드 | 경로 | 권한 | 상태 |
|---|---|---|---|
| GET | `/measurements` | MEASUREMENT_VIEW | **신규** — 전역 검색 목록(페이지네이션) |
| GET | `/measurements/compare?left&right` | MEASUREMENT_VIEW | 유지 |
| GET | `/measurements/:id` | MEASUREMENT_VIEW | 유지 + 응답 보강 |
| POST | `/measurements` | MEASUREMENT_EDIT | **신규** — 고객을 본문으로 받는 생성 |
| POST | `/customers/:customerId/measurements` | MEASUREMENT_EDIT | 유지(하위 호환) |
| PATCH | `/measurements/:id` | MEASUREMENT_EDIT | **정책 완화** — 잠금 아니면 완료 후에도 수정 |
| DELETE | `/measurements/:id` | MEASUREMENT_EDIT | **신규** |
| POST | `/measurements/:id/complete` | MEASUREMENT_EDIT | 유지 |
| POST | `/measurements/:id/reopen` | MEASUREMENT_EDIT | **신규** — 완료 해제(잠금 아닐 때) |
| POST | `/measurements/:id/clone` | MEASUREMENT_EDIT | 유지 |
| PUT | `/order-items/:id/measurement` | MEASUREMENT_EDIT | 유지 |

라우트 선언 순서상 `/measurements/compare`는 `/measurements/:id`보다 **먼저** 선언해야 한다(기존 주석 유지).

### 3.1 `GET /measurements` — 검색 목록

쿼리 (`MeasurementListQueryDto extends PageQueryDto`):

| 파라미터 | 타입 | 설명 |
|---|---|---|
| `q` | string | 고객명 부분일치(대소문자 무시) 또는 전화번호 숫자 부분일치(3자 이상) |
| `customerId` | uuid | 특정 고객으로 고정 (고객 상세 → 채촌 탭 진입) |
| `dateFrom` / `dateTo` | YYYY-MM-DD | 채촌일 범위 (양끝 포함) |
| `type` | INITIAL\|FITTING\|REMEASURE\|OTHER | 구분 |
| `status` | DRAFT\|COMPLETED | `completed_at IS NULL` / `NOT NULL`로 변환 |
| `page`, `size` | number | 기본 1 / 30 |

정렬: `measurement_date DESC, version_no DESC` (같은 날 여러 건이면 최신 버전 먼저).

응답 행 — 목록에서 고객을 식별해야 하므로 **고객 정보를 포함한다**:

```jsonc
{
  "id": "…", "customerId": "…", "customerName": "정우성", "customerPhone": "010-5678-9012",
  "versionNo": 3, "measurementDate": "2026-05-02", "measurementType": "INITIAL",
  "completed": true, "completedAt": "2026-05-02T07:00:00.000Z",
  "staffName": "관리자", "valueCount": 15,
  "linkedOrderItems": [{ "id": "…", "displayName": "정장 #1" }],
  "locked": false, "fitPreference": null, "createdAt": "…"
}
```

`@db.Date` 컬럼은 **`YYYY-MM-DD` 문자열로 직렬화**해서 내려보낸다(08 문서 원인 A 대응).

### 3.2 `POST /measurements` — 생성

```jsonc
{ "customerId": "…", "measurementDate": "2026-07-21", "measurementType": "INITIAL",
  "relatedOrderId": null, "fitPreference": null, "bodyNotes": null, "notes": null, "values": [] }
```

기존 `POST /customers/:customerId/measurements`와 동일 서비스(`create`)를 호출한다. 신규 화면은 고객을 폼에서 고르므로 본문형을 쓴다.

### 3.3 `PATCH /measurements/:id` — 수정

- **잠금 검사만** 수행(완료 여부는 보지 않는다).
- `values` 배열의 한 항목이 `numericValue`/`textValue` **둘 다 null이면 해당 항목을 삭제**한다. 지금은 400을 던져 "값 지우기"가 불가능하다 — 화면에서 입력값을 비우면 지워져야 한다.
- 완료된 세션을 수정하면 감사로그 `reason`에 "완료 후 수정"을 남긴다.

### 3.4 `DELETE /measurements/:id`

1. 세션 조회, 없으면 404
2. `locked`면 `MEASUREMENT_LOCKED` 409 — "작업지시서 출력에 사용된 채촌은 삭제할 수 없습니다"
3. 트랜잭션: `measurement_values` 삭제 → `order_item_measurements` 삭제 → 세션의 `previous_session_id` 역참조(다음 버전들)를 `null`로 끊기 → 세션 삭제
4. 감사로그 `action=DELETE`, `before=삭제 전 상세`

물리 삭제를 택한 이유: 채촌 세션에는 소프트 삭제 컬럼이 없고, 감사로그에 삭제 전 전체 스냅샷(`before`)이 남으므로 추적 가능하다. 잠금 규칙이 "근거로 쓰인 데이터"를 이미 보호한다.

### 3.5 `POST /measurements/:id/reopen`

완료 상태를 되돌린다(`completed_at = null`). 잠금이면 거부. 완료 → 수정 → 재완료 흐름을 화면에서 자연스럽게 만들기 위한 보조 라우트.

### 3.6 `GET /measurements/:id` 응답 보강

화면이 별도 조회 없이 헤더를 그릴 수 있도록 다음을 추가한다: `customerName`, `customerPhone`, `staffName`, `locked`, `linkedOrderItems`, `workOrderVersionCount`.
(현재는 고객명을 얻으려 `GET /customers/:id` 전체 aggregate를 한 번 더 호출한다 — 낭비이자 결합.)

### 3.7 오류 코드

| 코드 | HTTP | 상황 |
|---|---|---|
| `MEASUREMENT_LOCKED` | 409 | 작업지시서 출력에 사용된 세션의 수정·삭제·완료해제 |
| `MEASUREMENT_NOT_COMPLETE` | 409 | 미완료 세션을 품목에 연결 시도 (기존) |
| `VALIDATION_ERROR` | 400 | 값 중복 코드, 잘못된 관련 주문 등 (기존) |
| `CUSTOMER_NOT_FOUND` | 404 | 고객 없음 (기존) |

---

## 4. 화면 설계

### 4.1 MEAS-001 채촌 목록 (`/measurements`) — 전면 재작성

```
┌ 채촌 ─────────────────────────────────────────────── [+ 신규 채촌] ┐
│ [고객명·전화번호 검색] [채촌일 시작~종료] [구분 ▾] [상태 ▾] [검색] [초기화] │
├──────────────────────────────────────────────────────────────────┤
│ ☐ │ 고객        │ 채촌일    │ V │ 구분 │ 상태  │ 담당자 │ 항목 │ 사용 품목 │ 액션      │
│ ☐ │ 정우성 010-… │ 2026-05-02│ 3 │ 최초 │ 완료  │ 관리자 │ 15  │ 정장 #1  │ 수정 삭제 │
│ ☑ │ 정우성 010-… │ 2026-04-11│ 2 │ 가봉 │ 완료  │ 관리자 │ 15  │ -       │ 수정 삭제 │
│ ☑ │ 정우성 010-… │ 2026-03-02│ 1 │ 최초 │ 작성중│ 관리자 │ 12  │ -       │ 수정 삭제 │
├──────────────────────────────────────────────────────────────────┤
│ [선택한 2건 비교]                                    ‹ 1 2 3 ›     │
└──────────────────────────────────────────────────────────────────┘
```

- 고객 미선택 상태에서도 **전체 최신 채촌이 바로 보인다** (P1 해소).
- 체크박스 2건 선택 시 `[비교]` 활성화. **서로 다른 고객을 고르면 비활성 + "같은 고객의 기록만 비교할 수 있습니다" 안내** (백엔드도 동일 규칙으로 거부).
- 행 액션: `수정`(입력 화면), `복사`(새 버전), `삭제`. 잠금 행은 삭제·수정 버튼을 비활성화하고 툴팁으로 사유를 표시한다.
- `?customerId=` 쿼리로 진입하면 고객 필터가 고정되고 상단에 고객 칩이 표시된다(고객 상세에서 넘어오는 경로).
- 삭제는 `Modal.confirm`으로 **고객명·채촌일·버전·연결 품목**을 보여 준 뒤 실행한다.

### 4.2 MEAS-002 채촌 입력·수정 (`/measurements/new`, `/measurements/:id`)

- **신규**: 지금은 목록에서 고객을 고르지 않으면 진입조차 못 하고, 진입 즉시 빈 세션이 DB에 생성된다(유령 레코드). 개편 후에는 **고객 검색 Select + 채촌일 + 구분을 먼저 입력받는 폼**으로 시작하고, 저장을 눌러야 생성한다.
- **수정**: 잠금이 아니면 완료 세션도 편집 가능. 완료 상태면 상단에 "완료된 채촌입니다" 배너 + `[완료 해제]` 버튼을 노출한다.
- 태블릿 숫자 키패드 입력 UX(`NumericKeypad`)는 그대로 유지한다 — 이 부분은 잘 만들어져 있다.
- 하단 액션: `임시 저장` / `완료` / `삭제`(잠금 아닐 때) / `이 고객의 채촌 목록으로`.
- 값 비우기 → 저장 시 해당 항목 삭제(§3.3).

### 4.3 MEAS-003 비교 (`/measurements/compare?left&right`)

- 좌/우 2열 + 차이(diff) 열 유지.
- 상단의 버전 선택 Select는 **해당 고객의 전체 채촌 기록**을 옵션으로 제공한다(`GET /measurements?customerId=…`). 좌우를 자유롭게 교체하고 `[좌우 바꾸기]`를 제공한다.
- 숫자 항목: `+1.5` 증가(빨강 계열)/`-0.5` 감소(파랑 계열)/`0` 무변화(회색). 문자 항목: `변경`/`동일` 태그.
- 백엔드 compare 응답(`items`, `previous/current` 중첩)은 그대로 두고 `api/measurements.ts`가 화면 뷰(`rows`, `leftValue/rightValue`)로 변환한다 — 08 문서 §2.1 방침.

### 4.4 진입 경로 정리

| 위치 | 변경 |
|---|---|
| 사이드바 | '맞춤 제작 > 채촌' **제거**, 최상위 '채촌' **추가**(고객 아래) |
| 고객 상세 '옵션·채촌' 탭 | 채촌 이력 표의 링크를 `/measurements?customerId=…`로 연결 |
| 주문 품목 | '사용 채촌 지정'은 유지(품목→채촌 연결). 채촌 자체의 등록·수정은 채촌 화면에서만 한다 |

---

## 5. 프런트 API 계층 정합화 (P6)

`frontend/src/api/measurements.ts`의 **요청 본문을 백엔드 DTO 기준으로 교체**한다. 응답 변환(매퍼)은 이미 정합화되어 있으므로 유지한다.

| 함수 | 현재 전송 | 변경 후 |
|---|---|---|
| `createMeasurement` | `{measuredDate, type}` | `{customerId, measurementDate, measurementType}` |
| `updateMeasurement` | `{measuredDate, type, values: {코드:값}, preferredFit, memo, version}` | `{measurementDate, measurementType, values: [{measurementCode, numericValue|textValue}], fitPreference, bodyNotes, notes}` |
| `completeMeasurement` | `{version}` | 본문 없음 |
| `cloneMeasurement` | `{type}` | `{measurementType, measurementDate?}` |
| (신규) `fetchMeasurementList` | – | `GET /measurements` + 페이지 응답 매핑 |
| (신규) `deleteMeasurement` | – | `DELETE /measurements/:id` |
| (신규) `reopenMeasurement` | – | `POST /measurements/:id/reopen` |
| `fetchCustomerName` | 고객 aggregate 전체 호출 | **삭제** — 상세 응답의 `customerName` 사용 |

값 배열 변환 규칙: 화면의 `Record<코드, 값>`을 배열로 펼치되, 카탈로그의 `kind`가 `number`면 `numericValue`, `text`면 `textValue`에 싣는다. 빈 값은 둘 다 `null`로 보내 **삭제 의도**를 표현한다.

> `main.ts`의 `forbidNonWhitelisted`가 켜지면(08 문서 §2.3) 이 불일치는 전부 400이 된다. 이번 개편으로 채촌 도메인은 그 전환에 선제 대응된다.

---

## 6. 작업 항목

| # | 영역 | 작업 |
|---|---|---|
| 1 | 백엔드 dto | `MeasurementListQueryDto`, `CreateMeasurementBodyDto`(customerId 포함) 추가 |
| 2 | 백엔드 service | `search()`, `remove()`, `reopen()` 추가 / `assertEditable`→`assertNotLocked` 교체 / 값 삭제 처리 / 상세·목록 응답 보강 |
| 3 | 백엔드 controller | `GET /measurements`, `POST /measurements`, `DELETE /measurements/:id`, `POST /:id/reopen` |
| 4 | 프런트 api | §5 요청 계약 교체 + 목록·삭제·완료해제 함수 |
| 5 | 프런트 화면 | `MeasurementListPage`(신규) / `MeasurementEditPage`(개편) / `MeasurementComparePage`(개편) |
| 6 | 내비게이션 | `AppLayout` 메뉴 이동, `router.tsx` 경로 정리 |
| 7 | 테스트 | `test/backend/measurements.spec.ts` — 완료 후 수정 정책 변경 반영, 검색·삭제·잠금 케이스 추가 |

## 7. 검증 기준 (2026-07-21 실서버 aicrm_dev 확인 완료)

- [x] 고객을 고르지 않고 `/measurements` 진입 시 전체 채촌 목록이 최신 채촌일순으로 보인다
- [x] 고객명("정우성")·전화 일부("7701")·날짜 범위·구분·상태 필터가 각각·조합으로 동작한다
- [x] 신규 채촌을 고객 선택 → 저장까지 만들고(V3 생성), 목록에서 즉시 확인된다
- [x] 완료된 채촌을 수정·완료해제·삭제할 수 있다
- [x] 작업지시서가 출력된 채촌(정우성 2026-05-02)은 수정·삭제·완료해제가 모두 409 `MEASUREMENT_LOCKED`
- [x] 같은 고객의 두 기록 비교 시 항목별 차이 계산(가슴둘레 +2, 소매길이 −0.5), 다른 고객끼리는 목록에서 선택 차단
- [x] 값 입력을 비우고 저장하면 해당 항목이 사라진다
- [x] 백엔드 테스트 `measurements.spec.ts` 17건 전건 통과
