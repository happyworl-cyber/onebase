'use client'

import WorkspacePickerPage from '../workspace/page'

/**
 * /platform 与 /workspace 首页合并为同一实现，避免双份逻辑长期漂移。
 * 如需调整首页行为，请只改 `app/workspace/page.tsx`。
 */
export default function PlatformPage() {
  return <WorkspacePickerPage />
}
