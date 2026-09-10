-- 068: 对象存储增加 Google Cloud Storage（HMAC / S3 互操作）。
--
-- 057 里的 CHECK 是内联匿名约束，PostgreSQL 自动命名为
-- `object_storage_connections_provider_check`。这里先 DROP（IF EXISTS 容忍旧库
-- 没有/已改名），再以同名显式重建——重复跑会命中 "already exists" 被 migrate
-- runner 视为良性 skip。对齐 032_sso_mind_provider.sql。

ALTER TABLE management.object_storage_connections
    DROP CONSTRAINT IF EXISTS object_storage_connections_provider_check;

ALTER TABLE management.object_storage_connections
    ADD CONSTRAINT object_storage_connections_provider_check
    CHECK (provider IN ('minio', 'cos', 'oss', 'gcs'));
