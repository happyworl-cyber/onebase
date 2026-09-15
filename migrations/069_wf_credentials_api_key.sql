-- 069: 项目凭证增加 api_key 非机密请求头名；kind 仍由 handler 校验。
ALTER TABLE management.wf_credentials
    ADD COLUMN IF NOT EXISTS header_name VARCHAR(128);

COMMENT ON COLUMN management.wf_credentials.header_name IS
    'api_key 请求头名；空则运行时按 X-API-Key。可回显。';
