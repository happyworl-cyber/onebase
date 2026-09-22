'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

export default function ConnectionWarning() {
  const [dismissed, setDismissed] = useState(false)
  const t = useTranslations('connectionWarning')

  if (dismissed) return null

  return (
    <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
      <div className="flex">
        <div className="flex-shrink-0">
          <i className="fas fa-exclamation-triangle text-yellow-400"></i>
        </div>
        <div className="ml-3 flex-1">
          <p className="text-sm text-yellow-700">
            <strong className="font-medium">{t('noteLabel')}</strong>
            {t.rich('body', {
              code1: (chunks) => (
                <code className="bg-yellow-100 px-1 py-0.5 rounded">{chunks}</code>
              ),
              code2: (chunks) => (
                <code className="bg-yellow-100 px-1 py-0.5 rounded">{chunks}</code>
              ),
            })}
          </p>
          <p className="text-xs text-yellow-600 mt-2">
            {t('hint')}
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 ml-3 text-yellow-400 hover:text-yellow-600"
        >
          <i className="fas fa-times"></i>
        </button>
      </div>
    </div>
  )
}

