# 代理商分销系统 - 前端 UI 使用指南

## 📋 概览

已完成代理商分销系统的完整前端 UI，包括超管控制台和代理商自助服务控制台。

## 🎯 功能清单

### ✅ 超管控制台 (`/platform/partners`)

**路径**: `/app/platform/partners/page.tsx`

**功能**:
- ✅ 代理商列表展示（分页、筛选）
- ✅ 创建代理商（完整表单）
- ✅ 编辑代理商（配额、佣金、状态）
- ✅ 挂起代理商
- ✅ 查看代理商详情（统计数据）
- ✅ 配额使用率可视化
- ✅ License 和佣金统计

### ✅ 代理商控制台 (`/partner`)

#### 1. 概览页 (`/partner`)
**路径**: `/app/partner/page.tsx`

**功能**:
- ✅ 配额使用率仪表板
- ✅ 可用配额展示
- ✅ 佣金比例展示
- ✅ 代理商基本信息
- ✅ 授权范围展示（版本、模块）
- ✅ 快捷操作入口

#### 2. License 签发页 (`/partner/licenses`)
**路径**: `/app/partner/licenses/page.tsx`

**功能**:
- ✅ License 列表展示（分页）
- ✅ 签发 License 表单
  - 客户信息录入
  - 版本选择（受限于授权范围）
  - 模块选择（复选框）
  - 节点/租户数配置
  - 有效天数设置
  - 价格输入
  - 预估佣金计算
- ✅ License 文件下载
- ✅ 签发成功提示
- ✅ 配额耗尽警告
- ✅ 状态标签（active/grace/expired/revoked）

#### 3. 佣金记录页 (`/partner/commissions`)
**路径**: `/app/partner/commissions/page.tsx`

**功能**:
- ✅ 佣金记录列表（分页）
- ✅ 本页总佣金统计
- ✅ 待结算佣金统计
- ✅ 状态标签（pending/approved/paid/settled）

#### 4. 对账单页 (`/partner/statements`)
**路径**: `/app/partner/statements/page.tsx`

**功能**:
- ✅ 对账单列表（分页）
- ✅ 账期展示
- ✅ License 数/营收/佣金统计
- ✅ 状态标签（draft/pending/paid/settled）
- ✅ 支付时间展示

### ✅ 公共组件

#### PartnerSidebar
**路径**: `/components/partner/PartnerSidebar.tsx`

**功能**:
- ✅ 导航菜单（概览、License、佣金、对账单）
- ✅ 活动状态高亮
- ✅ 返回工作台链接

## 📂 文件结构

```
frontend-nextjs/
├── app/
│   ├── platform/
│   │   └── partners/
│   │       └── page.tsx          # 超管代理商管理页
│   └── partner/
│       ├── layout.tsx             # 代理商控制台布局
│       ├── page.tsx               # 概览页
│       ├── licenses/
│       │   └── page.tsx           # License 签发页
│       ├── commissions/
│       │   └── page.tsx           # 佣金记录页
│       └── statements/
│           └── page.tsx           # 对账单页
├── components/
│   └── partner/
│       └── PartnerSidebar.tsx     # 代理商侧边栏
└── lib/
    ├── api.ts                     # API 函数（已扩展）
    └── types/
        └── partner.ts             # TypeScript 类型定义
```

## 🚀 快速开始

### 1. 安装依赖（如需要）

```bash
cd frontend-nextjs
npm install
```

### 2. 启动开发服务器

```bash
npm run dev
# 访问 http://localhost:3006
```

### 3. 访问页面

#### 超管访问代理商管理
```
http://localhost:3006/platform/partners
```

**前置条件**:
- 用户必须是平台超管（`is_superadmin = true`）
- 已登录并持有有效 JWT Token

#### 代理商访问控制台
```
http://localhost:3006/partner
```

**前置条件**:
- 用户必须关联到某个代理商（`management.partner_users` 表）
- 代理商状态为 `active`
- 已登录并持有有效 JWT Token

## 🔧 关键功能说明

### License 签发流程

1. **导航到签发页面**
   ```
   /partner/licenses → 点击「签发 License」按钮
   ```

2. **填写表单**
   - 客户名称（必填）
   - 选择版本（受限于 `allowed_editions`）
   - 勾选模块（受限于 `allowed_modules`）
   - 设置节点数/租户数
   - 输入有效天数（受限于 `max_license_days`）
   - 输入价格

3. **预览佣金**
   - 系统自动计算：`price × commission_rate / 100`
   - 实时显示在价格输入框下方

4. **签发**
   - 点击「签发 License」
   - 后端验证：配额、授权范围、状态
   - 成功后弹出 License 文件下载抽屉

5. **下载 License 文件**
   - 点击「下载 License 文件」按钮
   - 文件名：`license_<uuid前8位>.lic`
   - 文件格式：JSON（包含 alg, payload, signature）

6. **交付客户**
   - 将 `.lic` 文件发送给客户
   - 客户放置到 `/etc/onebase/license.lic`
   - 重启 OneBase 服务激活

### 配额管理

**配额耗尽处理**:
- 当 `available_quota <= 0` 时，「签发 License」按钮自动禁用
- 页面顶部显示黄色警告提示
- 提示联系管理员增加配额

**配额恢复**:
- 超管在 `/platform/partners` 编辑代理商
- 增加 `license_quota` 字段
- 代理商控制台自动刷新可用配额

### 状态标签说明

**License 状态**:
- `active` (绿色): 正常使用
- `grace` (黄色): 已过期，宽限期内
- `expired` (红色): 宽限期已满
- `revoked` (灰色): 已吊销

**佣金状态**:
- `pending` (黄色): 待审核
- `approved` (蓝色): 已批准（关联到对账单）
- `paid` (绿色): 已支付
- `settled` (灰色): 已结算

**对账单状态**:
- `draft` (灰色): 草稿
- `pending` (黄色): 待支付
- `paid` (绿色): 已支付
- `settled` (蓝色): 已结算

## 🎨 UI 设计规范

### 色彩系统

- **主色调**: Blue (#2563EB) - 操作按钮、链接
- **成功色**: Green (#10B981) - 成功状态、佣金金额
- **警告色**: Yellow (#F59E0B) - 宽限期、待处理
- **错误色**: Red (#EF4444) - 过期、挂起
- **中性色**: Gray - 文本、边框、背景

### 响应式设计

- ✅ 支持桌面端（>= 1024px）
- ✅ 支持平板端（>= 768px）
- ⚠️ 移动端（< 768px）未完全优化（建议桌面使用）

### 组件复用

- **Drawer 抽屉**: 复用 `/components/Drawer.tsx`
- **状态标签**: 统一使用 `px-2 py-1 text-xs rounded-full` 样式
- **表格**: 统一使用 `divide-y divide-gray-200` 分隔线
- **按钮**: 统一使用 `rounded-lg` 圆角

## 🔌 API 集成

### 请求流程

```typescript
// 1. 导入 API
import { partnerAPI, adminPartnerAPI } from '@/lib/api'

// 2. 调用 API
const res = await partnerAPI.issueLicense(data)

// 3. 处理响应
const { license_id, license_file, commission_amount } = res.data
```

### 错误处理

所有 API 调用已集成统一错误处理：
- 自动显示 Toast 通知（可通过 `suppressErrorToast` 关闭）
- 401 自动跳转登录
- 403 显示权限错误
- 其他错误显示后端返回的 `error` 字段

### 认证

- JWT Token 自动从 `localStorage.getItem('token')` 读取
- 自动注入 `Authorization: Bearer <token>` 请求头
- 无需手动处理

## 🐛 已知问题

1. **移动端适配**: 表格在小屏幕上可能横向滚动
2. **分页性能**: 大数据量时建议增加虚拟滚动
3. **License 文件预览**: 当前仅支持下载，未实现在线预览

## 📝 后续优化建议

### 短期（1-2 周）

1. **License 续费功能**:
   - 在 License 列表添加「续费」按钮
   - 复用签发抽屉，自动填充原配置

2. **搜索与筛选**:
   - License 列表：客户名称搜索、状态筛选
   - 佣金列表：状态筛选、时间范围
   - 对账单：账期筛选

3. **导出功能**:
   - License 列表导出 Excel
   - 佣金记录导出 Excel
   - 对账单导出 PDF

### 中期（1-2 月）

1. **图表统计**:
   - 概览页添加 License 签发趋势图（ECharts/Chart.js）
   - 佣金收入趋势图
   - 版本/模块分布饼图

2. **批量操作**:
   - 批量导入客户信息（Excel）
   - 批量签发 License

3. **License 详情页**:
   - 点击 License 查看完整信息
   - 显示签名验证状态
   - 显示客户部署指纹

### 长期（3-6 月）

1. **自助注册**:
   - 代理商自助申请
   - 超管审批工作流

2. **邮件通知**:
   - License 签发成功邮件
   - 配额不足预警邮件
   - 对账单生成通知邮件

3. **移动端 App**:
   - React Native / Flutter 实现
   - 扫码签发 License
   - 佣金实时推送

## 🔗 相关文档

- **后端 API 文档**: `/docs/partner-system-guide.md`
- **数据库设计**: `/migrations/062_partner_system.sql`
- **实施报告**: `/PARTNER_SYSTEM_IMPLEMENTATION.md`

---

**创建日期**: 2026-09-01
**版本**: v1.0
**状态**: ✅ 已完成
