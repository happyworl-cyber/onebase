import { useTranslations } from 'next-intl'
import { HelpSection } from '@/components/help/HelpArticle'

export default function DatabaseArticle() {
  const t = useTranslations('helpDatabase')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('structureTitle')}>
        <p>{t('structureBody')}</p>
      </HelpSection>
      <HelpSection title={t('queryWriteTitle')}>
        <p>{t('queryWriteBody')}</p>
      </HelpSection>
      <HelpSection title={t('importBackupTitle')}>
        <p>{t('importBackupBody')}</p>
      </HelpSection>
    </>
  )
}
