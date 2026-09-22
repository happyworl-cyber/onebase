import { useTranslations } from 'next-intl'
import { HelpCode, HelpSection } from '@/components/help/HelpArticle'

const CURL = `curl "\${API_BASE}/api/v1/{db-slug}/{schema}/{table}?limit=1" \\
  -H "Authorization: Bearer ob_..."`

export default function ConnectingApisArticle() {
  const t = useTranslations('helpConnectingApis')
  return (
    <>
      <HelpSection title={t('baseUrlTitle')}>
        <p>
          {t.rich('baseUrlBody', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
          })}
        </p>
      </HelpSection>
      <HelpSection title={t('authTitle')}>
        <p>
          {t.rich('authBody', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
            apiKeyPh: '<API Key>',
          })}
        </p>
      </HelpSection>
      <HelpSection title={t('pickPathTitle')}>
        <ul className="list-disc ml-5 space-y-1">
          <li>{t('pathRestTable')}</li>
          <li>{t('pathRpcFunction')}</li>
          <li>{t('pathSseRealtime')}</li>
          <li>{t('pathWebhookNotify')}</li>
        </ul>
      </HelpSection>
      <HelpSection title={t('minimalExampleTitle')}>
        <HelpCode>{CURL}</HelpCode>
        <p>
          {t.rich('minimalExampleBody', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
          })}
        </p>
      </HelpSection>
    </>
  )
}
