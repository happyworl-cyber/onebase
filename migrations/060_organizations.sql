-- ============================================================
-- 060: Organization (租户) → Project (tenants) 层级
-- ============================================================
-- 产品：租户/组织 → 项目
-- DB：新增 organizations；现有 management.tenants 语义变为项目，
--     增加 organization_id。资源表仍挂 tenant_id（= project id）。
-- 存量：每个 tenants 行 → 一个同名组织 + 回填；user_tenants 派生
--     organization_members（viewer/member → member）。

CREATE TABLE IF NOT EXISTS management.organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, deleted
    contact_email VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS management.organization_members (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER NOT NULL REFERENCES management.organizations(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- owner | admin | member
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, organization_id),
    CONSTRAINT organization_members_role_check
        CHECK (role IN ('owner', 'admin', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user_id
    ON management.organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_org_id
    ON management.organization_members(organization_id);

ALTER TABLE management.tenants
    ADD COLUMN IF NOT EXISTS organization_id INTEGER
        REFERENCES management.organizations(id);

-- ─── 回填：每个尚未归属的项目 → 同名组织 ─────────────────────
DO $$
DECLARE
    t RECORD;
    org_id INTEGER;
    base_slug TEXT;
    candidate TEXT;
BEGIN
    FOR t IN
        SELECT id, name, slug, status, contact_email, created_at, updated_at
        FROM management.tenants
        WHERE organization_id IS NULL
        ORDER BY id
    LOOP
        base_slug := left(t.slug, 40);
        candidate := base_slug;
        IF EXISTS (SELECT 1 FROM management.organizations WHERE slug = candidate) THEN
            candidate := left(base_slug, 40) || '-' || t.id::text;
        END IF;
        -- 仍冲突则再拼随机后缀（极端情况）
        WHILE EXISTS (SELECT 1 FROM management.organizations WHERE slug = candidate) LOOP
            candidate := left(base_slug, 30) || '-' || t.id::text || '-' || substr(md5(random()::text), 1, 6);
        END LOOP;

        INSERT INTO management.organizations (name, slug, status, contact_email, created_at, updated_at)
        VALUES (
            left(t.name, 100),
            candidate,
            CASE WHEN t.status IN ('active', 'suspended', 'deleted') THEN t.status ELSE 'active' END,
            t.contact_email,
            COALESCE(t.created_at, CURRENT_TIMESTAMP),
            COALESCE(t.updated_at, CURRENT_TIMESTAMP)
        )
        RETURNING id INTO org_id;

        UPDATE management.tenants
        SET organization_id = org_id
        WHERE id = t.id;
    END LOOP;
END $$;

-- 从项目成员派生组织成员（同用户同组织取最高角色）
INSERT INTO management.organization_members (user_id, organization_id, role, is_active, created_at)
SELECT
    ut.user_id,
    t.organization_id,
    CASE
        WHEN bool_or(ut.role = 'owner') THEN 'owner'
        WHEN bool_or(ut.role = 'admin') THEN 'admin'
        ELSE 'member'
    END AS role,
    bool_or(COALESCE(ut.is_active, true)) AS is_active,
    MIN(ut.created_at) AS created_at
FROM management.user_tenants ut
JOIN management.tenants t ON t.id = ut.tenant_id
WHERE t.organization_id IS NOT NULL
GROUP BY ut.user_id, t.organization_id
ON CONFLICT (user_id, organization_id) DO UPDATE SET
    role = CASE
        WHEN management.organization_members.role = 'owner'
          OR EXCLUDED.role = 'owner' THEN 'owner'
        WHEN management.organization_members.role = 'admin'
          OR EXCLUDED.role = 'admin' THEN 'admin'
        ELSE 'member'
    END,
    is_active = management.organization_members.is_active OR EXCLUDED.is_active;

-- 迁移后强制非空
ALTER TABLE management.tenants
    ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_organization_id
    ON management.tenants(organization_id);

DROP TRIGGER IF EXISTS update_organizations_updated_at ON management.organizations;
CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON management.organizations
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

COMMENT ON TABLE management.organizations IS
    '产品「租户/组织」：一个组织下可有多个项目（management.tenants）';
COMMENT ON TABLE management.organization_members IS
    '组织成员：owner/admin/member；进项目仍需 user_tenants';
COMMENT ON COLUMN management.tenants.organization_id IS
    '所属组织；tenants 行语义为项目（project），tenant_id 在 API/header 中仍表示 project id';
