import { useTranslations } from 'next-intl'
import { HelpSection } from '@/components/help/HelpArticle'

export default function SettingsArticle() {
  const t = useTranslations('helpSettings')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('projectPeopleTitle')}>
        <p>{t('projectPeopleBody')}</p>
      </HelpSection>
      <HelpSection title={t('secretsVarsTitle')}>
        <p>{t('secretsVarsBody')}</p>
      </HelpSection>
      <HelpSection title={t('connectionsGatewayTitle')}>
        <p>{t('connectionsGatewayBody')}</p>
      </HelpSection>
    </>
  )
}
