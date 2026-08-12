-- 项目 REST API 接口文档的公开分享
--
-- 给每个数据库连接一个可开关的公开文档链接：<origin>/doc/api/<token>。
-- 未登录的人凭 token 即可查看该库自动 REST/RPC/DDL API 的接口文档（固定 public schema）。
--
--   rest_doc_share_token   —— 公开链接标识（`dr_` 前缀 + 随机 hex）；开启分享时若为空则生成，
--                            一经生成永久保留；与 API Key（ob_）/工作流文档（ds_）命名空间独立。
--   rest_doc_share_enabled —— 开关。关闭仅置 false（token 保留），重开复用同一 token；
--                            关闭后公开接口对该 token 返回 404，链接立即失效。
--
-- 公开接口（GET /api/public/rest-api-doc/:token）只返回 database_slug / schema / 项目名，
-- 不连接租户库、不列出表名（文档正文为静态模板）。
ALTER TABLE management.tenant_databases
    ADD COLUMN IF NOT EXISTS rest_doc_share_token   VARCHAR(64) UNIQUE,
    ADD COLUMN IF NOT EXISTS rest_doc_share_enabled BOOLEAN NOT NULL DEFAULT false;

-- 公开接口按 token 查询，命中条件含 enabled = true。
CREATE INDEX IF NOT EXISTS idx_tenant_databases_rest_doc_share_token
    ON management.tenant_databases(rest_doc_share_token)
    WHERE rest_doc_share_token IS NOT NULL;
