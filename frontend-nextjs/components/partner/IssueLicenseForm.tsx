'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  Alert,
  AlertCircle,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Check,
  Checkbox,
  Input,
  Label,
  Loader2,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/compat';
import api from '@/lib/api';
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
  const t = useTranslations('partnerIssueLicense');
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
    { id: 'ai', name: t('featAi'), price: 30000 },
    { id: 'ha', name: t('featHa'), price: 40000 },
    { id: 'multitenant', name: t('featMultitenant'), price: 0 }, // 标准版包含
    { id: 'audit', name: t('featAudit'), price: 15000 },
    { id: 'pipeline', name: t('featPipeline'), price: 20000 },
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

      const { data: response } = await api.post<IssueLicenseResponse>(
        '/api/partner/licenses',
        request
      );

      setSuccess(true);
      setTimeout(() => {
        router.push(`/partner/licenses?id=${response.license_id}`);
      }, 2000);
    } catch (err: any) {
      setError(err.message || t('issueFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 客户信息 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('customerInfo')}</CardTitle>
          <CardDescription>{t('customerInfoDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="customerName">{t('customerName')} *</Label>
              <Input
                id="customerName"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder={t('customerNamePlaceholder')}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customerCompany">{t('companyName')}</Label>
              <Input
                id="customerCompany"
                value={customerCompany}
                onChange={(e) => setCustomerCompany(e.target.value)}
                placeholder={t('companyNamePlaceholder')}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="customerEmail">{t('customerEmail')}</Label>
              <Input
                id="customerEmail"
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="contact@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customerPhone">{t('customerPhone')}</Label>
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
          <CardTitle>{t('licenseConfig')}</CardTitle>
          <CardDescription>{t('licenseConfigDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edition">{t('edition')} *</Label>
              <Select value={edition} onValueChange={(value: any) => setEdition(value)}>
                <SelectTrigger id="edition">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Trial（{t('editionTrial')}）</SelectItem>
                  <SelectItem value="standard">Standard（{t('editionStandard')}）</SelectItem>
                  <SelectItem value="enterprise">Enterprise（{t('editionEnterprise')}）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="licenseType">{t('type')} *</Label>
              <Select value={licenseType} onValueChange={(value: any) => setLicenseType(value)}>
                <SelectTrigger id="licenseType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="perpetual">Perpetual（{t('licenseTypePerpetual')}）</SelectItem>
                  <SelectItem value="subscription">Subscription（{t('licenseTypeSubscription')}）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('functionalModules')}</Label>
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
              <Label htmlFor="maxNodes">{t('maxNodes')}</Label>
              <Input
                id="maxNodes"
                type="number"
                min="1"
                value={maxNodes}
                onChange={(e) => setMaxNodes(parseInt(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxTenants">{t('maxTenants')}</Label>
              <Input
                id="maxTenants"
                type="number"
                min="1"
                value={maxTenants}
                onChange={(e) => setMaxTenants(parseInt(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxAccounts">{t('maxAccountsPerTenant')}</Label>
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
            <Label htmlFor="fingerprint">{t('fingerprint')}</Label>
            <Input
              id="fingerprint"
              value={fingerprint}
              onChange={(e) => setFingerprint(e.target.value)}
              placeholder="server001.customer.com"
            />
            <p className="text-sm text-muted-foreground">
              {t('fingerprintHint')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 时间与价格 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('timeAndPrice')}</CardTitle>
          <CardDescription>{t('timeAndPriceDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="days">{t('validDays')} *</Label>
              <Input
                id="days"
                type="number"
                min="1"
                value={days}
                onChange={(e) => setDays(parseInt(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="graceDays">{t('graceDays')}</Label>
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
            <Label htmlFor="price">{t('licensePriceYuan')} *</Label>
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
            {t('annualMaintenance')}
            <span className="text-sm font-normal text-muted-foreground">（{t('recommended')}）</span>
          </CardTitle>
          <CardDescription>
            {t('annualMaintenanceDesc')}
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
              {t('includeAnnualMaintenance')}
            </Label>
          </div>

          {includeMaintenance && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="maintenanceYears">{t('maintenanceYears')}</Label>
                  <Select
                    value={maintenanceYears.toString()}
                    onValueChange={(value) => setMaintenanceYears(parseInt(value))}
                  >
                    <SelectTrigger id="maintenanceYears">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">{t('years', { n: 1 })}（{t('recommended')}）</SelectItem>
                      <SelectItem value="2">{t('years', { n: 2 })}</SelectItem>
                      <SelectItem value="3">{t('years', { n: 3 })}</SelectItem>
                      <SelectItem value="5">{t('years', { n: 5 })}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maintenancePrice">{t('annualMaintenancePriceYuan')}</Label>
                  <Input
                    id="maintenancePrice"
                    type="number"
                    min="0"
                    value={maintenancePriceOverride ?? priceBreakdown.maintenancePrice}
                    onChange={(e) => setMaintenancePriceOverride(parseInt(e.target.value))}
                    placeholder={t('defaultPricePlaceholder', { price: priceBreakdown.maintenancePrice.toLocaleString() })}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('defaultMaintenancePriceHint')}
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
                  {t('autoRenewMaintenance')}
                </Label>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 价格预览 */}
      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle>{t('pricePreview')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm">{t('licensePrice')}</span>
            <span className="font-semibold">
              ¥{priceBreakdown.licensePrice.toLocaleString()}
            </span>
          </div>

          {includeMaintenance && (
            <>
              <div className="flex justify-between items-center">
                <span className="text-sm">
                  {t('annualMaintenanceYears', { n: maintenanceYears })}
                </span>
                <span className="font-semibold">
                  ¥{priceBreakdown.maintenanceTotalPrice.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between items-center text-muted-foreground">
                <span className="text-sm pl-4">
                  └ {t('partnerShare', { rate: maintenanceCommissionRate })}
                </span>
                <span className="text-sm">
                  ¥{priceBreakdown.maintenanceCommission.toLocaleString()}
                </span>
              </div>
            </>
          )}

          <div className="border-t pt-3 mt-3">
            <div className="flex justify-between items-center">
              <span className="font-medium">{t('total')}</span>
              <span className="text-xl font-bold">
                ¥{priceBreakdown.totalPrice.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="bg-primary/10 rounded-lg p-3 mt-3">
            <div className="flex justify-between items-center">
              <span className="font-medium text-primary">{t('yourCommission')}</span>
              <span className="text-xl font-bold text-primary">
                ¥{priceBreakdown.totalCommission.toLocaleString()}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-2 space-y-1">
              <div className="flex justify-between">
                <span>{t('licenseCommission', { rate: commissionRate })}</span>
                <span>¥{priceBreakdown.licenseCommission.toLocaleString()}</span>
              </div>
              {includeMaintenance && (
                <div className="flex justify-between">
                  <span>{t('maintenanceCommission', { rate: maintenanceCommissionRate })}</span>
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
            {t('issueSuccessRedirecting')}
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
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting || !customerName}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('issueLicense')}
        </Button>
      </div>
    </form>
  );
}
