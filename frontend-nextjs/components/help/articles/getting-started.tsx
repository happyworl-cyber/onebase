import { useTranslations } from 'next-intl'
import { HelpCode, HelpSection } from '@/components/help/HelpArticle'

const CURL = `curl "\${API_BASE}/api/v1/{db-slug}/{schema}/{table}?limit=1" \\
  -H "Authorization: Bearer ob_..."`

export default function GettingStartedArticle() {
  const t = useTranslations('helpGettingStarted')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('firstStepsTitle')}>
        <ol className="list-decimal ml-5 space-y-1">
          <li>{t('step1')}</li>
          <li>{t('step2')}</li>
          <li>{t('step3')}</li>
          <li>{t('step4')}</li>
          <li>{t('step5')}</li>
        </ol>
      </HelpSection>
      <HelpSection title={t('tryItTitle')}>
        <HelpCode>{CURL}</HelpCode>
        <p>
          {t.rich('tryItBody', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
          })}
        </p>
      </HelpSection>
      <HelpSection title={t('noteTitle')}>
        <p>{t('noteBody')}</p>
      </HelpSection>
    </>
  )
}
