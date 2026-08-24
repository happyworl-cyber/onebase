//! 工作流 taxonomy：部门（department）+ 分类（category）
//!
//! - `department`：业务部门；默认共享部门名为 [`SHARED_DEPARTMENT`]
//! - `category`：部门下的分类名
//! - 旧 API 若只传单段 `category` 且无 `/`，视为共享部门下的分类

pub const SHARED_DEPARTMENT: &str = "共享";
pub const UNCATEGORIZED_CATEGORY: &str = "未分类";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowTaxonomy {
    pub department: Option<String>,
    pub category: Option<String>,
}

impl WorkflowTaxonomy {
    pub fn empty() -> Self {
        Self {
            department: None,
            category: None,
        }
    }
}

fn trim_or_none(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 从 `部门/分类` 路径解析（兼容旧组合字符串）。
pub fn parse_combined_path(raw: &str) -> WorkflowTaxonomy {
    let slash = raw.find('/');
    if let Some(pos) = slash {
        let department = trim_or_none(&raw[..pos]);
        let category = trim_or_none(&raw[pos + 1..]);
        WorkflowTaxonomy {
            department,
            category,
        }
    } else {
        WorkflowTaxonomy {
            department: Some(SHARED_DEPARTMENT.to_string()),
            category: trim_or_none(raw),
        }
    }
}

/// 从 department + category 字段构建。
pub fn from_parts(department: Option<&str>, category: Option<&str>) -> WorkflowTaxonomy {
    let department = department.and_then(trim_or_none);
    let category = category.and_then(trim_or_none);
    match (&department, &category) {
        (None, None) => WorkflowTaxonomy::empty(),
        (Some(d), None) => WorkflowTaxonomy {
            department: Some(d.clone()),
            category: None,
        },
        (None, Some(c)) => WorkflowTaxonomy {
            department: Some(SHARED_DEPARTMENT.to_string()),
            category: Some(c.clone()),
        },
        (Some(d), Some(c)) => WorkflowTaxonomy {
            department: Some(d.clone()),
            category: Some(c.clone()),
        },
    }
}

/// 入库前归一：无 category 的统一归入该部门下的「未分类」；双空 → 「共享 / 未分类」。
pub fn normalize_for_storage(tax: WorkflowTaxonomy) -> WorkflowTaxonomy {
    if tax.department.is_none() && tax.category.is_none() {
        return WorkflowTaxonomy {
            department: Some(SHARED_DEPARTMENT.to_string()),
            category: Some(UNCATEGORIZED_CATEGORY.to_string()),
        };
    }
    if tax.department.is_none() {
        return WorkflowTaxonomy {
            department: Some(SHARED_DEPARTMENT.to_string()),
            category: tax
                .category
                .or_else(|| Some(UNCATEGORIZED_CATEGORY.to_string())),
        };
    }
    if tax.category.is_none() {
        return WorkflowTaxonomy {
            department: tax.department.clone(),
            category: Some(UNCATEGORIZED_CATEGORY.to_string()),
        };
    }
    tax
}

/// 列表筛选「某部门 / 未分类」时兼容尚未清洗的空 category 数据。
pub fn push_dept_uncategorized_filter(qb: &mut sqlx::QueryBuilder<'_, sqlx::Postgres>, dept: &str) {
    if dept == SHARED_DEPARTMENT {
        qb.push(" AND ((w.department IS NULL AND w.category IS NULL) OR (w.department = ")
            .push_bind(dept.to_string())
            .push(" AND (w.category IS NULL OR w.category = ")
            .push_bind(UNCATEGORIZED_CATEGORY.to_string())
            .push(")))");
    } else {
        qb.push(" AND w.department = ")
            .push_bind(dept.to_string())
            .push(" AND (w.category IS NULL OR w.category = ")
            .push_bind(UNCATEGORIZED_CATEGORY.to_string())
            .push(")");
    }
}

/// 创建时解析：显式 department/category 优先；仅 category 时按兼容规则解析。
pub fn resolve_taxonomy_input(
    department: Option<&str>,
    category: Option<&str>,
) -> WorkflowTaxonomy {
    let dept_provided = department.map(str::trim).is_some_and(|s| !s.is_empty());
    let cat_raw = category.map(str::trim).filter(|s| !s.is_empty());

    let tax = if dept_provided {
        from_parts(department, cat_raw)
    } else if let Some(raw) = cat_raw {
        parse_combined_path(raw)
    } else {
        WorkflowTaxonomy::empty()
    };
    normalize_for_storage(tax)
}

/// 更新时：仅当请求显式携带 department / category 字段时才改动 taxonomy。
pub fn resolve_taxonomy_update(
    existing: &WorkflowTaxonomy,
    department: Option<Option<&str>>,
    category: Option<Option<&str>>,
) -> WorkflowTaxonomy {
    let dept_provided = department.is_some();
    let cat_provided = category.is_some();

    if !dept_provided && !cat_provided {
        return existing.clone();
    }

    if dept_provided
        && department
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
    {
        return normalize_for_storage(WorkflowTaxonomy::empty());
    }

    let dept = if dept_provided {
        department
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    } else {
        existing.department.clone()
    };

    let cat = if cat_provided {
        category
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    } else {
        existing.category.clone()
    };

    normalize_for_storage(from_parts(dept.as_deref(), cat.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_segment_legacy_is_shared_category() {
        let t = parse_combined_path("游戏");
        assert_eq!(t.department.as_deref(), Some(SHARED_DEPARTMENT));
        assert_eq!(t.category.as_deref(), Some("游戏"));
    }

    #[test]
    fn combined_path_parses_dept_and_category() {
        let t = parse_combined_path("技术部/订单");
        assert_eq!(t.department.as_deref(), Some("技术部"));
        assert_eq!(t.category.as_deref(), Some("订单"));
    }

    #[test]
    fn from_parts_category_only_defaults_shared() {
        let t = from_parts(None, Some("社区"));
        assert_eq!(t.department.as_deref(), Some(SHARED_DEPARTMENT));
        assert_eq!(t.category.as_deref(), Some("社区"));
    }

    #[test]
    fn resolve_input_explicit_dept_and_category() {
        let t = resolve_taxonomy_input(Some("运营部"), Some("通知"));
        assert_eq!(t.department.as_deref(), Some("运营部"));
        assert_eq!(t.category.as_deref(), Some("通知"));
    }

    #[test]
    fn resolve_input_empty_defaults_shared_uncategorized() {
        let t = resolve_taxonomy_input(None, None);
        assert_eq!(t.department.as_deref(), Some(SHARED_DEPARTMENT));
        assert_eq!(t.category.as_deref(), Some(UNCATEGORIZED_CATEGORY));
    }

    #[test]
    fn dept_without_category_becomes_uncategorized() {
        let t = resolve_taxonomy_input(Some("运营部"), None);
        assert_eq!(t.department.as_deref(), Some("运营部"));
        assert_eq!(t.category.as_deref(), Some(UNCATEGORIZED_CATEGORY));
    }
}
