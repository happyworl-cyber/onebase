-- 演示数据命名对齐当前 IA：organizations = 租户（公司），tenants = 项目。
--
-- 历史问题：003 早期把演示行种在 management.tenants 里（当时这张表确实代表
-- "租户"），叫「示例公司A/B」；060 引入 organizations 层时又用
-- `left(t.name, 100)` 把项目名原样复制成组织名。结果同一套演示数据在两层
-- 里同名，工作区侧栏的切换器会出现两行一模一样的文字。
--
-- 这里统一成：项目层 → 示例项目X，租户层 → 示例公司X。
-- 003 / init_multitenant.sql 的种子已改为直接写「示例项目X」，所以：
--   · 全新库：tenants 已是示例项目X，060 复制出的 organizations 需要改回公司名
--   · 已部署库：tenants 仍是旧的示例公司X，需要改成项目名；organizations 本就正确
-- 两条路径都会收敛到同一结果。
--
-- 幂等 + 安全：WHERE 同时限定 slug 和"仍是出厂默认名"，客户自己重命名过的
-- 租户/项目一律不碰。重复执行无副作用。

-- 项目层：把遗留的「示例公司X」改成「示例项目X」
UPDATE management.tenants
SET name = '示例项目A'
WHERE slug = 'company-a' AND name = '示例公司A';

UPDATE management.tenants
SET name = '示例项目B'
WHERE slug = 'company-b' AND name = '示例公司B';

-- 租户层：060 从项目名复制过来的「示例项目X」改回「示例公司X」
UPDATE management.organizations
SET name = '示例公司A'
WHERE slug = 'company-a' AND name = '示例项目A';

UPDATE management.organizations
SET name = '示例公司B'
WHERE slug = 'company-b' AND name = '示例项目B';
