'use client';

import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertTriangle, Clock, Mail } from 'lucide-react';
import { api } from '@/lib/api';

interface ExpiringMaintenance {
  license_id: string;
  customer_name: string;
  customer_company: string | null;
  customer_email: string | null;
  edition: string;
  maintenance_expires_at: string;
  maintenance_price: number;
  days_remaining: number;
  auto_renew_maintenance: boolean;
}

export function ExpiringMaintenancePanel() {
  const [expiring, setExpiring] = useState<ExpiringMaintenance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadExpiringMaintenance();
  }, []);

  const loadExpiringMaintenance = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.get<{ expiring_maintenance: ExpiringMaintenance[]; count: number }>(
        '/api/partner/maintenance/expiring'
      );

      setExpiring(response.expiring_maintenance);
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setIsLoading(false);
    }
  };

  const getUrgencyColor = (days: number) => {
    if (days <= 7) return 'text-red-600';
    if (days <= 15) return 'text-orange-600';
    return 'text-yellow-600';
  };

  const getUrgencyBadge = (days: number) => {
    if (days <= 7) return <Badge variant="destructive">紧急</Badge>;
    if (days <= 15) return <Badge variant="outline" className="border-orange-500 text-orange-700">注意</Badge>;
    return <Badge variant="secondary">提醒</Badge>;
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (expiring.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            即将到期的维护服务
          </CardTitle>
          <CardDescription>30 天内到期的维护服务</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            暂无即将到期的维护服务
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-600" />
              即将到期的维护服务
            </CardTitle>
            <CardDescription>30 天内到期的维护服务（{expiring.length} 个）</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={loadExpiringMaintenance}>
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {expiring.map((item) => (
            <Card key={item.license_id} className="border-l-4 border-l-orange-500">
              <CardContent className="p-4">
                <div className="flex justify-between items-start">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold">{item.customer_name}</h4>
                      {getUrgencyBadge(item.days_remaining)}
                      <Badge variant="outline">{item.edition}</Badge>
                      {item.auto_renew_maintenance && (
                        <Badge variant="secondary" className="text-xs">
                          自动续费
                        </Badge>
                      )}
                    </div>

                    {item.customer_company && (
                      <div className="text-sm text-muted-foreground">
                        {item.customer_company}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">到期时间：</span>
                        <span className="font-medium">
                          {format(new Date(item.maintenance_expires_at), 'yyyy-MM-dd', {
                            locale: zhCN,
                          })}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">剩余天数：</span>
                        <span className={`font-bold ${getUrgencyColor(item.days_remaining)}`}>
                          {item.days_remaining} 天
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">年度维护费：</span>
                        <span className="font-medium">
                          ¥{(item.maintenance_price / 100).toLocaleString()}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">您的佣金（10%）：</span>
                        <span className="font-medium text-primary">
                          ¥{(item.maintenance_price * 0.1 / 100).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 ml-4">
                    <Button size="sm" variant="default">
                      立即续费
                    </Button>
                    {item.customer_email && (
                      <Button size="sm" variant="outline">
                        <Mail className="h-4 w-4 mr-1" />
                        提醒客户
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
