'use client';

import { useTranslations } from 'next-intl';
import { ExpiringMaintenancePanel } from '@/components/partner/ExpiringMaintenancePanel';
import { MaintenanceRenewalsTable } from '@/components/partner/MaintenanceRenewalsTable';

export default function MaintenancePage() {
  const t = useTranslations('partnerMaintenance');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('pageTitle')}</h1>
        <p className="text-muted-foreground mt-2">
          {t('pageDesc')}
        </p>
      </div>

      {/* 即将到期的维护服务 */}
      <ExpiringMaintenancePanel />

      {/* 维护费续费记录 */}
      <div>
        <h2 className="text-2xl font-semibold mb-4">{t('renewalRecords')}</h2>
        <MaintenanceRenewalsTable />
      </div>
    </div>
  );
}
