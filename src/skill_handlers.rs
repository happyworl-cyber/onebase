//! 仓库技能的 HTTP 入口：登录即可读，与 MCP `list_skills` / `get_skill` 同一套内容。

use axum::{extract::Path, Json};
use serde_json::Value;

use crate::error::{AppError, Result};

pub async fn list_skills() -> Json<Value> {
    Json(planeos::ai_skills::list_skills_json())
}

pub async fn get_skill(Path(name): Path<String>) -> Result<Json<Value>> {
    let skill = planeos::ai_skills::get_skill(&name).ok_or_else(|| {
        AppError::not_found_coded(
            "skill_not_found",
            format!("技能「{name}」不存在"),
            serde_json::json!({ "name": name }),
        )
    })?;
    Ok(Json(planeos::ai_skills::skill_json(&skill)))
}
