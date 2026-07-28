use crate::error::{AppError, Result};
use serde_json::Value;
use sqlx::postgres::PgArguments;
use sqlx::{Arguments, PgPool, Row};
use std::collections::HashMap;

/// 一个白名单：能"安全"作为 `$N::TYPE` cast 目标的 PostgreSQL `udt_name`。
///
/// 拒绝清单外的（数组类型、复合类型、用户自定义类型等）会让占位符回退到不带
/// cast 的形式——此时由 `add_json_value` 兜底，按 sqlx 原生类型分发。
/// 之所以白名单，是因为像 `_int4`（数组的内部名）这种东西生成 `$1::_int4` 会出错。
pub fn safe_cast_target(udt_name: &str) -> Option<&str> {
    match udt_name {
        "int2" | "int4" | "int8"
        | "float4" | "float8" | "numeric"
        | "bool"
        | "text" | "varchar" | "bpchar"
        | "uuid"
        | "date" | "time" | "timetz" | "timestamp" | "timestamptz"
        | "json" | "jsonb"
        | "bytea" => Some(udt_name),
        _ => None,
    }
}

/// 拉取一张表的「列名 → udt_name」映射，用来给占位符决定 cast 目标。
///
/// 这是修复 `column "x" is of type bigint but expression is of type text` 的关键：
/// 对每个占位符显式 cast 成列的真实类型，PG 才会调用对应类型的 input 函数。
pub async fn fetch_column_types(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, String>> {
    let rows = sqlx::query(
        r#"
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.get::<String, _>("column_name"),
                r.get::<String, _>("udt_name"),
            )
        })
        .collect())
}

/// 按 cast 目标把 `serde_json::Value` 绑定到 `PgArguments`。
///
/// - 没有 cast（列类型不在白名单 / 没有列信息）→ 回退到 `add_json_value`：按
///   sqlx 原生类型分发。
/// - cast 目标是 `json` / `jsonb` → 把任何值序列化为 JSON 文本再绑 String，
///   配合 SQL 里的 `$N::jsonb` 让 PG 的 jsonb_in 解析。
/// - 其它已知 cast 目标 → 一律转成 TEXT 字符串绑过去，配合 `$N::TYPE` 让对应
///   input 函数解析（`'0'::int8 = 0`，`'true'::bool = true`，`'2025-...'::timestamptz`）。
pub fn add_value_for_cast(args: &mut PgArguments, value: &Value, cast: Option<&str>) {
    match cast {
        Some("json") | Some("jsonb") => {
            // jsonb 列必须收到合法 JSON 文本，所以容器和标量统一 to_string()
            // （字符串会自动加引号变成 JSON 字符串字面量）。
            args.add(value.to_string());
        }
        Some(_) => {
            // 其它已知标量列：null 单独走 NULL；其余统一转字符串。
            match value {
                Value::Null => args.add(Option::<String>::None),
                Value::Bool(b) => args.add(if *b { "true" } else { "false" }.to_string()),
                Value::Number(n) => args.add(n.to_string()),
                Value::String(s) => args.add(s.clone()),
                // 容器类型 cast 到非 json 列基本是错配，原样发字符串让 PG 报错就行
                Value::Array(_) | Value::Object(_) => args.add(value.to_string()),
            }
        }
        None => add_json_value(args, value),
    }
}

/// 没有列类型信息时的兜底：按 JSON 变体走 sqlx 原生类型。
///
/// 这一步是必须的：sqlx 对 `serde_json::Value` 的默认 `Encode` 实现是 jsonb，
/// 直接 `args.add(&value)` 会让一个看上去普通的 `42` / `"hello"` 也以 jsonb 形式
/// 发到 server 上。当目标列是 `bigint` / `text` / `timestamptz` 等标量类型时，
/// 就会触发 `column "x" is of type bigint but expression is of type jsonb`。
pub fn add_json_value(args: &mut PgArguments, value: &Value) {
    match value {
        Value::Null => args.add(Option::<String>::None),
        Value::Bool(b) => args.add(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                args.add(i);
            } else if let Some(f) = n.as_f64() {
                args.add(f);
            } else {
                args.add(n.to_string());
            }
        }
        Value::String(s) => args.add(s.clone()),
        Value::Array(_) | Value::Object(_) => args.add(value.clone()),
    }
}

/// 查询参数解析器
#[derive(Debug, Default)]
pub struct QueryParams {
    /// WHERE 条件
    pub filters: Vec<Filter>,
    /// 排序字段
    pub order_by: Vec<OrderBy>,
    /// 分页限制
    pub limit: Option<i64>,
    /// 偏移量
    pub offset: Option<i64>,
    /// 选择的字段
    pub select: Option<Vec<String>>,
}

/// 过滤条件
#[derive(Debug, Clone)]
pub struct Filter {
    pub column: String,
    pub operator: FilterOperator,
    pub value: String,
}

/// 过滤操作符
#[derive(Debug, Clone)]
pub enum FilterOperator {
    Eq,          // 等于 (=)
    Neq,         // 不等于 (!=)
    Gt,          // 大于 (>)
    Gte,         // 大于等于 (>=)
    Lt,          // 小于 (<)
    Lte,         // 小于等于 (<=)
    Like,        // 模糊匹配 (LIKE)
    Ilike,       // 不区分大小写模糊匹配 (ILIKE)
    In,          // IN 查询
    Is,          // IS (用于 NULL)
}

/// 排序方向
#[derive(Debug, Clone)]
pub struct OrderBy {
    pub column: String,
    pub ascending: bool,
}

impl QueryParams {
    /// 从 URL 查询参数解析
    pub fn from_query_map(query: HashMap<String, String>) -> Result<Self> {
        let mut params = QueryParams::default();

        for (key, value) in query.iter() {
            match key.as_str() {
                "limit" => {
                    params.limit = Some(
                        value
                            .parse()
                            .map_err(|_| AppError::InvalidQuery("limit 必须是数字".to_string()))?,
                    );
                }
                "offset" => {
                    params.offset = Some(
                        value
                            .parse()
                            .map_err(|_| AppError::InvalidQuery("offset 必须是数字".to_string()))?,
                    );
                }
                "order" => {
                    params.order_by = Self::parse_order(value)?;
                }
                "select" => {
                    params.select = Some(
                        value
                            .split(',')
                            .map(|s| Self::sanitize_identifier(s.trim()))
                            .collect::<Result<Vec<_>>>()?,
                    );
                }
                _ => {
                    // 处理过滤条件
                    if let Some(filter) = Self::parse_filter(key, value)? {
                        params.filters.push(filter);
                    }
                }
            }
        }

        Ok(params)
    }

    /// 解析过滤条件
    fn parse_filter(key: &str, value: &str) -> Result<Option<Filter>> {
        // 支持的格式:
        // column=value (等于)
        // column.eq=value (等于)
        // column.neq=value (不等于)
        // column.gt=value (大于)
        // column.gte=value (大于等于)
        // column.lt=value (小于)
        // column.lte=value (小于等于)
        // column.like=value (模糊匹配)
        // column.ilike=value (不区分大小写模糊匹配)
        // column.in=value1,value2,value3 (IN 查询)
        // column.is=null (IS NULL)

        let parts: Vec<&str> = key.split('.').collect();

        let (column, operator) = match parts.len() {
            1 => (parts[0], FilterOperator::Eq),
            2 => {
                let op = match parts[1] {
                    "eq" => FilterOperator::Eq,
                    "neq" => FilterOperator::Neq,
                    "gt" => FilterOperator::Gt,
                    "gte" => FilterOperator::Gte,
                    "lt" => FilterOperator::Lt,
                    "lte" => FilterOperator::Lte,
                    "like" => FilterOperator::Like,
                    "ilike" => FilterOperator::Ilike,
                    "in" => FilterOperator::In,
                    "is" => FilterOperator::Is,
                    _ => return Ok(None), // 忽略不支持的操作符
                };
                (parts[0], op)
            }
            _ => return Ok(None),
        };

        Self::sanitize_identifier(column)?;

        Ok(Some(Filter {
            column: column.to_string(),
            operator,
            value: value.to_string(),
        }))
    }

    /// 解析排序
    fn parse_order(order_str: &str) -> Result<Vec<OrderBy>> {
        let mut orders = Vec::new();

        for part in order_str.split(',') {
            let part = part.trim();
            let (column, ascending) = if let Some(col) = part.strip_suffix(".desc") {
                (col, false)
            } else if let Some(col) = part.strip_suffix(".asc") {
                (col, true)
            } else {
                (part, true) // 默认升序
            };

            Self::sanitize_identifier(column)?;
            orders.push(OrderBy {
                column: column.to_string(),
                ascending,
            });
        }

        Ok(orders)
    }

    /// 验证标识符安全性 (防止 SQL 注入)
    pub fn sanitize_identifier(ident: &str) -> Result<String> {
        // 只允许字母、数字、下划线
        if ident.is_empty() {
            return Err(AppError::InvalidQuery("标识符不能为空".to_string()));
        }

        if !ident
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_')
        {
            return Err(AppError::InvalidQuery(format!(
                "无效的标识符: {}. 只允许字母、数字和下划线",
                ident
            )));
        }

        if ident.starts_with(|c: char| c.is_ascii_digit()) {
            return Err(AppError::InvalidQuery(
                "标识符不能以数字开头".to_string(),
            ));
        }

        Ok(ident.to_string())
    }
}

/// SQL 查询构建器
pub struct SqlBuilder {
    schema: String,
    table: String,
    params: QueryParams,
    /// 列名 → udt_name 的映射；非空时会给每个 `$N` 加上 `::col_type` cast。
    /// 这是治本：不带 cast 时绑 TEXT / JSONB 都会被 PG 严格拒绝（text → bigint 不是隐式 cast）。
    col_types: HashMap<String, String>,
}

impl SqlBuilder {
    pub fn new(schema: String, table: String, params: QueryParams) -> Result<Self> {
        QueryParams::sanitize_identifier(&schema)?;
        QueryParams::sanitize_identifier(&table)?;

        Ok(Self {
            schema,
            table,
            params,
            col_types: HashMap::new(),
        })
    }

    /// 注入列类型映射（来自 `fetch_column_types`）。建议所有 INSERT / UPDATE
    /// 之前都先注入，避免标量 / 容器与 PG 列类型错配。
    pub fn with_column_types(mut self, col_types: HashMap<String, String>) -> Self {
        self.col_types = col_types;
        self
    }

    /// 给某一列拼出最终的占位符片段（带 cast 时形如 `$N::int8`）。
    fn placeholder(&self, n: i32, col: &str) -> String {
        match self
            .col_types
            .get(col)
            .and_then(|udt| safe_cast_target(udt))
        {
            Some(t) => format!("${}::{}", n, t),
            None => format!("${}", n),
        }
    }

    /// 给某一列查 cast 目标（None 表示无 cast）。
    fn cast_target(&self, col: &str) -> Option<&str> {
        self.col_types
            .get(col)
            .and_then(|udt| safe_cast_target(udt))
    }

    /// 构建 SELECT 查询
    pub fn build_select(&self) -> Result<(String, PgArguments)> {
        let mut args = PgArguments::default();
        let mut arg_index = 1;

        // SELECT 字段
        let select_clause = match &self.params.select {
            Some(fields) => fields.join(", "),
            None => "*".to_string(),
        };

        let mut sql = format!(
            "SELECT {} FROM \"{}\".\"{}\"",
            select_clause, self.schema, self.table
        );

        // WHERE 条件
        if !self.params.filters.is_empty() {
            sql.push_str(" WHERE ");
            let conditions: Vec<String> = self
                .params
                .filters
                .iter()
                .map(|filter| {
                    // 把 query string 里的字符串值按列类型 cast 绑定。
                    // 对于 LIKE / ILIKE 这种文本比较运算符，强行 cast 到 int8 反而会出错；
                    // 因此这两个操作符一律按 text 处理（不带 cast，让 PG 自然推断）。
                    let textual = matches!(filter.operator, FilterOperator::Like | FilterOperator::Ilike);
                    let cast = if textual { None } else { self.cast_target(&filter.column) };
                    let placeholder = match cast {
                        Some(t) => format!("${}::{}", arg_index, t),
                        None => format!("${}", arg_index),
                    };
                    let val = serde_json::Value::String(filter.value.clone());

                    let condition = match filter.operator {
                        FilterOperator::Eq => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" = {}", filter.column, placeholder)
                        }
                        FilterOperator::Neq => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" != {}", filter.column, placeholder)
                        }
                        FilterOperator::Gt => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" > {}", filter.column, placeholder)
                        }
                        FilterOperator::Gte => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" >= {}", filter.column, placeholder)
                        }
                        FilterOperator::Lt => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" < {}", filter.column, placeholder)
                        }
                        FilterOperator::Lte => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" <= {}", filter.column, placeholder)
                        }
                        FilterOperator::Like => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" LIKE {}", filter.column, placeholder)
                        }
                        FilterOperator::Ilike => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" ILIKE {}", filter.column, placeholder)
                        }
                        FilterOperator::In => {
                            let values: Vec<&str> = filter.value.split(',').collect();
                            let placeholders: Vec<String> = values
                                .iter()
                                .map(|v| {
                                    let inner_val = serde_json::Value::String((*v).to_string());
                                    add_value_for_cast(&mut args, &inner_val, cast);
                                    let p = match cast {
                                        Some(t) => format!("${}::{}", arg_index, t),
                                        None => format!("${}", arg_index),
                                    };
                                    arg_index += 1;
                                    p
                                })
                                .collect();
                            arg_index -= 1; // 调整因为循环会再加一次
                            format!("\"{}\" IN ({})", filter.column, placeholders.join(", "))
                        }
                        FilterOperator::Is => {
                            if filter.value.to_lowercase() == "null" {
                                format!("\"{}\" IS NULL", filter.column)
                            } else {
                                format!("\"{}\" IS NOT NULL", filter.column)
                            }
                        }
                    };
                    arg_index += 1;
                    condition
                })
                .collect();
            sql.push_str(&conditions.join(" AND "));
        }

        // ORDER BY
        if !self.params.order_by.is_empty() {
            sql.push_str(" ORDER BY ");
            let orders: Vec<String> = self
                .params
                .order_by
                .iter()
                .map(|order| {
                    format!(
                        "\"{}\" {}",
                        order.column,
                        if order.ascending { "ASC" } else { "DESC" }
                    )
                })
                .collect();
            sql.push_str(&orders.join(", "));
        }

        // LIMIT
        if let Some(limit) = self.params.limit {
            args.add(limit);
            sql.push_str(&format!(" LIMIT ${}", arg_index));
            arg_index += 1;
        }

        // OFFSET
        if let Some(offset) = self.params.offset {
            args.add(offset);
            sql.push_str(&format!(" OFFSET ${}", arg_index));
        }

        Ok((sql, args))
    }

    /// 构建 INSERT 查询
    pub fn build_insert(&self, data: &serde_json::Value) -> Result<(String, PgArguments)> {
        let mut args = PgArguments::default();

        let obj = data
            .as_object()
            .ok_or_else(|| AppError::InvalidQuery("期望 JSON 对象".to_string()))?;

        if obj.is_empty() {
            return Err(AppError::InvalidQuery("插入数据不能为空".to_string()));
        }

        let mut columns = Vec::new();
        let mut placeholders = Vec::new();

        for (i, (key, value)) in obj.iter().enumerate() {
            QueryParams::sanitize_identifier(key)?;
            columns.push(format!("\"{}\"", key));
            // 已知列类型时拼成 `$N::int8` 之类，让 PG 走 input 函数；否则裸 `$N`。
            placeholders.push(self.placeholder((i + 1) as i32, key));
            add_value_for_cast(&mut args, value, self.cast_target(key));
        }

        let sql = format!(
            "INSERT INTO \"{}\".\"{}\" ({}) VALUES ({}) RETURNING *",
            self.schema,
            self.table,
            columns.join(", "),
            placeholders.join(", ")
        );

        Ok((sql, args))
    }

    /// 构建 UPDATE 查询
    pub fn build_update(&self, data: &serde_json::Value) -> Result<(String, PgArguments)> {
        let mut args = PgArguments::default();
        let mut arg_index = 1;

        let obj = data
            .as_object()
            .ok_or_else(|| AppError::InvalidQuery("期望 JSON 对象".to_string()))?;

        if obj.is_empty() {
            return Err(AppError::InvalidQuery("更新数据不能为空".to_string()));
        }

        // 强制 UPDATE 必须带 WHERE，避免无差别全表更新（与 DELETE 对齐）
        if self.params.filters.is_empty() {
            return Err(AppError::InvalidQuery(
                "UPDATE 操作必须提供 WHERE 条件，禁止全表无差别更新".to_string(),
            ));
        }

        let mut set_clauses = Vec::new();
        for (key, value) in obj.iter() {
            QueryParams::sanitize_identifier(key)?;
            set_clauses.push(format!("\"{}\" = {}", key, self.placeholder(arg_index, key)));
            add_value_for_cast(&mut args, value, self.cast_target(key));
            arg_index += 1;
        }

        let mut sql = format!(
            "UPDATE \"{}\".\"{}\" SET {}",
            self.schema,
            self.table,
            set_clauses.join(", ")
        );

        // WHERE 条件（保证非空，已在上面校验过）
        if !self.params.filters.is_empty() {
            sql.push_str(" WHERE ");
            let conditions: Vec<String> = self
                .params
                .filters
                .iter()
                .map(|filter| {
                    // 所有 WHERE 比较都按列类型 cast 一次，否则 `WHERE id = $1`
                    // 在 id 是 bigint 而 $1 是 text 时也会出问题。
                    let placeholder = self.placeholder(arg_index, &filter.column);
                    let cast = self.cast_target(&filter.column);
                    let val = serde_json::Value::String(filter.value.clone());
                    let condition = match filter.operator {
                        FilterOperator::Eq => {
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" = {}", filter.column, placeholder)
                        }
                        _ => {
                            // 老逻辑里这里也是 = ；保留原行为。
                            add_value_for_cast(&mut args, &val, cast);
                            format!("\"{}\" = {}", filter.column, placeholder)
                        }
                    };
                    arg_index += 1;
                    condition
                })
                .collect();
            sql.push_str(&conditions.join(" AND "));
        }

        sql.push_str(" RETURNING *");

        Ok((sql, args))
    }

    /// 构建 DELETE 查询
    pub fn build_delete(&self) -> Result<(String, PgArguments)> {
        let mut args = PgArguments::default();
        let mut arg_index = 1;

        let mut sql = format!("DELETE FROM \"{}\".\"{}\"", self.schema, self.table);

        // WHERE 条件 (DELETE 必须有条件)
        if self.params.filters.is_empty() {
            return Err(AppError::InvalidQuery(
                "DELETE 操作必须提供 WHERE 条件".to_string(),
            ));
        }

        sql.push_str(" WHERE ");
        let conditions: Vec<String> = self
            .params
            .filters
            .iter()
            .map(|filter| {
                let placeholder = self.placeholder(arg_index, &filter.column);
                let cast = self.cast_target(&filter.column);
                let val = serde_json::Value::String(filter.value.clone());
                add_value_for_cast(&mut args, &val, cast);
                let condition = format!("\"{}\" = {}", filter.column, placeholder);
                arg_index += 1;
                condition
            })
            .collect();
        sql.push_str(&conditions.join(" AND "));

        sql.push_str(" RETURNING *");

        Ok((sql, args))
    }
}

