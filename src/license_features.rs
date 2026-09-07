//! License 功能注册表 - 集中定义功能与 License 的映射关系
//!
//! 提供声明式的功能权限配置，替代分散在各个 handler 中的手动检查。

use crate::error::{AppError, Result};
use crate::license_enforcement::LicenseContext;
use onebase::license::{LicenseClaims, LicenseStatus};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 功能权限要求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureRequirement {
    /// 功能标识符
    pub feature: String,

    /// 功能显示名称
    pub display_name: String,

    /// 最低版本要求（None = 不限制）
    pub min_edition: Option<String>,

    /// 必需的模块列表（空 = 不需要模块）
    #[serde(default)]
    pub required_modules: Vec<String>,

    /// 功能描述
    #[serde(default)]
    pub description: String,
}

impl FeatureRequirement {
    /// 检查 License 是否满足此功能的要求
    pub fn check(&self, license: &LicenseContext) -> Result<()> {
        // 检查版本等级
        if let Some(required_edition) = &self.min_edition {
            if !license.has_edition(required_edition) {
                return Err(AppError::Forbidden(format!(
                    "「{}」功能需要 {} 版本或更高版本（当前为 {}）",
                    self.display_name, required_edition, license.claims.edition
                )));
            }
        }

        // 检查必需模块
        for module in &self.required_modules {
            if !license.has_module(module) {
                return Err(AppError::Forbidden(format!(
                    "「{}」功能需要「{}」模块，请升级 License",
                    self.display_name, module
                )));
            }
        }

        Ok(())
    }
}

/// 功能注册表
pub struct FeatureRegistry {
    features: HashMap<String, FeatureRequirement>,
}

impl FeatureRegistry {
    /// 创建新的功能注册表
    pub fn new() -> Self {
        let mut registry = Self {
            features: HashMap::new(),
        };

        // 注册所有功能
        registry.register_builtin_features();

        registry
    }

    /// 注册内置功能
    fn register_builtin_features(&mut self) {
        // ========== 基础功能 ==========
        self.register(FeatureRequirement {
            feature: "basic_crud".to_string(),
            display_name: "基础 CRUD 操作".to_string(),
            min_edition: None, // 所有版本都支持
            required_modules: vec![],
            description: "基本的增删改查操作".to_string(),
        });

        // ========== 工作流 ==========
        self.register(FeatureRequirement {
            feature: "workflow".to_string(),
            display_name: "工作流自动化".to_string(),
            min_edition: Some("standard".to_string()),
            required_modules: vec![],
            description: "创建和执行自动化工作流".to_string(),
        });

        // ========== AI 功能 ==========
        self.register(FeatureRequirement {
            feature: "ai_generation".to_string(),
            display_name: "AI 内容生成".to_string(),
            min_edition: Some("standard".to_string()),
            required_modules: vec!["ai".to_string()],
            description: "使用 AI 生成内容".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "ai_mcp".to_string(),
            display_name: "MCP 智能体".to_string(),
            min_edition: Some("standard".to_string()),
            required_modules: vec!["ai".to_string()],
            description: "MCP (Model Context Protocol) 智能体集成".to_string(),
        });

        // ========== 高可用 ==========
        self.register(FeatureRequirement {
            feature: "ha_replica".to_string(),
            display_name: "数据库副本".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec!["ha".to_string()],
            description: "创建和管理只读副本".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "ha_failover".to_string(),
            display_name: "自动故障转移".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec!["ha".to_string()],
            description: "主节点故障时自动切换".to_string(),
        });

        // ========== 多租户 ==========
        self.register(FeatureRequirement {
            feature: "multitenant_create".to_string(),
            display_name: "创建租户".to_string(),
            min_edition: Some("standard".to_string()),
            required_modules: vec!["multitenant".to_string()],
            description: "创建新的租户实例".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "multitenant_isolation".to_string(),
            display_name: "租户隔离".to_string(),
            min_edition: Some("standard".to_string()),
            required_modules: vec!["multitenant".to_string()],
            description: "租户间数据完全隔离".to_string(),
        });

        // ========== SSO ==========
        self.register(FeatureRequirement {
            feature: "sso_saml".to_string(),
            display_name: "SAML 单点登录".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec![],
            description: "SAML 2.0 单点登录集成".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "sso_oidc".to_string(),
            display_name: "OIDC 单点登录".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec![],
            description: "OpenID Connect 单点登录集成".to_string(),
        });

        // ========== 审计 ==========
        self.register(FeatureRequirement {
            feature: "audit_log".to_string(),
            display_name: "审计日志".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec!["audit".to_string()],
            description: "完整的操作审计日志".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "audit_export".to_string(),
            display_name: "审计日志导出".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec!["audit".to_string()],
            description: "导出审计日志用于合规审查".to_string(),
        });

        // ========== 数据管道 ==========
        self.register(FeatureRequirement {
            feature: "pipeline_kafka".to_string(),
            display_name: "Kafka 数据管道".to_string(),
            min_edition: Some("standard".to_string()),
            required_modules: vec!["pipeline".to_string()],
            description: "Kafka 消息队列集成".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "pipeline_elasticsearch".to_string(),
            display_name: "Elasticsearch 集成".to_string(),
            min_edition: Some("standard".to_string()),
            required_modules: vec!["pipeline".to_string()],
            description: "Elasticsearch 全文搜索集成".to_string(),
        });

        // ========== 高级功能 ==========
        self.register(FeatureRequirement {
            feature: "custom_domain".to_string(),
            display_name: "自定义域名".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec![],
            description: "为租户配置自定义域名".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "white_label".to_string(),
            display_name: "白标定制".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec![],
            description: "自定义品牌和 UI".to_string(),
        });

        self.register(FeatureRequirement {
            feature: "api_rate_limit_custom".to_string(),
            display_name: "自定义 API 限流".to_string(),
            min_edition: Some("enterprise".to_string()),
            required_modules: vec![],
            description: "为不同租户设置不同的 API 限流策略".to_string(),
        });
    }

    /// 注册单个功能
    pub fn register(&mut self, feature: FeatureRequirement) {
        self.features.insert(feature.feature.clone(), feature);
    }

    /// 检查功能是否可用
    pub fn check_feature(&self, feature: &str, license: &LicenseContext) -> Result<()> {
        let requirement = self.features.get(feature).ok_or_else(|| {
            AppError::Internal(format!("未知功能: {}", feature))
        })?;

        requirement.check(license)
    }

    /// 获取所有功能列表
    pub fn list_features(&self) -> Vec<&FeatureRequirement> {
        self.features.values().collect()
    }

    /// 获取当前 License 可用的功能列表
    pub fn available_features(&self, license: &LicenseContext) -> Vec<String> {
        self.features
            .values()
            .filter(|req| req.check(license).is_ok())
            .map(|req| req.feature.clone())
            .collect()
    }

    /// 获取功能详情
    pub fn get_feature(&self, feature: &str) -> Option<&FeatureRequirement> {
        self.features.get(feature)
    }
}

// 全局功能注册表（使用 lazy_static 或 once_cell）
use once_cell::sync::Lazy;

/// 全局功能注册表实例
pub static FEATURE_REGISTRY: Lazy<FeatureRegistry> = Lazy::new(FeatureRegistry::new);

/// 便捷函数：检查功能是否可用
pub fn require_feature(feature: &str, license: &LicenseContext) -> Result<()> {
    FEATURE_REGISTRY.check_feature(feature, license)
}

/// 便捷函数：获取可用功能列表
pub fn get_available_features(license: &LicenseContext) -> Vec<String> {
    FEATURE_REGISTRY.available_features(license)
}

#[cfg(test)]
mod tests {
    use super::*;
    use onebase::license::{LicenseClaims, LicenseStatus};

    fn mock_license(edition: &str, modules: Vec<&str>) -> LicenseContext {
        LicenseContext {
            claims: LicenseClaims {
                license_id: "TEST-001".to_string(),
                customer: "测试客户".to_string(),
                edition: edition.to_string(),
                modules: modules.iter().map(|s| s.to_string()).collect(),
                max_nodes: Some(1),
                max_tenants: Some(1),
                max_accounts_per_tenant: Some(10),
                issued_at: 0,
                expires_at: 9999999999,
                grace_days: 30,
                fingerprint: None,
                notes: None,
            },
            status: LicenseStatus::Active,
        }
    }

    #[test]
    fn test_basic_crud_always_available() {
        let license = mock_license("trial", vec![]);
        assert!(FEATURE_REGISTRY.check_feature("basic_crud", &license).is_ok());
    }

    #[test]
    fn test_workflow_requires_standard() {
        let trial_license = mock_license("trial", vec![]);
        let standard_license = mock_license("standard", vec![]);

        assert!(FEATURE_REGISTRY.check_feature("workflow", &trial_license).is_err());
        assert!(FEATURE_REGISTRY.check_feature("workflow", &standard_license).is_ok());
    }

    #[test]
    fn test_ai_requires_module() {
        let license_no_ai = mock_license("standard", vec![]);
        let license_with_ai = mock_license("standard", vec!["ai"]);

        assert!(FEATURE_REGISTRY.check_feature("ai_generation", &license_no_ai).is_err());
        assert!(FEATURE_REGISTRY.check_feature("ai_generation", &license_with_ai).is_ok());
    }

    #[test]
    fn test_sso_requires_enterprise() {
        let standard_license = mock_license("standard", vec![]);
        let enterprise_license = mock_license("enterprise", vec![]);

        assert!(FEATURE_REGISTRY.check_feature("sso_saml", &standard_license).is_err());
        assert!(FEATURE_REGISTRY.check_feature("sso_saml", &enterprise_license).is_ok());
    }

    #[test]
    fn test_available_features_list() {
        let trial_license = mock_license("trial", vec![]);
        let available = FEATURE_REGISTRY.available_features(&trial_license);

        // Trial 只能用基础功能
        assert!(available.contains(&"basic_crud".to_string()));
        assert!(!available.contains(&"workflow".to_string()));
        assert!(!available.contains(&"ai_generation".to_string()));
    }
}
