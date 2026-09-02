'use client';

import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';

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

      const response: PaginatedResponse = await api.get(
        `/api/partner/maintenance/renewals?${params.toString()}`
      );

      setRenewals(response.renewals);
      setTotalPages(response.pagination.total_pages);
    } catch (err: any) {
      setError(err.message || '加载失败');
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
      setError(err.message || '标记支付失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 状态徽章
  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; icon: any; label: string }> = {
      pending: {
        variant: 'secondary',
        icon: Clock,
        label: '待支付',
      },
      paid: {
        variant: 'default',
        icon: CheckCircle,
        label: '已支付',
      },
      overdue: {
        variant: 'destructive',
        icon: AlertTriangle,
        label: '逾期',
      },
      cancelled: {
        variant: 'outline',
        icon: XCircle,
        label: '已取消',
      },
    };

    const config = variants[status] || variants.pending;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant} className="flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {config.label}
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
            筛选状态
          </Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="status-filter" className="w-48">
              <SelectValue placeholder="筛选状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="pending">待支付</SelectItem>
              <SelectItem value="paid">已支付</SelectItem>
              <SelectItem value="overdue">逾期</SelectItem>
              <SelectItem value="cancelled">已取消</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button onClick={loadRenewals} variant="outline">
          刷新
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
          暂无维护费续费记录
        </div>
      ) : (
        <>
          {/* 表格 */}
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户信息</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>续费年份</TableHead>
                  <TableHead>服务周期</TableHead>
                  <TableHead className="text-right">维护费</TableHead>
                  <TableHead className="text-right">佣金</TableHead>
                  <TableHead>支付状态</TableHead>
                  <TableHead>操作</TableHead>
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
                      <TableCell>第 {renewal.renewal_year} 年</TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div>
                            {format(new Date(renewal.period_start), 'yyyy-MM-dd', {
                              locale: zhCN,
                            })}
                          </div>
                          <div className="text-muted-foreground">
                            至{' '}
                            {format(new Date(renewal.period_end), 'yyyy-MM-dd', {
                              locale: zhCN,
                            })}
                          </div>
                          {isExpiringSoon && (
                            <div className="text-orange-600 font-medium">
                              {daysRemaining} 天后到期
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
                            标记已支付
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
                上一页
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  第 {page} / {totalPages} 页
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >
                下一页
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
            <DialogTitle>标记维护费已支付</DialogTitle>
            <DialogDescription>
              确认收到客户「{markPaidDialog.renewal?.customer_name}」的维护费支付？
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="bg-muted rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">维护费金额</span>
                <span className="font-semibold">
                  ¥
                  {markPaidDialog.renewal
                    ? (markPaidDialog.renewal.maintenance_price / 100).toLocaleString()
                    : 0}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">您的佣金</span>
                <span className="font-semibold text-primary">
                  ¥
                  {markPaidDialog.renewal
                    ? (markPaidDialog.renewal.commission_amount / 100).toLocaleString()
                    : 0}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="payment-reference">支付凭证（可选）</Label>
              <Input
                id="payment-reference"
                placeholder="例：银行转账凭证 20260901-001"
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
              取消
            </Button>
            <Button onClick={handleMarkPaid} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              确认已支付
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
