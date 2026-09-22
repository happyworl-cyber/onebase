import { useTranslations } from 'next-intl'
import { HelpSection } from '@/components/help/HelpArticle'

export default function ApiAndRpcArticle() {
  const t = useTranslations('helpApiRpc')
  return (
    <>
      <HelpSection title={t('whatIsThis')}>
        <p>{t('whatIsThisBody')}</p>
      </HelpSection>
      <HelpSection title={t('restApiTitle')}>
        <p>{t('restApiBody')}</p>
      </HelpSection>
      <HelpSection title={t('rpcCallerTitle')}>
        <p>{t('rpcCallerBody')}</p>
      </HelpSection>
    </>
  )
}
