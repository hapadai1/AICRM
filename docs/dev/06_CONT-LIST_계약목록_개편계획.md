# CONT-LIST 계약 목록 화면 개편 계획 v1.0

- 작성일: 2026-07-21
- 상위 문서: `docs/dev/01_개발실행계획서.md`, `02_구현표준정의서.md`, `04_연동정합화_계약.md` §3
- 관련 문서: `07_PAY-001_결제화면_개편계획.md` (동일한 문제의식 — 결제 화면 편)
- 대상 화면: 계약 목록 (`/contracts`, 메뉴 "계약·주문")

---

## 1. 문제 정의

| 문제 | 근거 |
|---|---|
| 검색 진입점이 사실상 계약번호 | 검색창 placeholder는 "계약번호·고객명·계약 구분"인데 `ContractsService.list`의 OR는 `contractNo`, `customer.name` **2개뿐**. 계약 구분·전화번호는 검색되지 않는다 |
| 실무 진입점인 **고객·기간**이 없다 | 직원이 아는 것은 "누가, 언제"이지 계약 코드가 아니다. 날짜 조건이 전혀 없어 "이번 달 계약"을 볼 수 없다 |
| 결제 상태를 알 수 없다 | 컬럼에 `계약금`·`잔금`이 있지만 이는 **계약서상 약정액**이지 실제 수납액이 아니다. 실제로 얼마 받았는지·언제 마지막으로 결제했는지는 상세로 들어가야만 보인다 |
| 정렬 기준이 `createdAt desc` 고정 | 계약일과 등록일이 다를 수 있는데 계약일 기준 정렬이 불가 |

> 사용자 피드백 원문: "어차피 시작은 고객으로 되어야 할 거 같은데. 계약 코드만 보고 어떻게 결제를 검색해?"

## 2. 개편 방향

**계약 목록을 "계약·수금 현황 조회 화면"으로 승격한다.** 화면 라우트·권한은 그대로 두고 필터·컬럼·집계를 확장한다.

### 2.1 검색 조건 (필터 바)

| 조건 | UI | 기본값 |
|---|---|---|
| 기간 | 기준 셀렉트 + `RangePicker` | 계약일 기준, 최근 3개월 |
| 기간 기준 `dateField` | `계약일(contractedAt)` / `결제일(paymentDate)` / `완료예정일(completionDueDate)` | `contractedAt` |
| 통합 검색 `q` | Input.Search | 고객명 · 고객 전화(하이픈 무시) · 계약번호 · 계약 구분명 |
| 고객 `customerId` | 고객 상세에서 진입 시 URL로 고정, 화면에 칩으로 표시 | - |
| 계약 구분 `contractTypeId` | Select | 전체 |
| 상태 `status` | Select | 전체(취소 포함) |
| 미수금만 `unpaidOnly` | Checkbox | off |

- 필터 상태는 **URL 쿼리에 동기화**한다(새로고침·뒤로가기·링크 공유 보존).
- `dateField=paymentDate`는 "해당 기간에 결제가 1건이라도 있는 계약"을 뜻한다.

### 2.2 결과 컬럼

```
계약번호 · 고객명(전화) · 계약 구분 · 상태 · 계약일 · 계약금액 · 수납액 · 미수금 · 최근 결제일 · 완료 예정일
```

- **수납액** = `status='COMPLETED'` 결제 합계 − 환불(`REFUND`) 합계
- **미수금** = `계약금액 − 수납액` (음수면 0으로 표시하지 않고 과납으로 표기)
- **최근 결제일** = 완료 결제 중 `max(paymentDate)`, 없으면 `-`
- 미수금 > 0 은 경고색, 0 이하는 기본색 (구현표준 §2 — 색만으로 구분하지 않고 금액 텍스트 병기)
- 정렬: `계약일 desc` 기본. `계약일`·`계약금액`·`미수금` 헤더 정렬 지원(`sort=contractedAt,desc` 형태)
- 행 클릭 → 계약 상세, 계약번호 우측에 결제 바로가기(`/payments?contractId=`) 아이콘

### 2.3 상단 요약

현재 필터 전체 기준(페이지 기준 아님): `건수 · 계약금액 합계 · 수납액 합계 · 미수금 합계`

## 3. 백엔드 변경

### 3.1 `GET /contracts` 확장 (`ContractListQueryDto`)

추가 파라미터: `dateFrom`, `dateTo`(`YYYY-MM-DD`, 양끝 포함), `dateField`(`contractedAt|paymentDate|completionDueDate`, 기본 `contractedAt`), `contractTypeId`(uuid), `unpaidOnly`(boolean), `sort`(`필드,방향`). 기존 `q`/`search`·`customerId`·`status`·`page`·`size`는 유지(하위 호환).

`q` OR 절 확장:

```ts
OR: [
  { contractNo: { contains: q, mode: 'insensitive' } },
  { customer: { name: { contains: q, mode: 'insensitive' } } },
  { customer: { phoneNormalized: { contains: digitsOnly(q) } } },   // 신규
  { contractType: { name: { contains: q, mode: 'insensitive' } } }, // 신규
]
```

숫자만 남긴 값이 빈 문자열이면 전화 조건은 제외한다(전체 매칭 방지).

### 3.2 수납액 계산

Prisma `where`로 표현할 수 없는 집계이므로 **2단계**로 처리한다.

1. 필터·정렬·페이징으로 계약 행을 조회 (`contractedAt`/`completionDueDate` 필터는 where로, `paymentDate` 필터는 `payments: { some: { paymentDate: {gte,lte}, status: 'COMPLETED' } }` 로)
2. 조회된 `contractId` 목록에 대해 `payment.groupBy({ by: ['contractId'], _sum: amount, _max: paymentDate })` 한 번 실행 후 행에 병합

`unpaidOnly`와 `sort=unpaidAmount`는 DB 집계 정렬이 필요하므로 **`$queryRaw` 한 벌**로 계약 id·정렬키를 먼저 구한 뒤 1단계에 `id in (...)`으로 주입한다. 요약(`totals`)도 동일한 where를 쓰는 raw 집계로 계산한다.

응답 — 기존 목록 envelope에 필드 추가 + `totals`:

```jsonc
{
  "data": [{
    "id": "...", "contractNo": "CTR-260721-001",
    "customerId": "...", "customerName": "홍길동", "customerPhone": "010-1234-5678",
    "contractTypeName": "맞춤정장", "status": "CONFIRMED", "currentVersionNo": 1,
    "totalAmount": 3000000, "depositAmount": 500000, "balanceAmount": 2500000,
    "paidAmount": 800000, "unpaidAmount": 2200000, "lastPaymentDate": "2026-07-10",
    "contractedAt": "2026-07-01", "completionDueDate": "2026-09-01"
  }],
  "page": { "number": 1, "size": 30, "totalElements": 12, "totalPages": 1 },
  "totals": { "count": 12, "totalAmount": 36000000, "paidAmount": 12000000, "unpaidAmount": 24000000 }
}
```

`depositAmount`·`balanceAmount`(약정액)는 그대로 두고 `paidAmount`(실수납)를 **별도 필드로 추가**한다 — 기존 화면·문서 04 §3 계약을 깨지 않는다.

### 3.3 인덱스

`payments`는 `@@index([contractId, paymentType])`, `@@index([paymentDate, status])`가 이미 있어 추가 마이그레이션 불필요. 계약 기간 검색은 기존 `@@index([customerId, contractedAt])`으로 커버되지 않는 전체 기간 조회가 생기므로 `@@index([contractedAt(sort: Desc)])` 추가를 검토한다(데이터량 확인 후 결정, 초기에는 생략).

## 4. 프론트엔드 변경

| 파일 | 변경 |
|---|---|
| `api/contracts.ts` | `ContractListItem`에 `customerPhone`·`paidAmount`·`unpaidAmount`·`lastPaymentDate` 추가, `fetchContracts` 파라미터 확장, `ContractListTotals` 타입 신설 |
| `features/contracts/ContractListPage.tsx` | 필터 바(기간 기준+RangePicker·통합검색·계약구분·상태·미수금만) · 요약 카드 4종 · 컬럼 재구성 · URL 쿼리 동기화 |
| `features/contracts/ContractListPage.tsx` | 정렬 핸들러(`onChange`의 sorter → `sort` 파라미터) |

- Query Key: `['contracts', 'list', params]`
- 계약 확정·변경·취소·결제 등록 성공 시 `['contracts']` invalidate (기존 유지)
- 고객 상세의 "계약" 탭에서 `/contracts?customerId=...`로 이동하도록 링크 정비

## 5. 테스트

`test/backend/contracts.spec.ts`에 추가:

1. `dateFrom`/`dateTo`가 계약일 경계일을 포함한다
2. `dateField=paymentDate`가 해당 기간에 결제가 있는 계약만 반환한다
3. `q`로 고객 전화(하이픈 유무 무관)·계약 구분명이 검색된다
4. `paidAmount`가 취소 결제를 제외하고 환불을 차감한다 / `lastPaymentDate`가 최신 결제일이다
5. `unpaidOnly=true`가 미수금 0 이하 계약을 제외한다
6. `totals`가 현재 필터 전체(페이지 무관) 기준이다
7. `sort=contractedAt,asc` 정렬

## 6. 작업 순서

1. 계획서 작성(본 문서) — 사용자 확인
2. 백엔드: DTO 확장 → service(필터·집계·totals) → 컨트롤러 응답 매핑
3. 테스트 추가, 백엔드 전체 회귀 통과 확인
4. 프론트: api 타입/파라미터 → 필터 바 → 요약 카드 → 컬럼·정렬·URL 동기화
5. 실서버 데모 시드로 화면 확인, 문서 갱신(`03_개발체크리스트.md`, `04_연동정합화_계약.md` §3)

## 7. PAY-001과의 관계

| | 계약 목록(`/contracts`) | 결제 목록(`/payments`, 문서 05) |
|---|---|---|
| 행의 단위 | 계약 1건 | 결제 1건 |
| 질문 | "이 고객/이 기간 계약의 수금이 어디까지 왔나" | "이번 달에 얼마 들어왔나" |
| 금액 | 계약금액·수납액·미수금 | 결제 건별 금액·합계 |

두 화면은 중복이 아니라 **세로(계약별 잔액) / 가로(기간별 입금)** 관계다. `q` 검색 규칙(고객명·전화 정규화)과 기간 필터 파라미터 이름(`dateFrom`/`dateTo`)은 두 화면에서 동일하게 맞춘다.

## 8. 범위 밖 (후속 과제)

- 계약 목록 Excel 내보내기
- 저장된 검색 조건(즐겨찾기 필터)
- 미수금 랭킹·수금 독촉 대상 추출 뷰
