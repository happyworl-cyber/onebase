import { useTranslations } from 'next-intl'

/**
 * 实时推送规则（SSE 转发）使用说明面板。
 *
 * 工作区入口 `/workspace/.../automation/sse-routes` 使用（老后台 `/dashboard/sse-routes`
 * 已在 W2/W3 收尾时删除）。内容覆盖：原理 → 字段含义 → 客户端订阅 → 端到端示例。
 *
 * 与后端对齐（src/sse.rs）：
 *   - topic 授权前缀：user:{uid}:* / db:{dbId}:* / sys:*（超管）
 *   - 订阅入口：GET /sse?token=<jwt>&topics=a,b,c（支持末尾 * 通配）
 */
export default function SseHelpPanel() {
  const t = useTranslations('sseHelp')

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-6 space-y-5 text-sm text-gray-700">
      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          <i className="fas fa-circle-info text-blue-500 mr-2"></i>{t('whatIsThisTitle')}
        </h2>
        <p className="leading-relaxed">
          {t.rich('whatIsThisBody', {
            b: (chunks) => <b>{chunks}</b>,
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 mb-2">{t('fieldReferenceTitle')}</h3>
        <ul className="space-y-1.5 list-disc list-outside ml-5">
          <li>
            {t.rich('fieldDbScope', {
              b: (chunks) => <b>{chunks}</b>,
            })}
          </li>
          <li>
            {t.rich('fieldEventPattern', {
              b: (chunks) => <b>{chunks}</b>,
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </li>
          <li>
            {t.rich('fieldTopicTemplate', {
              b: (chunks) => <b>{chunks}</b>,
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </li>
          <li>
            {t.rich('fieldEventName', {
              b: (chunks) => <b>{chunks}</b>,
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </li>
        </ul>
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 mb-2">{t('subscribeTitle')}</h3>
        <p className="leading-relaxed mb-2">
          {t.rich('subscribeIntro', {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
        <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">{`const es = new EventSource(
  '/sse?token=' + jwt + '&topics=' + encodeURIComponent('db:2:*')
)

// ${t('sampleEventNameComment')}
es.addEventListener('INSERT', (e) => {
  const evt = JSON.parse(e.data) // { topic, event, data, id, ts }
  console.log('${t('sampleConsoleLogLabel')}', evt.topic, evt.data)
})

es.onerror = () => { /* ${t('sampleReconnectComment')} */ }`}</pre>
        <p className="leading-relaxed mt-2 text-xs text-gray-500">
          {t.rich('authHint', {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 mb-2">{t('exampleTitle')}</h3>
        <ol className="space-y-1 list-decimal list-outside ml-5 text-xs leading-relaxed">
          <li>
            {t.rich('exampleStep1', {
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </li>
          <li>
            {t.rich('exampleStep2', {
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </li>
          <li>
            {t.rich('exampleStep3', {
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </li>
        </ol>
      </div>
    </div>
  )
}
