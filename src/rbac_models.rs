use serde::{Deserialize, Serialize};

/// 应用层角色
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Role {
    pub id: i32,
    pub tenant_id: i32,
    pub name: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 权限定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Permission {
    pub id: i32,
    pub tenant_id: i32,
    /// 资源标识，格式: "schema.table"
    pub resource: String,
    /// 操作: SELECT / INSERT / UPDATE / DELETE / ALL
    pub action: String,
    /// 行级过滤条件数组，运行时注入 WHERE
    /// 支持 `:current_user_id` 变量替换
    pub conditions: serde_json::Value,
    /// 允许访问的列（null = 全部允许）
    pub allowed_columns: Option<serde_json::Value>,
    /// 禁止访问的列
    pub denied_columns: serde_json::Value,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 用户-角色绑定
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRole {
    pub id: i32,
    pub user_id: i32,
    pub role_id: i32,
    pub tenant_id: i32,
    pub role_name: Option<String>,
    pub created_at: String,
}

/// 创建角色请求
#[derive(Debug, Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    pub description: Option<String>,
}

/// 更新角色请求
#[derive(Debug, Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// 创建权限请求
#[derive(Debug, Deserialize)]
pub struct CreatePermissionRequest {
    pub resource: String,
    pub action: String,
    #[serde(default = "default_conditions")]
    pub conditions: serde_json::Value,
    pub allowed_columns: Option<serde_json::Value>,
    #[serde(default = "default_conditions")]
    pub denied_columns: serde_json::Value,
    pub description: Option<String>,
}

fn default_conditions() -> serde_json::Value {
    serde_json::json!([])
}

/// 更新权限请求
#[derive(Debug, Deserialize)]
pub struct UpdatePermissionRequest {
    pub resource: Option<String>,
    pub action: Option<String>,
    pub conditions: Option<serde_json::Value>,
    pub allowed_columns: Option<serde_json::Value>,
    pub denied_columns: Option<serde_json::Value>,
    pub description: Option<String>,
}

/// 设置角色权限请求（全量替换）
#[derive(Debug, Deserialize)]
pub struct SetRolePermissionsRequest {
    pub permission_ids: Vec<i32>,
}

/// 用户角色分配请求
#[derive(Debug, Deserialize)]
pub struct AssignRoleRequest {
    pub role_id: i32,
    pub tenant_id: i32,
}

/// 行级过滤条件支持的操作符（白名单，避免任意 SQL 注入）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowOp {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    IsNull,
    IsNotNull,
}

impl RowOp {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "=" | "eq" => Some(Self::Eq),
            "!=" | "<>" | "neq" => Some(Self::Neq),
            ">" | "gt" => Some(Self::Gt),
            ">=" | "gte" => Some(Self::Gte),
            "<" | "lt" => Some(Self::Lt),
            "<=" | "lte" => Some(Self::Lte),
            "in" => Some(Self::In),
            "is_null" | "is null" => Some(Self::IsNull),
            "is_not_null" | "is not null" => Some(Self::IsNotNull),
            _ => None,
        }
    }

    /// 是否需要值（IS NULL / IS NOT NULL 不需要）
    pub fn requires_value(&self) -> bool {
        !matches!(self, Self::IsNull | Self::IsNotNull)
    }

    /// 渲染为 SQL 操作符片段
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Eq => "=",
            Self::Neq => "!=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::In => "IN",
            Self::IsNull => "IS NULL",
            Self::IsNotNull => "IS NOT NULL",
        }
    }
}

/// 单条结构化行级条件（已替换 :current_user_id 等变量）
///
/// SQL 拼接时 field/op 来自白名单或受控来源，value 始终通过 bind 注入，
/// 杜绝拼接式 SQL 注入。
#[derive(Debug, Clone)]
pub struct RowCondition {
    pub field: String,
    pub op: RowOp,
    /// 操作符需要值时使用：
    /// - Eq/Neq/Gt/Gte/Lt/Lte：单值（serde_json::Value）
    /// - In：JSON Array
    /// - IsNull/IsNotNull：忽略
    pub value: serde_json::Value,
}

/// 权限校验的最终结果，注入到请求扩展中供 handler 使用
#[derive(Debug, Clone)]
pub struct PermissionResult {
    /// 是否允许访问
    #[allow(dead_code)]
    pub allowed: bool,
    /// 行级过滤条件（结构化、参数化）
    pub row_conditions: Vec<RowCondition>,
    /// 允许的列列表（None = 全部允许）
    pub allowed_columns: Option<Vec<String>>,
    /// 是否为超管（跳过所有限制）
    #[allow(dead_code)]
    pub is_superadmin: bool,
}

impl PermissionResult {
    /// 创建一个超管结果（无任何限制）
    pub fn superadmin() -> Self {
        Self {
            allowed: true,
            row_conditions: vec![],
            allowed_columns: None,
            is_superadmin: true,
        }
    }

    /// 创建一个拒绝结果
    pub fn denied() -> Self {
        Self {
            allowed: false,
            row_conditions: vec![],
            allowed_columns: None,
            is_superadmin: false,
        }
    }
}

/// 标识符校验：只允许字母数字和下划线，且不以数字开头
pub fn is_safe_identifier(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 解析存储于 `permissions.conditions` 的 JSON 数组为结构化 `RowCondition` 列表
///
/// 期望格式（每个元素必须是对象）：
/// ```json
/// [
///   {"field": "author_id", "op": "=",  "value": "$current_user_id"},
///   {"field": "status",    "op": "in", "value": ["published","draft"]}
/// ]
/// ```
///
/// 不再支持任何形式的字符串裸 SQL（如 `"author_id = :current_user_id"`）；
/// 凡解析失败的条件被视为权限不可用，调用方应当拒绝该次访问。
pub fn parse_row_conditions(
    raw: &serde_json::Value,
    current_user_id: i32,
) -> Result<Vec<RowCondition>, String> {
    let arr = match raw.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
    };

    let mut out = Vec::with_capacity(arr.len());
    for (idx, item) in arr.iter().enumerate() {
        let obj = item.as_object().ok_or_else(|| {
            format!(
                "conditions[{}] 必须是对象 {{field, op, value}}，不再支持裸 SQL 字符串",
                idx
            )
        })?;

        let field = obj
            .get("field")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("conditions[{}] 缺少 field", idx))?
            .to_string();
        if !is_safe_identifier(&field) {
            return Err(format!("conditions[{}] field 非法: {}", idx, field));
        }

        let op_str = obj
            .get("op")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("conditions[{}] 缺少 op", idx))?;
        let op = RowOp::parse(op_str)
            .ok_or_else(|| format!("conditions[{}] 不支持的 op: {}", idx, op_str))?;

        let raw_value = obj.get("value").cloned().unwrap_or(serde_json::Value::Null);
        let value = resolve_value_template(raw_value, current_user_id);

        if op == RowOp::In {
            if !value.is_array() {
                return Err(format!("conditions[{}] op=in 时 value 必须是数组", idx));
            }
        } else if op.requires_value() && value.is_null() {
            return Err(format!("conditions[{}] op={} 需要 value", idx, op_str));
        }

        out.push(RowCondition { field, op, value });
    }

    Ok(out)
}

/// 替换 value 中的特殊占位符（仅替换字面字符串 `$current_user_id`）
fn resolve_value_template(value: serde_json::Value, current_user_id: i32) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) if s == "$current_user_id" => {
            serde_json::Value::Number(current_user_id.into())
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|v| resolve_value_template(v, current_user_id))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_eq_with_user_id_template() {
        let raw = serde_json::json!([
            {"field": "author_id", "op": "=", "value": "$current_user_id"}
        ]);
        let conds = parse_row_conditions(&raw, 42).unwrap();
        assert_eq!(conds.len(), 1);
        assert_eq!(conds[0].field, "author_id");
        assert_eq!(conds[0].op, RowOp::Eq);
        assert_eq!(conds[0].value, serde_json::json!(42));
    }

    #[test]
    fn test_parse_in_array() {
        let raw = serde_json::json!([
            {"field": "status", "op": "in", "value": ["published","draft"]}
        ]);
        let conds = parse_row_conditions(&raw, 1).unwrap();
        assert_eq!(conds[0].op, RowOp::In);
        assert!(conds[0].value.is_array());
    }

    #[test]
    fn test_parse_is_null_no_value() {
        let raw = serde_json::json!([
            {"field": "deleted_at", "op": "is_null"}
        ]);
        let conds = parse_row_conditions(&raw, 1).unwrap();
        assert_eq!(conds[0].op, RowOp::IsNull);
    }

    #[test]
    fn test_parse_rejects_legacy_string_form() {
        // 旧格式（裸 SQL 字符串）必须被拒绝，避免注入
        let raw = serde_json::json!(["author_id = :current_user_id"]);
        let result = parse_row_conditions(&raw, 1);
        assert!(result.is_err(), "字符串形式必须被拒绝");
    }

    #[test]
    fn test_parse_rejects_dangerous_field() {
        let raw = serde_json::json!([
            {"field": "id; DROP TABLE users; --", "op": "=", "value": 1}
        ]);
        assert!(parse_row_conditions(&raw, 1).is_err());
    }

    #[test]
    fn test_parse_rejects_unknown_op() {
        let raw = serde_json::json!([
            {"field": "id", "op": "OR 1=1", "value": 1}
        ]);
        assert!(parse_row_conditions(&raw, 1).is_err());
    }

    #[test]
    fn test_permission_result_superadmin() {
        let r = PermissionResult::superadmin();
        assert!(r.allowed);
        assert!(r.is_superadmin);
        assert!(r.row_conditions.is_empty());
        assert!(r.allowed_columns.is_none());
    }

    #[test]
    fn test_permission_result_denied() {
        let r = PermissionResult::denied();
        assert!(!r.allowed);
        assert!(!r.is_superadmin);
    }

    #[test]
    fn test_create_role_request_deserialize() {
        let json = r#"{"name":"editor","description":"Can edit content"}"#;
        let req: CreateRoleRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.name, "editor");
        assert_eq!(req.description.unwrap(), "Can edit content");
    }

    #[test]
    fn test_create_permission_request_defaults() {
        let json = r#"{"resource":"public.posts","action":"SELECT"}"#;
        let req: CreatePermissionRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.conditions, serde_json::json!([]));
        assert_eq!(req.denied_columns, serde_json::json!([]));
        assert!(req.allowed_columns.is_none());
    }

    #[test]
    fn test_create_permission_with_conditions() {
        let json = r#"{
            "resource": "public.posts",
            "action": "SELECT",
            "conditions": ["author_id = :current_user_id"],
            "allowed_columns": ["id", "title", "content"],
            "description": "Authors see own posts"
        }"#;
        let req: CreatePermissionRequest = serde_json::from_str(json).unwrap();
        let conds = req.conditions.as_array().unwrap();
        assert_eq!(conds.len(), 1);
        assert_eq!(
            req.allowed_columns.unwrap(),
            serde_json::json!(["id", "title", "content"])
        );
    }
}
