-- SSO PKCE 支持（Mind「前端业务接入」流程）
--
-- Mind 前端接入要求 OAuth2 Authorization Code + PKCE：
--   * authorize 时带 code_challenge / code_challenge_method=S256
--   * 换 token 时带 code_verifier
-- 我们让后端在 authorize 时生成 verifier 并存这里（按 state 关联），
-- 前端无感知；exchange 时按 state 取回 verifier 完成 token 换取。
--
-- 同时记录 authorize 时实际使用的 OAuth redirect_uri（前端回调页），
-- 因为 token 换取时 redirect_uri 必须与 authorize 时完全一致。

ALTER TABLE management.sso_states
    ADD COLUMN IF NOT EXISTS code_verifier VARCHAR(200);

ALTER TABLE management.sso_states
    ADD COLUMN IF NOT EXISTS oauth_redirect_uri VARCHAR(1000);
