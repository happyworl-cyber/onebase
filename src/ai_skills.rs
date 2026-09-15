//! 仓库内助手技能：编译期打进二进制，生产与本地同一套。
//!
//! 新增：`skills/<name>/SKILL.md` + 下面 `BUNDLED` 加一行。

use serde_json::{json, Value};

const BUNDLED: &[(&str, &str)] = &[(
    "workflow-qa",
    include_str!("../skills/workflow-qa/SKILL.md"),
)];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub content: String,
}

pub fn parse_skill(raw: &str) -> Result<Skill, String> {
    let raw = raw.trim_start_matches('\u{feff}').trim();
    let Some(rest) = raw.strip_prefix("---") else {
        return Err("SKILL.md 缺少 YAML frontmatter".into());
    };
    let rest = rest.trim_start_matches(['\n', '\r']);
    let Some(end) = rest.find("\n---") else {
        return Err("SKILL.md frontmatter 未闭合".into());
    };
    let header = &rest[..end];
    let body = rest[end + 4..].trim_start_matches(['\n', '\r']);
    let mut name = String::new();
    let mut description = String::new();
    for line in header.lines() {
        if let Some(v) = line.strip_prefix("name:") {
            name = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("description:") {
            description = v.trim().to_string();
        }
    }
    if name.is_empty() || description.is_empty() {
        return Err("SKILL.md 需要 name 与 description".into());
    }
    Ok(Skill {
        name,
        description,
        content: body.trim().to_string(),
    })
}

fn all_skills() -> Vec<Skill> {
    BUNDLED
        .iter()
        .map(|(dir, raw)| {
            let mut skill = parse_skill(raw).unwrap_or_else(|e| panic!("skill {dir}: {e}"));
            if skill.name != *dir {
                skill.name = dir.to_string();
            }
            skill
        })
        .collect()
}

pub fn list_skills() -> Vec<Skill> {
    all_skills()
}

pub fn get_skill(name: &str) -> Option<Skill> {
    let key = name.trim();
    all_skills().into_iter().find(|s| s.name == key)
}

pub fn skill_catalog_text() -> String {
    all_skills()
        .into_iter()
        .map(|s| format!("- `{}`：{}", s.name, s.description))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn list_skills_json() -> Value {
    json!({
        "skills": list_skills()
            .into_iter()
            .map(|s| json!({ "name": s.name, "description": s.description }))
            .collect::<Vec<_>>(),
    })
}

pub fn skill_json(skill: &Skill) -> Value {
    json!({
        "name": skill.name,
        "description": skill.description,
        "content": skill.content,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_workflow_qa_parses() {
        let listed = list_skills();
        assert!(listed.iter().any(|s| s.name == "workflow-qa"));
        let s = get_skill("workflow-qa").expect("workflow-qa");
        assert!(s.description.contains("review_workflow"));
        assert!(s.content.contains("review_workflow"));
        assert!(!s.content.contains(".cursor/skills"));
    }

    #[test]
    fn parse_rejects_incomplete() {
        assert!(parse_skill("no frontmatter").is_err());
        assert!(parse_skill("---\nname: x\n---\nbody").is_err());
    }
}
