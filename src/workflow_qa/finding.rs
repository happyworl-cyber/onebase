use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Crit,
    High,
    Med,
    Low,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Crit => "crit",
            Self::High => "high",
            Self::Med => "med",
            Self::Low => "low",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    pub code: String,
    pub title: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_label: Option<String>,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowMeta {
    pub id: i32,
    pub slug: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub department: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReviewItem {
    pub workflow: WorkflowMeta,
    pub rules: Vec<Finding>,
    pub ai_findings: Vec<Finding>,
    pub ai_status: crate::workflow_qa::AiStatus,
    pub ai_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BatchSummary {
    pub scanned: usize,
    pub rules_hit: usize,
    pub sent_to_ai: usize,
    pub ai_ok: usize,
    pub ai_error: usize,
}
