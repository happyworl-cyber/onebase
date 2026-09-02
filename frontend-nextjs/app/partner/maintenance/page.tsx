import { ExpiringMaintenancePanel } from '@/components/partner/ExpiringMaintenancePanel';
import { MaintenanceRenewalsTable } from '@/components/partner/MaintenanceRenewalsTable';

export default function MaintenancePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">维护费管理</h1>
        <p className="text-muted-foreground mt-2">
          查看和管理客户的年度维护服务
        </p>
      </div>

      {/* 即将到期的维护服务 */}
      <ExpiringMaintenancePanel />

      {/* 维护费续费记录 */}
      <div>
        <h2 className="text-2xl font-semibold mb-4">维护费续费记录</h2>
        <MaintenanceRenewalsTable />
      </div>
    </div>
  );
}
