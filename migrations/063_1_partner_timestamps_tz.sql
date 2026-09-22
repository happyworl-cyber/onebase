-- 代理商模块时间列统一为 TIMESTAMPTZ
--
-- 背景：062 最初把 partners / customer_licenses / partner_commissions /
-- partner_statements 的时间列建成 `TIMESTAMP`（without time zone），但
-- src/partner_models.rs 里对应字段全部声明为 `chrono::DateTime<Utc>`。
-- sqlx 把 `DateTime<Tz>` 严格映射到 TIMESTAMPTZ 且不做隐式兼容，于是：
--   · 读：query_as::<_, CustomerLicense> 报 "mismatched types ... TIMESTAMPTZ
--     is not compatible with SQL type TIMESTAMP"
--   · 写：bind(DateTime<Utc>) 进 TIMESTAMP 列同样类型不符
-- 062 已改为直接建 TIMESTAMPTZ；本步骤负责把**已经建好旧列的库**就地转换。
--
-- 幂等：列已是 timestamptz 时整段直接返回，不加锁、不重写表。
-- 注意：v_partner_stats 引用这些列，ALTER TYPE 前必须先移除；紧随其后的
-- 064 会 DROP VIEW IF EXISTS + CREATE VIEW 重建它，所以这里只管删。

DO $$
DECLARE
    col record;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'management'
          AND table_name IN (
              'partners', 'partner_users', 'customer_licenses',
              'partner_commissions', 'partner_statements'
          )
          AND data_type = 'timestamp without time zone'
    ) THEN
        RETURN;
    END IF;

    DROP VIEW IF EXISTS management.v_partner_stats;

    FOR col IN
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'management'
          AND table_name IN (
              'partners', 'partner_users', 'customer_licenses',
              'partner_commissions', 'partner_statements'
          )
          AND data_type = 'timestamp without time zone'
        ORDER BY table_name, column_name
    LOOP
        -- 旧值按 UTC 解释：这些列的默认值是 CURRENT_TIMESTAMP，容器时区为 UTC。
        EXECUTE format(
            'ALTER TABLE management.%I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
            col.table_name, col.column_name, col.column_name
        );
        RAISE NOTICE '已转换 management.%.% -> timestamptz', col.table_name, col.column_name;
    END LOOP;
END $$;
