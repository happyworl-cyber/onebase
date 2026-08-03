use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::permissions;
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, Row};

/// Schema DDL（CREATE / DROP）必须有 X-Database-Id，否则会落到管理库——一个未带头
/// 的请求若被允许，就能在 management schema 上跑 `DROP SCHEMA management CASCADE`，
/// 这显然不能接受。所以"DDL 前置检查"统一从 request extensions 取，缺失即报错。
fn require_database_id(opt: Option<Extension<CurrentDatabaseId>>) -> Result<i32> {
    opt.map(|Extension(CurrentDatabaseId(id))| id)
        .ok_or_else(|| {
            AppError::InvalidQuery("缺少 X-Database-Id 请求头，无法在租户库上执行 DDL".to_string())
        })
}

/// 目录读取 / DDL 执行必须落在**租户库**上。
///
/// `dynamic_db_middleware` 只有在 `X-Database-Id` 解析成功、且（非超管）校验过租户成员
/// 资格后，才会把租户库连接池注入成 `Extension<PgPool>`。缺失即代表请求没带头 / 头非法 /
/// 指向不存在的库——此时**绝不**回退到 `main_pool`（平台 management 库），否则任何登录
/// 用户都能用 `/api/schemas`、`/api/schema/:s/functions` 等接口枚举 `management.*` 元数据，
/// 甚至读到函数源码 / 触发器体。统一在这里 fail-closed。
fn require_tenant_pool(dynamic_pool: &Option<Extension<PgPool>>) -> Result<&PgPool> {
    dynamic_pool.as_deref().ok_or_else(|| {
        AppError::InvalidQuery(
            "缺少有效的 X-Database-Id 请求头，无法定位目标数据库".to_string(),
        )
    })
}

/// Schema 信息
#[derive(Debug, Serialize)]
pub struct SchemaInfo {
    pub schema_name: String,
    pub table_count: i64,
}

/// 表信息
#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub table_name: String,
    pub table_type: String,
    pub row_count: Option<i64>,
    pub size: Option<String>,
}

/// 列信息
#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub column_name: String,
    pub data_type: String,
    pub is_nullable: String,
    pub column_default: Option<String>,
    pub character_maximum_length: Option<i32>,
    pub numeric_precision: Option<i32>,
    pub numeric_scale: Option<i32>,
    pub ordinal_position: i32,
}

/// 约束信息
#[derive(Debug, Serialize)]
pub struct ConstraintInfo {
    pub constraint_name: String,
    pub constraint_type: String,
    pub column_name: Option<String>,
    pub foreign_table: Option<String>,
    pub foreign_column: Option<String>,
}

/// 索引信息
#[derive(Debug, Serialize)]
pub struct IndexInfo {
    pub index_name: String,
    pub index_type: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub columns: Vec<String>,
    pub index_def: String,
}

/// 外键信息
#[derive(Debug, Serialize)]
pub struct ForeignKeyInfo {
    pub constraint_name: String,
    pub column_name: String,
    pub referenced_table: String,
    pub referenced_column: String,
}

/// 表结构详情
#[derive(Debug, Serialize)]
pub struct TableStructure {
    pub schema_name: String,
    pub table_name: String,
    pub columns: Vec<ColumnInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub row_count: Option<i64>,
    pub table_size: Option<String>,
}

/// 函数 / 存储过程元数据。
///
/// 字段集与前端"函数管理"页直接对齐——之前页面是用 `/query` 跑 raw SQL 拉
/// 这些信息，那条路只对平台超管开放，导致项目成员看不到列表。这里把它包
/// 装成结构化 GET 接口，鉴权层就走 `dynamic_db_middleware`（任意租户成员）
/// 即可，避免给 raw SQL 通道再开口子。
#[derive(Debug, Serialize)]
pub struct FunctionMetadata {
    pub schema_name: String,
    pub function_name: String,
    pub return_type: Option<String>,
    pub argument_types: Option<String>,
    pub function_type: Option<String>,
    pub volatility: Option<String>,
    pub owner: Option<String>,
    pub language: Option<String>,
    pub source_code: Option<String>,
    /// NULL = 用户自建函数；非 NULL = 该函数随某扩展（citext 等）安装进来。
    pub extension_name: Option<String>,
}

/// 触发器元数据，与"触发器管理"页一一对应。
#[derive(Debug, Serialize)]
pub struct TriggerMetadata {
    pub trigger_name: String,
    pub table_name: String,
    pub action_timing: Option<String>,
    pub event_manipulation: Option<String>,
    pub action_orientation: Option<String>,
    pub action_statement: Option<String>,
    pub is_enabled: bool,
}

/// GET /api/schemas - 获取所有 schema 列表
pub async fn list_schemas(
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<SchemaInfo>>> {
    let pool = require_tenant_pool(&dynamic_pool)?;

    // 必须从 information_schema.schemata 枚举命名空间，不能只从 tables 里 GROUP BY：
    // 默认的 public schema 在「零张表」时根本不会出现在 information_schema.tables，
    // 前端就会漏掉 public，和用户在其他客户端里看到的不一致。
    let schemas = sqlx::query(
        r#"
        SELECT
            s.schema_name,
            COALESCE(tc.cnt, 0)::bigint AS table_count
        FROM information_schema.schemata s
        LEFT JOIN (
            SELECT table_schema, COUNT(*)::bigint AS cnt
            FROM information_schema.tables
            WHERE table_type IN ('BASE TABLE', 'VIEW', 'FOREIGN TABLE')
            GROUP BY table_schema
        ) tc ON tc.table_schema = s.schema_name
        WHERE s.catalog_name = current_database()
          AND s.schema_name NOT IN ('pg_catalog', 'information_schema')
          AND s.schema_name NOT LIKE 'pg\_%' ESCAPE '\'
        ORDER BY s.schema_name
        "#,
    )
    .fetch_all(pool)
    .await?;

    let result: Vec<SchemaInfo> = schemas
        .iter()
        .map(|row| SchemaInfo {
            schema_name: row.get("schema_name"),
            table_count: row.get("table_count"),
        })
        .collect();

    Ok(Json(result))
}

/// POST /api/schemas - 创建新 schema
///
/// 鉴权：平台超管 OR 该 database 所属租户的 owner/admin。即使租户成员的 RBAC 配置里
/// 写了 `*.ALL`，没有租户层 owner/admin 也不能跑 DDL——CREATE SCHEMA 是元数据级动作，
/// 不应当通过"普通表权限"扩散获得。
pub async fn create_schema(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let database_id = require_database_id(db_id)?;
    permissions::require_database_admin(&main_pool, &claims, database_id).await?;
    // DDL 必须落到租户库；缺失租户池绝不回退到 management 库（见 require_tenant_pool）。
    let pool = require_tenant_pool(&dynamic_pool)?;

    let schema_name = req["name"]
        .as_str()
        .ok_or_else(|| crate::error::AppError::InvalidQuery("缺少 schema 名称".to_string()))?;

    if !is_valid_schema_name(schema_name) {
        return Err(crate::error::AppError::InvalidQuery(
            "Schema 名称只能包含字母、数字和下划线，且不能以数字开头".to_string(),
        ));
    }

    // 检查 schema 是否已存在
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = $1)",
    )
    .bind(schema_name)
    .fetch_one(pool)
    .await?;

    if exists {
        return Err(crate::error::AppError::InvalidQuery(format!(
            "Schema '{}' 已存在",
            schema_name
        )));
    }

    // 创建 schema
    let sql = format!("CREATE SCHEMA \"{}\"", schema_name);
    sqlx::query(&sql).execute(pool).await?;

    tracing::info!("创建了新 schema: {}", schema_name);

    Ok(Json(serde_json::json!({
        "success": true,
        "message": format!("Schema '{}' 创建成功", schema_name),
        "schema_name": schema_name
    })))
}

fn is_valid_schema_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 {
        return false;
    }
    let first = match name.chars().next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// DELETE /api/schemas/:schema - 删除 schema
///
/// 鉴权同 `create_schema`：需平台超管或租户 owner/admin。
/// 黑名单里的系统 schema（pg_catalog、management 等）无论谁都不能删。
pub async fn drop_schema(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    Path(schema): Path<String>,
    dynamic_pool: Option<Extension<PgPool>>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let database_id = require_database_id(db_id)?;
    permissions::require_database_admin(&main_pool, &claims, database_id).await?;
    // DDL 必须落到租户库；缺失租户池绝不回退到 management 库（见 require_tenant_pool）。
    let pool = require_tenant_pool(&dynamic_pool)?;

    if !is_valid_schema_name(&schema) {
        return Err(crate::error::AppError::InvalidQuery(format!(
            "非法的 schema 名称: '{}'",
            schema
        )));
    }

    let protected_schemas = [
        "public",
        "pg_catalog",
        "information_schema",
        "pg_toast",
        "management",
    ];
    if protected_schemas.contains(&schema.as_str()) {
        return Err(crate::error::AppError::InvalidQuery(format!(
            "不能删除系统 schema '{}'",
            schema
        )));
    }

    // 检查是否强制删除（CASCADE）
    let cascade = req["cascade"].as_bool().unwrap_or(false);

    // 检查 schema 是否存在
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = $1)",
    )
    .bind(&schema)
    .fetch_one(pool)
    .await?;

    if !exists {
        return Err(crate::error::AppError::NotFound(format!(
            "Schema '{}' 不存在",
            schema
        )));
    }

    // 删除 schema
    let sql = if cascade {
        format!("DROP SCHEMA \"{}\" CASCADE", schema)
    } else {
        format!("DROP SCHEMA \"{}\"", schema)
    };

    sqlx::query(&sql).execute(pool).await.map_err(|e| {
        if e.to_string().contains("cannot drop") || e.to_string().contains("not empty") {
            crate::error::AppError::InvalidQuery(format!(
                "Schema '{}' 不为空，请先删除其中的对象或使用 CASCADE 选项",
                schema
            ))
        } else {
            crate::error::AppError::Internal(format!("删除 schema 失败: {}", e))
        }
    })?;

    tracing::info!("删除了 schema: {} (cascade={})", schema, cascade);

    Ok(Json(serde_json::json!({
        "success": true,
        "message": format!("Schema '{}' 删除成功", schema)
    })))
}

/// GET /api/schema/:schema/tables - 获取指定 schema 的所有表
pub async fn list_tables(
    Path(schema): Path<String>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<TableInfo>>> {
    let pool = require_tenant_pool(&dynamic_pool)?;

    // 把 pg_namespace 放到 pg_class 之前先 join，
    // 否则 pg_class 仅按 relname 匹配会把其他 schema 的同名表也带进来，
    // 列表里就会出现 admin_sq_users / article 等表名重复（React duplicate key 警告即源于此）。
    let tables = sqlx::query(
        r#"
        SELECT 
            t.table_name,
            t.table_type,
            pg_class.reltuples::bigint as row_count,
            pg_size_pretty(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name))) as size
        FROM information_schema.tables t
        LEFT JOIN pg_namespace ON pg_namespace.nspname = t.table_schema
        LEFT JOIN pg_class
            ON pg_class.relname = t.table_name
            AND pg_class.relnamespace = pg_namespace.oid
        WHERE t.table_schema = $1
        ORDER BY t.table_name
        "#,
            )
            .bind(&schema)
            .fetch_all(pool)
            .await?;

    let result: Vec<TableInfo> = tables
        .iter()
        .map(|row| TableInfo {
            table_name: row.get("table_name"),
            table_type: row.get("table_type"),
            row_count: row.try_get("row_count").ok(),
            size: row.try_get("size").ok(),
        })
        .collect();

    Ok(Json(result))
}

/// GET /api/schema/:schema/table/:table/structure - 获取表结构详情
pub async fn get_table_structure(
    Path((schema, table)): Path<(String, String)>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<TableStructure>> {
    let pool = require_tenant_pool(&dynamic_pool)?;

    // 获取列信息
    let columns = sqlx::query(
        r#"
        SELECT 
            column_name,
            data_type,
            is_nullable,
            column_default,
            character_maximum_length,
            numeric_precision,
            numeric_scale,
            ordinal_position
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
        "#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(pool)
    .await?;

    let columns_info: Vec<ColumnInfo> = columns
        .iter()
        .map(|row| ColumnInfo {
            column_name: row.get("column_name"),
            data_type: row.get("data_type"),
            is_nullable: row.get("is_nullable"),
            column_default: row.try_get("column_default").ok(),
            character_maximum_length: row.try_get("character_maximum_length").ok(),
            numeric_precision: row.try_get("numeric_precision").ok(),
            numeric_scale: row.try_get("numeric_scale").ok(),
            ordinal_position: row.get("ordinal_position"),
        })
        .collect();

    // 获取约束信息（包括正确的外键引用）
    let constraints = sqlx::query(
        r#"
        SELECT 
            tc.constraint_name,
            tc.constraint_type,
            kcu.column_name,
            CASE 
                WHEN tc.constraint_type = 'FOREIGN KEY' THEN ccu.table_name
                ELSE NULL
            END AS foreign_table,
            CASE 
                WHEN tc.constraint_type = 'FOREIGN KEY' THEN ccu.column_name
                ELSE NULL
            END AS foreign_column
        FROM information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
            AND tc.constraint_schema = rc.constraint_schema
        LEFT JOIN information_schema.constraint_column_usage ccu
            ON rc.unique_constraint_name = ccu.constraint_name
            AND rc.unique_constraint_schema = ccu.constraint_schema
        WHERE tc.table_schema = $1 AND tc.table_name = $2
        ORDER BY tc.constraint_type, tc.constraint_name
        "#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(pool)
    .await?;

    let constraints_info: Vec<ConstraintInfo> = constraints
        .iter()
        .map(|row| ConstraintInfo {
            constraint_name: row.get("constraint_name"),
            constraint_type: row.get("constraint_type"),
            column_name: row.try_get("column_name").ok(),
            foreign_table: row.try_get("foreign_table").ok(),
            foreign_column: row.try_get("foreign_column").ok(),
        })
        .collect();

    // 获取索引信息
    let indexes = sqlx::query(
        r#"
        SELECT
            i.relname as index_name,
            am.amname as index_type,
            ix.indisunique as is_unique,
            ix.indisprimary as is_primary,
            array_agg(a.attname ORDER BY a.attnum) as columns,
            pg_get_indexdef(ix.indexrelid) as index_def
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_am am ON i.relam = am.oid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname = $1 AND t.relname = $2
        GROUP BY i.relname, am.amname, ix.indisunique, ix.indisprimary, ix.indexrelid
        ORDER BY i.relname
        "#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(pool)
    .await?;

    let indexes_info: Vec<IndexInfo> = indexes
        .iter()
        .map(|row| {
            let columns_array: Vec<String> = row.get::<Vec<String>, _>("columns");
            IndexInfo {
                index_name: row.get("index_name"),
                index_type: row.get("index_type"),
                is_unique: row.get("is_unique"),
                is_primary: row.get("is_primary"),
                columns: columns_array,
                index_def: row.get("index_def"),
            }
        })
        .collect();

    // 获取行数和表大小
    let stats = sqlx::query(
        r#"
        SELECT 
            pg_class.reltuples::bigint as row_count,
            pg_size_pretty(pg_total_relation_size(pg_class.oid)) as table_size
        FROM pg_class
        JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE pg_namespace.nspname = $1 AND pg_class.relname = $2
        "#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_optional(pool)
    .await?;

    let (row_count, table_size) = if let Some(row) = stats {
        (
            row.try_get("row_count").ok(),
            row.try_get("table_size").ok(),
        )
    } else {
        (None, None)
    };

    // 从 constraints 中提取外键信息
    let foreign_keys_info: Vec<ForeignKeyInfo> = constraints_info
        .iter()
        .filter(|c| c.constraint_type == "FOREIGN KEY")
        .filter_map(|c| {
            if let (Some(col), Some(ftable), Some(fcol)) =
                (&c.column_name, &c.foreign_table, &c.foreign_column)
            {
                Some(ForeignKeyInfo {
                    constraint_name: c.constraint_name.clone(),
                    column_name: col.clone(),
                    referenced_table: ftable.clone(),
                    referenced_column: fcol.clone(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(Json(TableStructure {
        schema_name: schema,
        table_name: table,
        columns: columns_info,
        constraints: constraints_info,
        indexes: indexes_info,
        foreign_keys: foreign_keys_info,
        row_count,
        table_size,
    }))
}

/// GET /api/schema/:schema/table/:table/relationships - 获取表的关系图数据
pub async fn get_table_relationships(
    Path((schema, table)): Path<(String, String)>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Value>> {
    let pool = require_tenant_pool(&dynamic_pool)?;

    // 获取该表引用的其他表（外键）
    let foreign_keys = sqlx::query(
        r#"
        SELECT
            tc.constraint_name,
            kcu.column_name,
            ccu.table_schema AS foreign_schema,
            ccu.table_name AS foreign_table,
            ccu.column_name AS foreign_column
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        "#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(pool)
    .await?;

    // 获取引用该表的其他表（被引用）
    let referenced_by = sqlx::query(
        r#"
        SELECT
            tc.table_schema,
            tc.table_name,
            tc.constraint_name,
            kcu.column_name,
            ccu.column_name AS foreign_column
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_schema = $1
            AND ccu.table_name = $2
        "#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(pool)
    .await?;

    let fk_list: Vec<Value> = foreign_keys
        .iter()
        .map(|row| {
            serde_json::json!({
                "constraint_name": row.get::<String, _>("constraint_name"),
                "column": row.get::<String, _>("column_name"),
                "foreign_schema": row.get::<String, _>("foreign_schema"),
                "foreign_table": row.get::<String, _>("foreign_table"),
                "foreign_column": row.get::<String, _>("foreign_column"),
            })
        })
        .collect();

    let ref_list: Vec<Value> = referenced_by
        .iter()
        .map(|row| {
            serde_json::json!({
                "schema": row.get::<String, _>("table_schema"),
                "table": row.get::<String, _>("table_name"),
                "constraint_name": row.get::<String, _>("constraint_name"),
                "column": row.get::<String, _>("column_name"),
                "foreign_column": row.get::<String, _>("foreign_column"),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "foreign_keys": fk_list,
        "referenced_by": ref_list,
    })))
}

/// GET /api/schema/:schema/functions
///
/// 列出该 schema 下所有函数 / 存储过程的元数据。鉴权由路由层
/// `auth + dynamic_db_middleware` 兜底——`X-Database-Id` 必须存在且当前
/// 用户是该租户成员。
///
/// 与同 schema 的 `list_tables` 同档：纯只读、纯 catalog 元信息，给"函数
/// 管理"页拉表用。原先页面走 `/query`（raw SQL）现在改走这条结构化通路，
/// 所以项目 owner/admin/member/viewer 都能看到列表。
///
/// 过滤规则与原前端 SQL 对齐：仅 `prokind IN ('f', 'p')`（function /
/// procedure），把聚合函数 `a` 与窗口函数 `w` 留给将来做单独 UI；同时
/// `LEFT JOIN pg_depend / pg_extension` 把扩展（citext / pg_trgm 等）
/// 带来的同名重载函数标出来，前端默认折叠隐藏。
pub async fn list_functions(
    Path(schema): Path<String>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<FunctionMetadata>>> {
    let pool = require_tenant_pool(&dynamic_pool)?;

    let rows = sqlx::query(
        r#"
        SELECT
            n.nspname                          AS schema_name,
            p.proname                          AS function_name,
            pg_get_function_result(p.oid)      AS return_type,
            pg_get_function_arguments(p.oid)   AS argument_types,
            CASE p.prokind
                WHEN 'f' THEN 'function'
                WHEN 'p' THEN 'procedure'
                WHEN 'a' THEN 'aggregate'
                WHEN 'w' THEN 'window'
            END                                AS function_type,
            CASE p.provolatile
                WHEN 'i' THEN 'IMMUTABLE'
                WHEN 's' THEN 'STABLE'
                WHEN 'v' THEN 'VOLATILE'
            END                                AS volatility,
            pg_get_userbyid(p.proowner)        AS owner,
            l.lanname                          AS language,
            pg_get_functiondef(p.oid)          AS source_code,
            e.extname                          AS extension_name
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        JOIN pg_language  l ON p.prolang     = l.oid
        LEFT JOIN pg_depend d
            ON d.objid    = p.oid
           AND d.deptype  = 'e'
           AND d.classid  = 'pg_proc'::regclass
        LEFT JOIN pg_extension e ON e.oid = d.refobjid
        WHERE n.nspname = $1
          AND p.prokind IN ('f', 'p')
        ORDER BY p.proname
        "#,
    )
    .bind(&schema)
    .fetch_all(pool)
    .await?;

    let result: Vec<FunctionMetadata> = rows
        .iter()
        .map(|row| FunctionMetadata {
            schema_name: row.get("schema_name"),
            function_name: row.get("function_name"),
            return_type: row.try_get("return_type").ok(),
            argument_types: row.try_get("argument_types").ok(),
            function_type: row.try_get("function_type").ok(),
            volatility: row.try_get("volatility").ok(),
            owner: row.try_get("owner").ok(),
            language: row.try_get("language").ok(),
            // pg_get_functiondef 在极个别 internal 函数上会抛错。这里 try_get
            // 取不到就当 None；前端"详情"面板会显示"暂无源码"。
            source_code: row.try_get("source_code").ok(),
            extension_name: row.try_get("extension_name").ok(),
        })
        .collect();

    Ok(Json(result))
}

/// GET /api/schema/:schema/triggers
///
/// 列出该 schema 下所有 *用户* 触发器（`pg_trigger.tgisinternal = false`）
/// 的元数据。鉴权同 `list_functions`：路由层把住租户成员。
///
/// 字段做位运算解码 `pg_trigger.tgtype`：
///   - bit 1 (`& 1`) = ROW vs STATEMENT
///   - bit 2 (`& 2`) = BEFORE
///   - bit 6 (`& 64`) = INSTEAD OF
///   - 否则             = AFTER
///   - bit 4/8/16/32  = INSERT / DELETE / UPDATE / TRUNCATE
/// 这套位定义见 PG 源码 `src/include/catalog/pg_trigger.h`，多个事件可同时
/// 命中所以输出用 `array_to_string(... ' OR ')` 拼。
pub async fn list_triggers(
    Path(schema): Path<String>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<TriggerMetadata>>> {
    let pool = require_tenant_pool(&dynamic_pool)?;

    let rows = sqlx::query(
        r#"
        SELECT
            t.tgname AS trigger_name,
            c.relname AS table_name,
            CASE
                WHEN t.tgtype & 2  > 0 THEN 'BEFORE'
                WHEN t.tgtype & 64 > 0 THEN 'INSTEAD OF'
                ELSE                        'AFTER'
            END AS action_timing,
            array_to_string(
                ARRAY[
                    CASE WHEN t.tgtype & 4  > 0 THEN 'INSERT'   END,
                    CASE WHEN t.tgtype & 8  > 0 THEN 'DELETE'   END,
                    CASE WHEN t.tgtype & 16 > 0 THEN 'UPDATE'   END,
                    CASE WHEN t.tgtype & 32 > 0 THEN 'TRUNCATE' END
                ]::text[],
                ' OR '
            ) AS event_manipulation,
            CASE WHEN t.tgtype & 1 > 0 THEN 'ROW' ELSE 'STATEMENT' END
                AS action_orientation,
            pg_get_triggerdef(t.oid) AS action_statement,
            t.tgenabled != 'D'       AS is_enabled
        FROM pg_trigger t
        JOIN pg_class c     ON t.tgrelid    = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = $1
          AND NOT t.tgisinternal
        ORDER BY t.tgname
        "#,
    )
    .bind(&schema)
    .fetch_all(pool)
    .await?;

    let result: Vec<TriggerMetadata> = rows
        .iter()
        .map(|row| TriggerMetadata {
            trigger_name: row.get("trigger_name"),
            table_name: row.get("table_name"),
            action_timing: row.try_get("action_timing").ok(),
            event_manipulation: row.try_get("event_manipulation").ok(),
            action_orientation: row.try_get("action_orientation").ok(),
            action_statement: row.try_get("action_statement").ok(),
            is_enabled: row.try_get("is_enabled").unwrap_or(true),
        })
        .collect();

    Ok(Json(result))
}
