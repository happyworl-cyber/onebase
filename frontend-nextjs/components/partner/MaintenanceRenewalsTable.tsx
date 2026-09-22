'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Alert,
  AlertDescription,
  AlertTriangle,
  Badge,
  Button,
  CheckCircle,
  Clock,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Loader2,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  XCircle,
} from '@/components/ui/compat';
import api from '@/lib/api';

interface MaintenanceRenewal {
  id: number;
  license_id: string;
  partner_id: number;
  renewal_year: number;
  period_start: string;
  period_end: string;
  maintenance_price: number;
  commission_rate: number;
  commission_amount: number;
  currency: string;
  payment_status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  paid_at: string | null;
  payment_reference: string | null;
  created_at: string;
  updated_at: string;
  customer_name: string;
  customer_company: string | null;
  edition: string;
}

interface PaginatedResponse {
  renewals: MaintenanceRenewal[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

export function MaintenanceRenewalsTable() {
  const t = useTranslations('partnerMaintRenewals');
  const [renewals, setRenewals] = useState<MaintenanceRenewal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 筛选条件
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // 标记支付对话框
  const [markPaidDialog, setMarkPaidDialog] = useState<{
    open: boolean;
    renewal: MaintenanceRenewal | null;
  }>({ open: false, renewal: null });
  const [paymentReference, setPaymentReference] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 加载数据
  const loadRenewals = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        page_size: '20',
      });

      if (statusFilter !== 'all') {
        params.append('payment_status', statusFilter);
      }

      const response = await api.get<PaginatedResponse>(
        `/api/partner/maintenance/renewals?${params.toString()}`
      );

      setRenewals(response.data.renewals);
      setTotalPages(response.data.pagination.total_pages);
    } catch (err: any) {
      setError(err.message || t('loadFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadRenewals();
  }, [statusFilter, page]);

  // 标记已支付
  const handleMarkPaid = async () => {
    if (!markPaidDialog.renewal) return;

    setIsSubmitting(true);
    try {
      await api.post(`/api/partner/maintenance/${markPaidDialog.renewal.id}/mark-paid`, {
        payment_reference: paymentReference || undefined,
      });

      // 刷新列表
      await loadRenewals();

      // 关闭对话框
      setMarkPaidDialog({ open: false, renewal: null });
      setPaymentReference('');
    } catch (err: any) {
      setError(err.message || t('markPaidFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // 状态徽章
  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; icon: any; labelKey: string }> = {
      pending: {
        variant: 'secondary',
        icon: Clock,
        labelKey: 'statusPending',
      },
      paid: {
        variant: 'default',
        icon: CheckCircle,
        labelKey: 'statusPaid',
      },
      overdue: {
        variant: 'destructive',
        icon: AlertTriangle,
        labelKey: 'statusOverdue',
      },
      cancelled: {
        variant: 'outline',
        icon: XCircle,
        labelKey: 'statusCancelled',
      },
    };

    const config = variants[status] || variants.pending;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant} className="flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {t(config.labelKey)}
      </Badge>
    );
  };

  // 计算剩余天数
  const getDaysRemaining = (periodEnd: string) => {
    const now = new Date();
    const end = new Date(periodEnd);
    const days = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return days;
  };

  return (
    <div className="space-y-4">
      {/* 筛选栏 */}
      <div className="flex gap-4 items-center">
        <div className="flex-1">
          <Label htmlFor="status-filter" className="sr-only">
            {t('filterStatus')}
          </Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="status-filter" className="w-48">
              <SelectValue placeholder={t('filterStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('statusAll')}</SelectItem>
              <SelectItem value="pending">{t('statusPending')}</SelectItem>
              <SelectItem value="paid">{t('statusPaid')}</SelectItem>
              <SelectItem value="overdue">{t('statusOverdue')}</SelectItem>
              <SelectItem value="cancelled">{t('statusCancelled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button onClick={loadRenewals} variant="outline">
          {t('refresh')}
        </Button>
      </div>

      {/* 错误提示 */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* 加载状态 */}
      {isLoading ? (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : renewals.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {t('noRenewalRecords')}
        </div>
      ) : (
        <>
          {/* 表格 */}
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('customerInfo')}</TableHead>
                  <TableHead>{t('edition')}</TableHead>
                  <TableHead>{t('renewalYear')}</TableHead>
                  <TableHead>{t('servicePeriod')}</TableHead>
                  <TableHead className="text-right">{t('maintenanceFee')}</TableHead>
                  <TableHead className="text-right">{t('commission')}</TableHead>
                  <TableHead>{t('paymentStatus')}</TableHead>
                  <TableHead>{t('actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {renewals.map((renewal) => {
                  const daysRemaining = getDaysRemaining(renewal.period_end);
                  const isExpiringSoon = daysRemaining > 0 && daysRemaining <= 30;

                  return (
                    <TableRow key={renewal.id}>
                      <TableCell>
                        <div>
                          <div className="font-medium">{renewal.customer_name}</div>
                          {renewal.customer_company && (
                            <div className="text-sm text-muted-foreground">
                              {renewal.customer_company}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{renewal.edition}</Badge>
                      </TableCell>
                      <TableCell>{t('yearOrdinal', { n: renewal.renewal_year })}</TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div>
                            {new Intl.DateTimeFormat('zh-CN').format(
                              new Date(renewal.period_start)
                            )}
                          </div>
                          <div className="text-muted-foreground">
                            {t('until')}{' '}
                            {new Intl.DateTimeFormat('zh-CN').format(
                              new Date(renewal.period_end)
                            )}
                          </div>
                          {isExpiringSoon && (
                            <div className="text-orange-600 font-medium">
                              {t('expiresInDays', { n: daysRemaining })}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-medium">
                          ¥{(renewal.maintenance_price / 100).toLocaleString()}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="text-sm">
                          ¥{(renewal.commission_amount / 100).toLocaleString()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          ({(renewal.commission_rate / 100).toFixed(1)}%)
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(renewal.payment_status)}</TableCell>
                      <TableCell>
                        {renewal.payment_status === 'pending' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setMarkPaidDialog({ open: true, renewal });
                              setPaymentReference('');
                            }}
                          >
                            {t('markPaid')}
                          </Button>
                        )}
                        {renewal.payment_status === 'paid' && renewal.payment_reference && (
                          <div className="text-xs text-muted-foreground">
                            {renewal.payment_reference}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                {t('previousPage')}
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('pageOf', { page, totalPages })}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >
                {t('nextPage')}
              </Button>
            </div>
          )}
        </>
      )}

      {/* 标记支付对话框 */}
      <Dialog
        open={markPaidDialog.open}
        onOpenChange={(open) =>
          !open && setMarkPaidDialog({ open: false, renewal: null })
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('markMaintenancePaidTitle')}</DialogTitle>
            <DialogDescription>
              {t('confirmReceivedPayment', { customer: markPaidDialog.renewal?.customer_name ?? '' })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="bg-muted rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('maintenanceFeeAmount')}</span>
                <span className="font-semibold">
                  ¥
                  {markPaidDialog.renewal
                    ? (markPaidDialog.renewal.maintenance_price / 100).toLocaleString()
                    : 0}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('yourCommission')}</span>
                <span className="font-semibold text-primary">
                  ¥
                  {markPaidDialog.renewal
                    ? (markPaidDialog.renewal.commission_amount / 100).toLocaleString()
                    : 0}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="payment-reference">{t('paymentReferenceOptional')}</Label>
              <Input
                id="payment-reference"
                placeholder={t('paymentReferencePlaceholder')}
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMarkPaidDialog({ open: false, renewal: null })}
              disabled={isSubmitting}
            >
              {t('cancel')}
            </Button>
            <Button onClick={handleMarkPaid} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('confirmPaid')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
