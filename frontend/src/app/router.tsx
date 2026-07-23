import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AdminMasterPage } from '../features/admin/AdminMasterPage';
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
import { NotificationsPage } from '../features/notifications/NotificationsPage';
import { ContractOptionsPage } from '../features/options/ContractOptionsPage';
import { OptionProgressListPage } from '../features/options/OptionProgressListPage';
import { OptionReviewPage } from '../features/options/OptionReviewPage';
import { OptionStagePage } from '../features/options/OptionStagePage';
import { OrderDetailPage } from '../features/orders/OrderDetailPage';
import { PaymentsPage } from '../features/payments/PaymentsPage';
import { ContractProductionPage } from '../features/production/ContractProductionPage';
import { ProductionPage } from '../features/production/ProductionPage';
import { RentalAllocatePage } from '../features/rentals/RentalAllocatePage';
import { RentalHandoverPage } from '../features/rentals/RentalHandoverPage';
import { RentalInventoryPage } from '../features/rentals/RentalInventoryPage';
import { RentalItemDetailPage } from '../features/rentals/RentalItemDetailPage';
import { RepairsPage } from '../features/repairs/RepairsPage';
import { WorkOrderPreviewPage } from '../features/workorders/WorkOrderPreviewPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { AppLayout } from './AppLayout';
import { AuthGuard } from './AuthGuard';
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
      { path: 'measurements/:id', element: <MeasurementEditPage /> },
      // 옵션·작업지시서
      { path: 'options', element: <OptionProgressListPage /> },
      { path: 'options/:orderItemId', element: <OptionStagePage /> },
      { path: 'options/:orderItemId/review', element: <OptionReviewPage /> },
      // 작업지시서 목록은 제작 관리로 통합됨 — 구 링크는 리다이렉트. 미리보기/출력 화면은 유지.
      { path: 'work-orders', element: <Navigate to="/production" replace /> },
      { path: 'work-orders/:orderItemId', element: <WorkOrderPreviewPage /> },
      // 제작·렌탈·수선
      { path: 'production', element: <ProductionPage /> },
      { path: 'rentals', element: <RentalInventoryPage /> },
      { path: 'rentals/allocate', element: <RentalAllocatePage /> },
      { path: 'rentals/handover', element: <RentalHandoverPage /> },
      { path: 'rentals/:id', element: <RentalItemDetailPage /> },
      { path: 'repairs', element: <RepairsPage /> },
      // 결제·연락
      { path: 'payments', element: <PaymentsPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      // 관리자
      { path: 'admin/master', element: <AdminMasterPage /> },
      { path: 'admin/contract-types', element: <ContractTypeAdminPage /> },
      { path: 'admin/options', element: <AdminOptionsPage /> },
      { path: 'admin/users', element: <AdminUsersPage /> },
      { path: 'admin/audit', element: <AuditLogPage /> },
      { path: '*', element: <PlaceholderPage title="페이지를 찾을 수 없습니다" phase={0} /> },
    ],
  },
]);
