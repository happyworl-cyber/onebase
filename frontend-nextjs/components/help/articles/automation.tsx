import { useTranslations } from 'next-intl'
import { HelpSection } from '@/components/help/HelpArticle'

export default function AutomationArticle() {
  const t = useTranslations('helpAutomation')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('functionsTriggersTitle')}>
        <p>{t('functionsTriggersBody')}</p>
      </HelpSection>
      <HelpSection title={t('workflowsScheduledTitle')}>
        <p>{t('workflowsScheduledBody')}</p>
      </HelpSection>
      <HelpSection title={t('sessionRulesTitle')}>
        <p>{t('sessionRulesBody')}</p>
      </HelpSection>
    </>
  )
}
