# OneBase 助手技能

随代码发布、生产可用。每种能力一个目录，不要往 `node_spec` 或 MCP 系统提示里堆流程。

```
skills/<name>/SKILL.md
```

写好后在 `src/ai_skills.rs` 的 `BUNDLED` 里加一行 `include_str!`，否则不会打进二进制。

| Skill | 何时用 |
|---|---|
| [workflow-qa](workflow-qa/SKILL.md) | 工作流质量 / AI 检测 / 改子流会不会打坏父流 |

运行时入口：

- MCP：`list_skills` / `get_skill`（`POST /mcp`）
- HTTP：`GET /api/admin/skills`、`GET /api/admin/skills/:name`（登录即可）
