import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AdminMasterPage } from '../features/admin/AdminMasterPage';
import { AdminNotificationTemplatesPage } from '../features/admin/AdminNotificationTemplatesPage';
import { AdminOptionsPage } from '../features/admin/AdminOptionsPage';
import { AdminUsersPage } from '../features/admin/AdminUsersPage';
import { AuditLogPage } from '../features/admin/AuditLogPage';
import { AppointmentDetailPage } from '../features/appointments/AppointmentDetailPage';
import { AppointmentPrintPage } from '../features/appointments/AppointmentPrintPage';
import { AppointmentsPage } from '../features/appointments/AppointmentsPage';
import { ContractDetailPage } from '../features/contracts/ContractDetailPage';
import { ContractFormPage } from '../features/contracts/ContractFormPage';
import { ContractListPage } from '../features/contracts/ContractListPage';
import { ContractTypeAdminPage } from '../features/contracts/ContractTypeAdminPage';
import { CustomerDetailPage } from '../features/customers/CustomerDetailPage';
import { CustomersPage } from '../features/customers/CustomersPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { JourneyBoardPage } from '../features/journeys/JourneyBoardPage';
import { MeasurementComparePage } from '../features/measurements/MeasurementComparePage';
import { MeasurementEditPage } from '../features/measurements/MeasurementEditPage';
import { MeasurementListPage } from '../features/measurements/MeasurementListPage';
import { MeasurementPhotoPrint } from '../features/measurements/MeasurementPhotoPrint';
import { NotificationsPage } from '../features/notifications/NotificationsPage';
import { ContractOptionsPage } from '../features/options/ContractOptionsPage';
import { OptionProgressListPage } from '../features/options/OptionProgressListPage';
import { OptionReviewPage } from '../features/options/OptionReviewPage';
import { OptionStagePage } from '../features/options/OptionStagePage';
import { OrderDetailPage } from '../features/orders/OrderDetailPage';
import { ContractProductionPage } from '../features/production/ContractProductionPage';
import { ProductionPage } from '../features/production/ProductionPage';
import { RentalAllocatePage } from '../features/rentals/RentalAllocatePage';
import { RentalHandoverPage } from '../features/rentals/RentalHandoverPage';
import { RentalSelectionPage } from '../features/rentals/RentalSelectionPage';
import { RentalInventoryPage } from '../features/rentals/RentalInventoryPage';
import { RepairsPage } from '../features/repairs/RepairsPage';
import { StatsPage } from '../features/stats/StatsPage';
import { CustomerModeConsultingPage } from '../features/customer-mode/CustomerModeConsultingPage';
import { CustomerModeContractPage } from '../features/customer-mode/CustomerModeContractPage';
import { CustomerModeHomePage } from '../features/customer-mode/CustomerModeHomePage';
import { CustomerModeMeasurementPage } from '../features/customer-mode/CustomerModeMeasurementPage';
import { CustomerSearchPage } from '../features/customer-mode/CustomerSearchPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { AppLayout } from './AppLayout';
import { AuthGuard } from './AuthGuard';
import { CustomerModeGuard } from './CustomerModeGuard';
import { LoginPage } from './LoginPage';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/',
    element: (
      <AuthGuard>
        <AppLayout />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      // 건수 통계 — 기간·단위별 차트 (STAT-001)
      { path: 'stats', element: <StatsPage /> },
      // 예약·고객
      { path: 'appointments', element: <AppointmentsPage /> },
      // 인쇄 전용 화면 — :id보다 먼저 선언해야 한다 (개발설계서 05 G-02)
      { path: 'appointments/print', element: <AppointmentPrintPage /> },
      { path: 'appointments/:id', element: <AppointmentDetailPage /> },
      { path: 'customers', element: <CustomersPage /> },
      { path: 'customers/:id', element: <CustomerDetailPage /> },
      // 진행 현황 — 단계별 칸반 (개발설계서 05 G-11)
      { path: 'journeys', element: <JourneyBoardPage /> },
      // 계약·주문 (new가 :id보다 먼저)
      { path: 'contracts', element: <ContractListPage /> },
      { path: 'contracts/new', element: <ContractFormPage /> },
      { path: 'contracts/:id/options', element: <ContractOptionsPage /> },
      { path: 'contracts/:id/production', element: <ContractProductionPage /> },
      { path: 'contracts/:id', element: <ContractDetailPage /> },
      { path: 'orders/:id', element: <OrderDetailPage /> },
      // 채촌 (독립 화면 — new/compare가 :id보다 먼저)
      { path: 'measurements', element: <MeasurementListPage /> },
      { path: 'measurements/new', element: <MeasurementEditPage /> },
      { path: 'measurements/compare', element: <MeasurementComparePage /> },
      // 채촌 사진 A4 인쇄 전용 화면 (설계서 v2 05 §5). :id보다 먼저 선언.
      { path: 'measurements/:id/print', element: <MeasurementPhotoPrint /> },
      { path: 'measurements/:id', element: <MeasurementEditPage /> },
      // 옵션·작업지시서
      { path: 'options', element: <OptionProgressListPage /> },
      { path: 'options/:contractItemId', element: <OptionStagePage /> },
      { path: 'options/:contractItemId/review', element: <OptionReviewPage /> },
      // 작업지시서 목록은 제작 관리로 통합됨 — 구 링크는 리다이렉트. 미리보기/출력 화면은 유지.
      /*
        작업지시서 전용 화면은 없앴다 (현업 확정 2026-08-05) — 확인·출력·업로드를 모두
        제작 발주 창에서 하므로 따로 갈 곳이 없다.
      */
      { path: 'work-orders', element: <Navigate to="/production" replace /> },
      { path: 'work-orders/:orderItemId', element: <Navigate to="/production" replace /> },
      // 제작·렌탈·수선
      { path: 'production', element: <ProductionPage /> },
      { path: 'rentals', element: <RentalInventoryPage /> },
      { path: 'rentals/allocate', element: <RentalAllocatePage /> },
      { path: 'rentals/handover', element: <RentalHandoverPage /> },
      // 렌탈 스타일 선택(컨설팅) — 품목 단위. :id보다 먼저 선언.
      { path: 'rentals/selection/:contractItemId', element: <RentalSelectionPage /> },
      { path: 'repairs', element: <RepairsPage /> },
      // 연락
      { path: 'notifications', element: <NotificationsPage /> },
      // 관리자
      { path: 'admin/master', element: <AdminMasterPage /> },
      { path: 'admin/contract-types', element: <ContractTypeAdminPage /> },
      { path: 'admin/options', element: <AdminOptionsPage /> },
      { path: 'admin/notification-templates', element: <AdminNotificationTemplatesPage /> },
      { path: 'admin/users', element: <AdminUsersPage /> },
      { path: 'admin/audit', element: <AuditLogPage /> },
      // ── 고객모드 서브트리 (설계서 01 §3.2) ──
      // CustomerModeGuard가 경로↔모드 동기화·컨텍스트 강제·유휴 타임아웃을 담당한다.
      {
        path: 'c',
        element: <CustomerModeGuard />,
        children: [
          { index: true, element: <CustomerSearchPage /> },
          { path: ':customerId', element: <CustomerModeHomePage /> },
          // 흐름 화면: 계약서 → 스타일 컨설팅 → 채촌 (고객모드 딥플로우, 설계서 01 §4)
          { path: ':customerId/contract', element: <CustomerModeContractPage /> },
          { path: ':customerId/consulting', element: <CustomerModeConsultingPage /> },
          { path: ':customerId/measurement', element: <CustomerModeMeasurementPage /> },
        ],
      },
      { path: '*', element: <PlaceholderPage title="페이지를 찾을 수 없습니다" phase={0} /> },
    ],
  },
]);
