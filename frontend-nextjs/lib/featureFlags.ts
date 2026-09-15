/**
 * 前端功能入口开关。功能代码与路由都保留，只控制 UI 上有没有入口。
 * 需要重新露出时把对应值改成 true 即可，不用回滚代码。
 */

/** 工作流依赖图入口（列表页「依赖图」按钮 + 行菜单「在依赖图中查看」）。 */
export const WORKFLOW_GRAPH_ENTRY_VISIBLE = false

/** 执行回放入口（执行记录行的「查看执行回放」按钮）。 */
export const EXECUTION_REPLAY_ENTRY_VISIBLE = false
