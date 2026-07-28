//! 数据库迁移共享工具
//!
//! 主要解决两件事：
//!
//! 1. **正确切分 SQL**：`str::split(';')` 在 PostgreSQL 场景下有三个坑——
//!    `--` 行注释会把后续语句整段吃掉、`$$ ... $$` 美元引用块（plpgsql 函数体）
//!    里的 `;` 会被误切、`'...'` 字符串字面量里的 `;` 同样会被误切。
//!    `split_sql_statements` 是个微型 SQL 词法器，能正确处理这三种情况。
//!
//! 2. **统一的 runner**：`run_sql_script` 逐条执行切分后的语句，
//!    把"已存在 / 重复键"等幂等再跑可能产生的良性错误识别为 `skipped`，
//!    其他错误打印到 stderr 并累积到 `MigrationStats.errors` 中由调用方决定是否中止。

use sqlx::PgPool;

/// 迁移执行统计
#[derive(Debug, Default, Clone, Copy)]
pub struct MigrationStats {
    pub ok: usize,
    pub skipped: usize,
    pub errors: usize,
}

impl MigrationStats {
    pub fn has_error(&self) -> bool {
        self.errors > 0
    }
}

/// 运行一段 SQL 脚本（多语句），按统一规则统计 ok / skipped / errors。
///
/// - `name` 仅用于错误日志前缀，便于定位是哪个迁移文件。
/// - 切分逻辑见 [`split_sql_statements`]。
/// - 良性错误（"already exists" / "duplicate key" / "IF NOT EXISTS"）→ `skipped`。
/// - 其他错误 → 打印到 stderr，并累计到 `errors` 中，但**不中止**整段脚本。
///   调用方可以根据 `stats.has_error()` 决定是否 `process::exit(1)`。
pub async fn run_sql_script(pool: &PgPool, name: &str, sql: &str) -> MigrationStats {
    let mut stats = MigrationStats::default();

    for stmt in split_sql_statements(sql) {
        if stmt.is_empty() {
            continue;
        }
        match sqlx::query(&stmt).execute(pool).await {
            Ok(_) => stats.ok += 1,
            Err(e) => {
                let msg = e.to_string();
                let is_benign = msg.contains("already exists")
                    || msg.contains("duplicate key")
                    || msg.contains("IF NOT EXISTS");
                if is_benign {
                    stats.skipped += 1;
                } else {
                    eprintln!("    [{}] ERROR: {}", name, msg);
                    stats.errors += 1;
                }
            }
        }
    }

    stats
}

/// 把整段 SQL 切分成独立的 statement 列表。
///
/// 与 `str::split(';')` 的区别：
/// - 正确剥离 `--` 行注释和 `/* */` 块注释（不会把后续语句吃成注释）
/// - 正确处理 `'...'` 单引号字符串（含 `''` 转义）里的 `;`
/// - 正确处理 PostgreSQL 的 `$$ ... $$` / `$tag$ ... $tag$` 美元引用块
///   （函数体里出现的 `;` 不会被当作语句分隔符）
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    enum State {
        Normal,
        SingleQuote,
        DollarQuote(String),
        LineComment,
        BlockComment,
    }

    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut state = State::Normal;
    let mut i = 0;

    while i < n {
        let c = chars[i];
        match &state {
            State::Normal => {
                if c == '\'' {
                    buf.push(c);
                    state = State::SingleQuote;
                    i += 1;
                } else if c == '-' && i + 1 < n && chars[i + 1] == '-' {
                    state = State::LineComment;
                    i += 2;
                } else if c == '/' && i + 1 < n && chars[i + 1] == '*' {
                    state = State::BlockComment;
                    i += 2;
                } else if c == '$' {
                    // 尝试识别 $tag$ 形式（tag 由字母/数字/下划线组成，可为空）
                    let mut j = i + 1;
                    while j < n && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                        j += 1;
                    }
                    if j < n && chars[j] == '$' {
                        let tag: String = chars[i..=j].iter().collect();
                        buf.push_str(&tag);
                        state = State::DollarQuote(tag);
                        i = j + 1;
                    } else {
                        // 不是合法的 $tag$ 起始（例如 bcrypt 的 $2b$ —— tag 合法但
                        // 后面的 $12$ / $...$ 是不同 tag，闭合检测会失败；这里仍按
                        // 普通字符处理，由后续 normal-mode 继续推进）
                        buf.push(c);
                        i += 1;
                    }
                } else if c == ';' {
                    let stmt = buf.trim().to_string();
                    if !stmt.is_empty() {
                        out.push(stmt);
                    }
                    buf.clear();
                    i += 1;
                } else {
                    buf.push(c);
                    i += 1;
                }
            }
            State::SingleQuote => {
                buf.push(c);
                if c == '\'' {
                    if i + 1 < n && chars[i + 1] == '\'' {
                        buf.push('\'');
                        i += 2;
                    } else {
                        state = State::Normal;
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            State::DollarQuote(tag) => {
                let tag = tag.clone();
                let tag_chars: Vec<char> = tag.chars().collect();
                if i + tag_chars.len() <= n && chars[i..i + tag_chars.len()] == tag_chars[..] {
                    buf.push_str(&tag);
                    i += tag_chars.len();
                    state = State::Normal;
                } else {
                    buf.push(c);
                    i += 1;
                }
            }
            State::LineComment => {
                if c == '\n' {
                    buf.push('\n');
                    state = State::Normal;
                }
                i += 1;
            }
            State::BlockComment => {
                if c == '*' && i + 1 < n && chars[i + 1] == '/' {
                    state = State::Normal;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        }
    }

    let tail = buf.trim().to_string();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strips_leading_line_comment() {
        let sql = "-- 注释\nCREATE TABLE t (id int);";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].contains("CREATE TABLE t"));
        assert!(!parts[0].contains("注释"));
    }

    #[test]
    fn test_keeps_dollar_quoted_function_intact() {
        let sql = r#"
            CREATE FUNCTION f() RETURNS TRIGGER AS $$
            BEGIN
                NEW.x = 1;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            CREATE TABLE t (id int);
        "#;
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2, "应该正好两条语句，函数体不被切开");
        assert!(parts[0].contains("RETURN NEW"));
        assert!(parts[0].contains("$$ LANGUAGE plpgsql"));
        assert!(parts[1].starts_with("CREATE TABLE"));
    }

    #[test]
    fn test_named_dollar_quote_tag() {
        let sql = "DO $proc$ BEGIN PERFORM 1; END $proc$; SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("$proc$"));
        assert!(parts[1].starts_with("SELECT 1"));
    }

    #[test]
    fn test_semicolon_inside_string_literal() {
        let sql = "INSERT INTO t VALUES ('a;b'); SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("'a;b'"));
        assert!(parts[1].starts_with("SELECT 1"));
    }

    #[test]
    fn test_escaped_quote_in_string() {
        let sql = "INSERT INTO t VALUES ('it''s ok;'); SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("'it''s ok;'"));
    }

    #[test]
    fn test_bcrypt_hash_with_dollar_signs() {
        let sql = "INSERT INTO users VALUES ('admin', '$2b$12$abcdef');";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].contains("$2b$12$abcdef"));
    }

    #[test]
    fn test_block_comment_stripped() {
        let sql = "/* hello\n world */ SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].starts_with("SELECT"));
    }

    #[test]
    fn test_inline_comment_after_statement() {
        let sql = "SELECT 1; -- trailing\nSELECT 2;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].starts_with("SELECT 1"));
        assert!(parts[1].starts_with("SELECT 2"));
    }

    #[test]
    fn test_migration_stats_default_no_error() {
        let s = MigrationStats::default();
        assert!(!s.has_error());
        assert_eq!(s.ok, 0);
    }
}
