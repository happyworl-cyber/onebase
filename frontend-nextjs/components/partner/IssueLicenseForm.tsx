'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { IssueLicenseRequest, IssueLicenseResponse } from '@/lib/types/partner';

interface PriceBreakdown {
  licensePrice: number;
  maintenancePrice: number;
  maintenanceTotalPrice: number;
  totalPrice: number;
  licenseCommission: number;
  maintenanceCommission: number;
  totalCommission: number;
}

export function IssueLicenseForm() {
  const router = useRouter();

  // 基本信息
  const [customerName, setCustomerName] = useState('');
  const [customerCompany, setCustomerCompany] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  // License 配置
  const [edition, setEdition] = useState<'trial' | 'standard' | 'enterprise'>('standard');
  const [modules, setModules] = useState<string[]>([]);
  const [maxNodes, setMaxNodes] = useState(1);
  const [maxTenants, setMaxTenants] = useState(10);
  const [maxAccountsPerTenant, setMaxAccountsPerTenant] = useState(100);
  const [fingerprint, setFingerprint] = useState('');

  // 时间与价格
  const [days, setDays] = useState(365);
  const [graceDays, setGraceDays] = useState(30);
  const [licenseType, setLicenseType] = useState<'subscription' | 'perpetual'>('perpetual');
  const [price, setPrice] = useState(80000); // 元

  // 维护费选项
  const [includeMaintenance, setIncludeMaintenance] = useState(true);
  const [maintenanceYears, setMaintenanceYears] = useState(1);
  const [maintenancePriceOverride, setMaintenancePriceOverride] = useState<number | null>(null);
  const [autoRenewMaintenance, setAutoRenewMaintenance] = useState(false);

  // UI 状态
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // 计算价格分解
  const [priceBreakdown, setPriceBreakdown] = useState<PriceBreakdown>({
    licensePrice: 0,
    maintenancePrice: 0,
    maintenanceTotalPrice: 0,
    totalPrice: 0,
    licenseCommission: 0,
    maintenanceCommission: 0,
    totalCommission: 0,
  });

  // 代理商信息（假设从 context 或 API 获取）
  const [commissionRate, setCommissionRate] = useState(20); // 20%
  const [maintenanceCommissionRate] = useState(10); // 10%

  // 可用模块
  const availableModules = [
    { id: 'ai', name: 'AI 智能助手', price: 30000 },
    { id: 'ha', name: '高可用（HA）', price: 40000 },
    { id: 'multitenant', name: '多租户', price: 0 }, // 标准版包含
    { id: 'audit', name: '审计日志', price: 15000 },
    { id: 'pipeline', name: '数据管道', price: 20000 },
  ];

  // 计算价格
  useEffect(() => {
    let licensePrice = price;

    // 添加模块价格
    modules.forEach(moduleId => {
      const module = availableModules.find(m => m.id === moduleId);
      if (module) {
        licensePrice += module.price;
      }
    });

    // 计算维护费
    const maintenancePrice = maintenancePriceOverride ?? Math.round(licensePrice * 0.2);
    const maintenanceTotalPrice = includeMaintenance ? maintenancePrice * maintenanceYears : 0;

    // 计算佣金
    const licenseCommission = Math.round(licensePrice * (commissionRate / 100));
    const maintenanceCommission = includeMaintenance
      ? Math.round(maintenancePrice * maintenanceYears * (maintenanceCommissionRate / 100))
      : 0;

    const totalPrice = licensePrice + maintenanceTotalPrice;
    const totalCommission = licenseCommission + maintenanceCommission;

    setPriceBreakdown({
      licensePrice,
      maintenancePrice,
      maintenanceTotalPrice,
      totalPrice,
      licenseCommission,
      maintenanceCommission,
      totalCommission,
    });
  }, [
    price,
    modules,
    includeMaintenance,
    maintenanceYears,
    maintenancePriceOverride,
    commissionRate,
    maintenanceCommissionRate,
  ]);

  const handleModuleToggle = (moduleId: string) => {
    setModules(prev =>
      prev.includes(moduleId)
        ? prev.filter(id => id !== moduleId)
        : [...prev, moduleId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      const request: IssueLicenseRequest = {
        customer_name: customerName,
        customer_company: customerCompany || undefined,
        customer_email: customerEmail || undefined,
        customer_contact_phone: customerPhone || undefined,
        edition,
        modules,
        max_nodes: maxNodes,
        max_tenants: maxTenants,
        max_accounts_per_tenant: maxAccountsPerTenant || undefined,
        fingerprint: fingerprint || undefined,
        days,
        grace_days: graceDays,
        license_type: licenseType,
        price: priceBreakdown.licensePrice * 100, // 转换为分
        currency: 'CNY',
        include_maintenance: includeMaintenance,
        maintenance_years: maintenanceYears,
        maintenance_price_override: maintenancePriceOverride ? maintenancePriceOverride * 100 : undefined,
        maintenance_commission_rate: maintenanceCommissionRate * 100, // 1000 = 10%
        auto_renew_maintenance: autoRenewMaintenance,
      };

      const response: IssueLicenseResponse = await api.post('/api/partner/licenses', request);

      setSuccess(true);
      setTimeout(() => {
        router.push(`/partner/licenses?id=${response.license_id}`);
      }, 2000);
    } catch (err: any) {
      setError(err.message || '签发 License 失败，请重试');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 客户信息 */}
      <Card>
        <CardHeader>
          <CardTitle>客户信息</CardTitle>
          <CardDescription>填写客户的基本信息</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="customerName">客户名称 *</Label>
              <Input
                id="customerName"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="例：张三"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customerCompany">公司名称</Label>
              <Input
                id="customerCompany"
                value={customerCompany}
                onChange={(e) => setCustomerCompany(e.target.value)}
                placeholder="例：XX 科技有限公司"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="customerEmail">客户邮箱</Label>
              <Input
                id="customerEmail"
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="contact@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customerPhone">联系电话</Label>
              <Input
                id="customerPhone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="+86-138-0000-0000"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* License 配置 */}
      <Card>
        <CardHeader>
          <CardTitle>License 配置</CardTitle>
          <CardDescription>选择版本、模块和资源限制</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edition">版本 *</Label>
              <Select value={edition} onValueChange={(value: any) => setEdition(value)}>
                <SelectTrigger id="edition">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Trial（试用版）</SelectItem>
                  <SelectItem value="standard">Standard（标准版）</SelectItem>
                  <SelectItem value="enterprise">Enterprise（企业版）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="licenseType">类型 *</Label>
              <Select value={licenseType} onValueChange={(value: any) => setLicenseType(value)}>
                <SelectTrigger id="licenseType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="perpetual">Perpetual（买断）</SelectItem>
                  <SelectItem value="subscription">Subscription（订阅）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>功能模块</Label>
            <div className="grid grid-cols-2 gap-3">
              {availableModules.map(module => (
                <div key={module.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`module-${module.id}`}
                    checked={modules.includes(module.id)}
                    onCheckedChange={() => handleModuleToggle(module.id)}
                  />
                  <Label htmlFor={`module-${module.id}`} className="font-normal">
                    {module.name}
                    {module.price > 0 && (
                      <span className="text-sm text-muted-foreground ml-2">
                        +¥{module.price.toLocaleString()}
                      </span>
                    )}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="maxNodes">最大节点数</Label>
              <Input
                id="maxNodes"
                type="number"
                min="1"
                value={maxNodes}
                onChange={(e) => setMaxNodes(parseInt(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxTenants">最大租户数</Label>
              <Input
                id="maxTenants"
                type="number"
                min="1"
                value={maxTenants}
                onChange={(e) => setMaxTenants(parseInt(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxAccounts">每租户账号数</Label>
              <Input
                id="maxAccounts"
                type="number"
                min="1"
                value={maxAccountsPerTenant}
                onChange={(e) => setMaxAccountsPerTenant(parseInt(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="fingerprint">硬件指纹（可选）</Label>
            <Input
              id="fingerprint"
              value={fingerprint}
              onChange={(e) => setFingerprint(e.target.value)}
              placeholder="server001.customer.com"
            />
            <p className="text-sm text-muted-foreground">
              绑定到特定服务器，留空则不限制部署环境
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 时间与价格 */}
      <Card>
        <CardHeader>
          <CardTitle>时间与价格</CardTitle>
          <CardDescription>设置 License 有效期和价格</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="days">有效天数 *</Label>
              <Input
                id="days"
                type="number"
                min="1"
                value={days}
                onChange={(e) => setDays(parseInt(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="graceDays">宽限期（天）</Label>
              <Input
                id="graceDays"
                type="number"
                min="0"
                value={graceDays}
                onChange={(e) => setGraceDays(parseInt(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="price">License 价格（元）*</Label>
            <Input
              id="price"
              type="number"
              min="0"
              step="1000"
              value={price}
              onChange={(e) => setPrice(parseInt(e.target.value))}
            />
          </div>
        </CardContent>
      </Card>

      {/* 维护费选项 */}
      <Card className="border-2 border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            年度维护服务
            <span className="text-sm font-normal text-muted-foreground">（推荐）</span>
          </CardTitle>
          <CardDescription>
            包含安全补丁、Bug 修复、版本升级等服务
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="includeMaintenance"
              checked={includeMaintenance}
              onCheckedChange={(checked) => setIncludeMaintenance(!!checked)}
            />
            <Label htmlFor="includeMaintenance" className="font-medium">
              包含年度维护服务
            </Label>
          </div>

          {includeMaintenance && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="maintenanceYears">维护年限</Label>
                  <Select
                    value={maintenanceYears.toString()}
                    onValueChange={(value) => setMaintenanceYears(parseInt(value))}
                  >
                    <SelectTrigger id="maintenanceYears">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 年（推荐）</SelectItem>
                      <SelectItem value="2">2 年</SelectItem>
                      <SelectItem value="3">3 年</SelectItem>
                      <SelectItem value="5">5 年</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maintenancePrice">年度维护费（元）</Label>
                  <Input
                    id="maintenancePrice"
                    type="number"
                    min="0"
                    value={maintenancePriceOverride ?? priceBreakdown.maintenancePrice}
                    onChange={(e) => setMaintenancePriceOverride(parseInt(e.target.value))}
                    placeholder={`默认 ¥${priceBreakdown.maintenancePrice.toLocaleString()}`}
                  />
                  <p className="text-sm text-muted-foreground">
                    默认为 License 价格的 20%
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="autoRenew"
                  checked={autoRenewMaintenance}
                  onCheckedChange={(checked) => setAutoRenewMaintenance(!!checked)}
                />
                <Label htmlFor="autoRenew" className="font-normal">
                  自动续费维护服务
                </Label>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 价格预览 */}
      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle>价格预览</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm">License 价格</span>
            <span className="font-semibold">
              ¥{priceBreakdown.licensePrice.toLocaleString()}
            </span>
          </div>

          {includeMaintenance && (
            <>
              <div className="flex justify-between items-center">
                <span className="text-sm">
                  年度维护（{maintenanceYears} 年）
                </span>
                <span className="font-semibold">
                  ¥{priceBreakdown.maintenanceTotalPrice.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between items-center text-muted-foreground">
                <span className="text-sm pl-4">
                  └ 代理商分成（{maintenanceCommissionRate}%）
                </span>
                <span className="text-sm">
                  ¥{priceBreakdown.maintenanceCommission.toLocaleString()}
                </span>
              </div>
            </>
          )}

          <div className="border-t pt-3 mt-3">
            <div className="flex justify-between items-center">
              <span className="font-medium">合计</span>
              <span className="text-xl font-bold">
                ¥{priceBreakdown.totalPrice.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="bg-primary/10 rounded-lg p-3 mt-3">
            <div className="flex justify-between items-center">
              <span className="font-medium text-primary">您的佣金</span>
              <span className="text-xl font-bold text-primary">
                ¥{priceBreakdown.totalCommission.toLocaleString()}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-2 space-y-1">
              <div className="flex justify-between">
                <span>License 佣金（{commissionRate}%）</span>
                <span>¥{priceBreakdown.licenseCommission.toLocaleString()}</span>
              </div>
              {includeMaintenance && (
                <div className="flex justify-between">
                  <span>维护费佣金（{maintenanceCommissionRate}%）</span>
                  <span>¥{priceBreakdown.maintenanceCommission.toLocaleString()}</span>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 错误提示 */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* 成功提示 */}
      {success && (
        <Alert className="border-green-500 bg-green-50">
          <Check className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800">
            License 签发成功！正在跳转...
          </AlertDescription>
        </Alert>
      )}

      {/* 提交按钮 */}
      <div className="flex justify-end gap-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={isSubmitting}
        >
          取消
        </Button>
        <Button type="submit" disabled={isSubmitting || !customerName}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          签发 License
        </Button>
      </div>
    </form>
  );
}
