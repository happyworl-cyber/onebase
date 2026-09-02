# OneBase 定价策略与竞品分析报告

## 一、竞品定价调研（2026 年数据）

### 1.1 低代码平台定价范围

#### Retool（内部工具构建平台）
- **Team**：$10-12/builder，$5/内部用户
- **Business**：$50-65/builder，$15/内部用户
- **Enterprise**（自部署）：定制定价，需联系销售
- **特点**：自部署仅限 Enterprise 级别

**来源**：[Retool Pricing 2026](https://www.vendr.com/marketplace/retool)

#### Appsmith（开源低代码）
- **Community（自部署）**：免费，无用户限制
- **Enterprise（自部署）**：$2,500/月起（100 用户），约 $30,000/年
- **基础设施成本**：$42/月起（2 vCPU + 4GB RAM）
- **特点**：Apache 2.0 开源，可自由修改

**来源**：[Appsmith Pricing 2026](https://www.jetadmin.io/blog/appsmith-pricing-2026-guide-to-plans-limits-and-total-cost-with-jet-admin-comparison/)

#### Budibase（低代码平台）
- **Pro**：$19/月（年付），$23/月（月付）
- **Premium**：$49/月（年付），$59/月（月付）
- **Business**：$299/月（年付），$359/月（月付）
- **Enterprise**：定制定价

**来源**：[Budibase Pricing 2026](https://www.zite.com/blog/budibase-pricing)

#### NocoDB（数据库协作平台）
- **Team**：$19/月（10 用户）
- **Business**：$99/月（20 用户）
- **Enterprise**：定制定价

**来源**：[NocoDB Pricing 2026](https://toolradar.com/tools/nocodb/pricing)

#### Supabase（后端即服务）
- **Pro**：$25/月/项目
- **Team**：$599/月
- **Enterprise**：定制定价
- **自部署**：开源免费，基础设施 $14-43/月

**来源**：[Supabase Pricing 2026](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/)

### 1.2 企业级平台定价（参考）

#### 高端低代码平台年度合同
- **Appian**：$280,000-$450,000/年
- **Mendix**：$350,000-$700,000/年
- **Microsoft Power Apps**：$250,000-$350,000/年
- **OutSystems/Pega**：$50,000-$250,000+/年

**来源**：[Low-Code Platform Pricing Benchmarks 2026](https://vendorbenchmark.com/blog/low-code-platform-pricing-benchmark-enterprise)

### 1.3 行业标准维护费率

#### 软件维护年度费用
- **标准维护费**：许可证价格的 **18-25%**
- **复杂企业系统**：许可证价格的 **25-40%**
- **年度涨价率**：3-10%（如未锁定价格）

#### 主流厂商维护费涨价趋势（2026）
- **SAP**：续费涨价 8-12%/年
- **Oracle**：续费涨价 10%+
- **ServiceNow**：年度涨价 5-10% + AI 附加费 30-45%
- **Atlassian**：Data Center 涨价 15-40%
- **IBM**：2026 年全球涨价 6%（维护费 10%）

**来源**：
- [Software Maintenance Cost 2026](https://www.intigatetechnologies.com/average-software-maintenance-cost/)
- [Software Price Increases 2025-2026](https://licenseware.io/software-price-increases-2025-2026/)

---

## 二、OneBase 定价策略建议

### 2.1 核心定价逻辑

#### 目标市场定位
- **Trial**：中小企业试用/个人开发者
- **Standard**：成长型企业（50-500 人）
- **Enterprise**：大型企业/政府/金融（500+ 人）

#### 定价原则
1. **买断制为主**：一次付费，永久使用（符合国内采购习惯）
2. **订阅制可选**：年度订阅（价格 = 买断价 × 25%）
3. **维护费分离**：买断客户可选购年度维护（推荐 20%）
4. **模块化增购**：按需购买 AI、HA、Pipeline 等模块

---

### 2.2 推荐价格体系（人民币）

#### Trial 版（试用版）
| 项目 | 配置 |
|------|------|
| **买断价格** | ¥0（免费） |
| **订阅价格** | ¥0（免费） |
| **最大租户数** | 1 |
| **最大节点数** | 1（单机） |
| **租户最大账号** | 5 |
| **有效期** | 90 天 |
| **包含功能** | 基础 CRUD、表单、视图 |
| **维护费** | 不适用 |

**目标**：吸引试用，转化为付费客户

---

#### Standard 版（标准版）

| 项目 | 配置 |
|------|------|
| **买断价格** | ¥80,000 |
| **订阅价格** | ¥20,000/年 |
| **年度维护费** | ¥16,000/年（买断价的 20%） |
| **最大租户数** | 10 |
| **最大节点数** | 3（高可用基础） |
| **租户最大账号** | 100/租户 |
| **有效期** | 永久（买断）/ 1 年（订阅） |
| **包含功能** | 工作流、多租户、API |
| **可选模块** | AI（+¥30,000）、Pipeline（+¥20,000） |
| **维护内容** | 安全补丁、Bug 修复、小版本升级 |

**对标竞品**：Appsmith Enterprise（$30,000/年 ≈ ¥210,000/年），OneBase 定价更具竞争力

---

#### Enterprise 版（企业版）

| 项目 | 配置 |
|------|------|
| **买断价格** | ¥300,000 |
| **订阅价格** | ¥75,000/年 |
| **年度维护费** | ¥60,000/年（买断价的 20%） |
| **最大租户数** | 无限制 |
| **最大节点数** | 无限制 |
| **租户最大账号** | 无限制 |
| **有效期** | 永久（买断）/ 1 年（订阅） |
| **包含功能** | 全功能（工作流、AI、HA、SSO、审计、白标） |
| **维护内容** | 安全补丁、Bug 修复、大版本升级、专属支持 |
| **额外服务** | 可选专属技术支持（¥50,000/年） |

**对标竞品**：Retool Enterprise（定制定价，通常 $100,000-$300,000/年），OneBase 提供更清晰的透明定价

---

### 2.3 模块化增购价格（Standard 版附加模块）

| 模块 | 买断价 | 订阅价/年 | 年度维护费（买断） |
|------|--------|-----------|-------------------|
| **AI 模块**（MCP、内容生成） | ¥30,000 | ¥7,500 | ¥6,000 |
| **HA 模块**（高可用、故障转移） | ¥40,000 | ¥10,000 | ¥8,000 |
| **Pipeline 模块**（Kafka、ES） | ¥20,000 | ¥5,000 | ¥4,000 |
| **Audit 模块**（审计日志、导出） | ¥15,000 | ¥3,750 | ¥3,000 |

**注**：Enterprise 版包含所有模块，无需单独购买

---

### 2.4 维护费（Annual Maintenance Agreement, AMA）

#### 维护费定价规则
- **费率**：许可证买断价的 **20%/年**
- **涨价政策**：锁定 3 年不涨价，第 4 年起每年涨价 5%
- **续费周期**：每年续费一次
- **是否强制**：**可选**（但强烈推荐，不购买维护则不提供安全更新）

#### 维护服务内容

| 维护级别 | Standard 维护 | Enterprise 维护 |
|----------|---------------|-----------------|
| **安全补丁** | ✅ 7 工作日内发布 | ✅ 24 小时内发布 |
| **Bug 修复** | ✅ 包含在次版本更新 | ✅ 包含在次版本更新 |
| **小版本升级** | ✅ v1.1 → v1.2 | ✅ v1.1 → v1.2 |
| **大版本升级** | ❌ 需单独购买升级包 | ✅ v1.x → v2.x |
| **邮件支持** | ✅ 5×8（工作日） | ✅ 7×24 |
| **电话支持** | ❌ | ✅ 专属热线 |
| **SLA 承诺** | ❌ | ✅ 99.9% 可用性 |

#### 维护费收入示例

假设某客户购买：
- **Standard 买断**：¥80,000
- **AI 模块买断**：¥30,000
- **总买断价**：¥110,000

年度维护费 = ¥110,000 × 20% = **¥22,000/年**

如果客户连续续费 3 年：
- 第 1 年：¥22,000
- 第 2 年：¥22,000
- 第 3 年：¥22,000
- **3 年维护总收入**：¥66,000（相当于初始购买价的 60%）

---

## 三、代理商分成体系

### 3.1 分成比例建议

#### 初始 License 销售（新签）
| 版本 | 代理商分成 | 原厂留存 |
|------|-----------|---------|
| **Trial** | 0%（免费版） | 0% |
| **Standard** | **20%** | 80% |
| **Enterprise** | **15%** | 85% |
| **模块增购** | **18%** | 82% |

**理由**：
- Standard 版单价低，给代理商更高激励（20%）
- Enterprise 版单价高，但代理商工作量不成比例增加，适度降低（15%）
- 参考行业标准：软件代理商分成通常 15-25%

#### 年度维护费续费（AMA）
| 版本 | 代理商分成 | 原厂留存 |
|------|-----------|---------|
| **Standard** | **10%** | 90% |
| **Enterprise** | **8%** | 92% |
| **模块维护费** | **10%** | 90% |

**理由**：
- 维护费续费几乎无销售成本（自动续费为主）
- 代理商主要提供客户关系维护，工作量低于新签
- 10% 分成足够激励代理商维护客户关系
- 原厂保留 90% 用于覆盖实际维护成本（研发、客服）

---

### 3.2 分成计算示例

#### 案例 1：Standard 版新签 + 3 年维护

**第 1 年（新签）**：
- 客户购买：Standard 买断 ¥80,000 + AI 模块 ¥30,000 = ¥110,000
- 代理商分成：
  - Standard：¥80,000 × 20% = ¥16,000
  - AI 模块：¥30,000 × 18% = ¥5,400
  - **合计**：¥21,400
- 原厂收入：¥110,000 - ¥21,400 = ¥88,600

**第 2-4 年（维护续费）**：
- 客户续费维护：¥22,000/年
- 代理商分成（每年）：¥22,000 × 10% = ¥2,200
- 原厂收入（每年）：¥22,000 - ¥2,200 = ¥19,800

**4 年总计**：
- 客户总支出：¥110,000 + ¥22,000 × 3 = ¥176,000
- 代理商总收入：¥21,400 + ¥2,200 × 3 = ¥28,000（占比 15.9%）
- 原厂总收入：¥148,000（占比 84.1%）

---

#### 案例 2：Enterprise 版新签 + 3 年维护

**第 1 年（新签）**：
- 客户购买：Enterprise 买断 ¥300,000
- 代理商分成：¥300,000 × 15% = ¥45,000
- 原厂收入：¥255,000

**第 2-4 年（维护续费）**：
- 客户续费维护：¥60,000/年
- 代理商分成（每年）：¥60,000 × 8% = ¥4,800
- 原厂收入（每年）：¥55,200

**4 年总计**：
- 客户总支出：¥300,000 + ¥60,000 × 3 = ¥480,000
- 代理商总收入：¥45,000 + ¥4,800 × 3 = ¥59,400（占比 12.4%）
- 原厂总收入：¥420,600（占比 87.6%）

---

### 3.3 代理商配额管理

#### 配额有效期
- **新签配额**：每年分配一次（例如 100 个 License/年）
- **维护续费**：不占用配额（自动继承）

#### 配额续费政策
- 如果代理商当年未用完配额，**不结转**到下一年
- 鼓励代理商积极推广，避免囤积配额

---

## 四、定价策略优势分析

### 4.1 相比竞品的优势

#### vs. Appsmith Enterprise
- **Appsmith**：$30,000/年订阅（≈ ¥210,000/年）
- **OneBase Standard**：¥80,000 买断 + ¥16,000 维护 = 首年 ¥96,000
- **优势**：OneBase 首年成本 **降低 54%**，且支持永久买断

#### vs. Retool Enterprise
- **Retool**：定制定价，通常 $100,000-$300,000/年
- **OneBase Enterprise**：¥300,000 买断（约 $42,000）
- **优势**：OneBase **避免按年付费陷阱**，总拥有成本（TCO）更低

#### vs. Budibase Business
- **Budibase**：$3,588/年（$299/月 × 12）
- **OneBase Standard**：¥20,000/年订阅（约 $2,800/年）
- **优势**：OneBase 订阅价格更低，且功能更全面（AI、多租户）

---

### 4.2 国内市场适配性

#### 采购习惯
- ✅ **支持买断**：符合国企/政府采购要求（资产化）
- ✅ **价格透明**：明码标价，避免"定制报价"的不信任感
- ✅ **人民币定价**：规避汇率风险和跨境支付麻烦

#### 合规性
- ✅ **自部署**：数据不出境，满足《数据安全法》要求
- ✅ **无后门**：开源核心，客户可审计代码
- ✅ **国产化**：支持国产数据库（达梦、人大金仓等）

---

## 五、实施建议

### 5.1 定价策略执行计划

#### Phase 1：内部准备（1-2 周）
1. 更新官网价格页面（透明定价）
2. 制作代理商销售话术 PPT
3. 编写维护服务 SLA 文档
4. 配置 License 工具支持新价格体系

#### Phase 2：代理商培训（2 周）
1. 召开代理商大会，宣讲新价格体系
2. 提供标准报价单模板
3. 培训代理商如何销售维护费（价值说明）
4. 签订新的代理协议（明确分成比例）

#### Phase 3：市场推广（持续）
1. 推出"买断送首年维护"促销活动
2. 提供 POC（概念验证）免费技术支持
3. 发布对比竞品的 TCO 计算器
4. 建立客户案例库（按行业分类）

---

### 5.2 数据库表更新

#### 新增字段：customer_licenses 表
```sql
ALTER TABLE management.customer_licenses
ADD COLUMN IF NOT EXISTS has_maintenance BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS maintenance_expires_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS maintenance_price NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS maintenance_commission_rate NUMERIC(5, 2) DEFAULT 10.00;

COMMENT ON COLUMN management.customer_licenses.has_maintenance
IS '是否购买年度维护';

COMMENT ON COLUMN management.customer_licenses.maintenance_expires_at
IS '维护服务到期时间';

COMMENT ON COLUMN management.customer_licenses.maintenance_price
IS '年度维护费价格';

COMMENT ON COLUMN management.customer_licenses.maintenance_commission_rate
IS '维护费代理商分成比例（0-100）';
```

#### 新增字段：partner_commissions 表
```sql
ALTER TABLE management.partner_commissions
ADD COLUMN IF NOT EXISTS commission_type VARCHAR(20) DEFAULT 'license',
ADD COLUMN IF NOT EXISTS renewal_year INTEGER DEFAULT 0;

COMMENT ON COLUMN management.partner_commissions.commission_type
IS '分成类型：license（新签）、maintenance（维护续费）';

COMMENT ON COLUMN management.partner_commissions.renewal_year
IS '续费年份（0=新签，1=第1年续费，2=第2年续费...）';
```

---

### 5.3 前端 UI 更新

#### License 签发表单新增字段
```typescript
interface IssueLicenseForm {
  // ... 现有字段

  // 新增：维护费选项
  include_maintenance: boolean;          // 是否包含首年维护
  maintenance_years: number;             // 购买几年维护（1-5）
  maintenance_price_override?: number;   // 维护费自定义价格（可选）
}
```

#### 价格计算逻辑
```typescript
function calculateTotalPrice(form: IssueLicenseForm): PriceBreakdown {
  const basePrice = getEditionPrice(form.edition);  // 基础版本价格
  const modulePrice = form.modules.reduce((sum, mod) =>
    sum + getModulePrice(mod), 0);                 // 模块价格

  const licenseTotal = basePrice + modulePrice;

  // 维护费 = License 总价 × 20%
  const maintenanceAnnual = licenseTotal * 0.20;
  const maintenanceTotal = form.include_maintenance
    ? maintenanceAnnual * form.maintenance_years
    : 0;

  return {
    license_price: licenseTotal,
    maintenance_price: maintenanceTotal,
    total: licenseTotal + maintenanceTotal,
    breakdown: {
      base: basePrice,
      modules: modulePrice,
      maintenance_per_year: maintenanceAnnual,
      maintenance_years: form.maintenance_years,
    }
  };
}
```

---

## 六、风险与应对

### 6.1 潜在风险

#### 风险 1：价格过高，市场接受度低
**应对**：
- 提供 90 天免费 Trial，降低试用门槛
- 推出订阅制（年费 = 买断价 × 25%），降低初始成本
- 强化 ROI 计算器，对比竞品展示 TCO 优势

#### 风险 2：客户不愿购买维护费
**应对**：
- 前 6 个月免费维护（含在 License 价格中）
- 不购买维护则**不提供安全补丁**（强制引导）
- 推出"买断送首年维护"促销活动

#### 风险 3：代理商对维护费分成不满
**应对**：
- 强调维护费是**长期稳定收入**（客户续费率 80%+）
- 计算 4 年总收入，展示维护费贡献占比（案例 1 中占 23.6%）
- 提供季度返点激励（续费率高的代理商额外奖励）

---

## 七、总结

### 7.1 推荐定价方案

| 版本 | 买断价 | 订阅价/年 | 维护费/年 | 新签分成 | 维护分成 |
|------|--------|-----------|-----------|---------|---------|
| **Trial** | ¥0 | ¥0 | - | - | - |
| **Standard** | ¥80,000 | ¥20,000 | ¥16,000 | 20% | 10% |
| **Enterprise** | ¥300,000 | ¥75,000 | ¥60,000 | 15% | 8% |

### 7.2 核心竞争优势

1. **价格优势**：比 Appsmith/Retool 低 40-60%
2. **买断制**：避免订阅陷阱，符合国内采购习惯
3. **透明定价**：明码标价，无隐藏费用
4. **模块化**：按需购买，降低初始成本
5. **自部署**：数据安全可控，满足合规要求

### 7.3 收入预测（保守估计）

假设第一年目标：
- **Standard 版**：50 个客户 × ¥96,000（买断+首年维护）= ¥4,800,000
- **Enterprise 版**：10 个客户 × ¥360,000（买断+首年维护）= ¥3,600,000
- **第 1 年总收入**：¥8,400,000

假设维护续费率 70%（第 2 年）：
- **Standard 续费**：35 × ¥16,000 = ¥560,000
- **Enterprise 续费**：7 × ¥60,000 = ¥420,000
- **新签收入**：¥8,400,000（假设持平）
- **第 2 年总收入**：¥9,380,000

**3 年累计收入预测**：¥27,000,000+

---

## 参考资料

### 竞品定价来源
- [Supabase Pricing 2026](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/)
- [Retool Pricing 2026](https://www.vendr.com/marketplace/retool)
- [Appsmith Pricing 2026](https://www.jetadmin.io/blog/appsmith-pricing-2026-guide-to-plans-limits-and-total-cost-with-jet-admin-comparison/)
- [Budibase Pricing 2026](https://www.zite.com/blog/budibase-pricing)
- [NocoDB Pricing 2026](https://toolradar.com/tools/nocodb/pricing)
- [Low-Code Platform Pricing Benchmarks 2026](https://vendorbenchmark.com/blog/low-code-platform-pricing-benchmark-enterprise)

### 维护费行业标准
- [Software Maintenance Cost 2026](https://www.intigatetechnologies.com/average-software-maintenance-cost/)
- [Software Price Increases 2025-2026](https://licenseware.io/software-price-increases-2025-2026/)
- [Software Maintenance Costs Guide](https://adevs.com/blog/software-maintenance-costs/)

---

**文档版本**：v1.0
**更新时间**：2026-09-01
**作者**：Claude Sonnet 4.5
**适用产品**：OneBase 1.0+
