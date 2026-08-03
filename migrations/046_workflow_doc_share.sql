-- 工作流「接口文档」公开分享
--
-- 给每个工作流一个可开关的公开文档链接：<origin>/doc/<token>。
-- 未登录的人凭 token 即可查看只读接口文档（实时反映工作流当前定义）。
--
--   doc_share_token   —— 公开链接标识（`ds_` 前缀 + 随机 hex）；开启分享时若为空则生成，
--                        一经生成永久保留；与 API Key（cr_/crp_）命名空间独立，泄露它不泄露任何调用凭证。
--   doc_share_enabled —— 开关。关闭仅置 false（token 保留），重开复用同一 token；
--                        关闭后公开接口对该 token 返回 404，链接立即失效。
--
-- 公开接口（GET /api/public/workflow-doc/:token）只返回提炼后的文档数据，不下发 nodes/edges。
ALTER TABLE management.workflows
    ADD COLUMN IF NOT EXISTS doc_share_token   VARCHAR(64) UNIQUE,
    ADD COLUMN IF NOT EXISTS doc_share_enabled BOOLEAN NOT NULL DEFAULT false;

-- 公开接口按 token 查询，命中条件含 enabled = true。
CREATE INDEX IF NOT EXISTS idx_workflows_doc_share_token
    ON management.workflows(doc_share_token)
    WHERE doc_share_token IS NOT NULL;
