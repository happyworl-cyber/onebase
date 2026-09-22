import { useTranslations } from 'next-intl'
import { HelpSection } from '@/components/help/HelpArticle'

export default function DiagnosticsArticle() {
  const t = useTranslations('helpDiagnostics')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('currentStateTitle')}>
        <p>{t('currentStateBody')}</p>
      </HelpSection>
      <HelpSection title={t('threeLogsTitle')}>
        <p>
          {t.rich('threeLogsBody', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
          })}
        </p>
      </HelpSection>
      <HelpSection title={t('statementsLocksTitle')}>
        <p>{t('statementsLocksBody')}</p>
      </HelpSection>
    </>
  )
}
