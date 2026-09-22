import { useTranslations } from 'next-intl'
import { HelpSection } from '@/components/help/HelpArticle'

export default function IntegrationsArticle() {
  const t = useTranslations('helpIntegrations')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('dataSourcesTitle')}>
        <p>{t('dataSourcesBody')}</p>
      </HelpSection>
      <HelpSection title={t('pushOutTitle')}>
        <p>{t('pushOutBody')}</p>
      </HelpSection>
      <HelpSection title={t('externalStorageTitle')}>
        <p>{t('externalStorageBody')}</p>
      </HelpSection>
    </>
  )
}
