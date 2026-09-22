import { useTranslations } from 'next-intl'
import { HelpSection } from '@/components/help/HelpArticle'

export default function SecurityArticle() {
  const t = useTranslations('helpSecurity')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('identityRolesTitle')}>
        <p>{t('identityRolesBody')}</p>
      </HelpSection>
      <HelpSection title={t('dataFunctionsTitle')}>
        <p>{t('dataFunctionsBody')}</p>
      </HelpSection>
      <HelpSection title={t('callEntryTitle')}>
        <p>
          {t.rich('callEntryBody', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
          })}
        </p>
      </HelpSection>
    </>
  )
}
