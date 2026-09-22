'use client'

/**
 * `/workspace/provision` —— M2 自助开通向导。
 *
 * 3 步流程：
 *   1. 命名项目 → name + slug（slug 实时正则校验）
 *   2. 挂载 PG → 从 PG 池选择，或手动填写连接
 *   3. 确认 → POST /api/projects/provision（固定使用 blank 模板）
 */

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  organizationAPI,
  pgPoolAPI,
  projectProvisionAPI,
  type ManualPgConnection,
  type PgPoolPublicEntry,
  type PlatformPgInstance,
  type ProvisionWebhookConfig,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'

type StepId = 'name' | 'pool' | 'review'
type PgMode = 'platform' | 'webhook' | 'pool' | 'manual'

const DEFAULT_TEMPLATE_SLUG = 'blank'

const STEPS: { id: StepId }[] = [
  { id: 'name' },
  { id: 'pool' },
  { id: 'review' },
]

const STEP_LABEL_KEYS: Record<StepId, string> = {
  name: 'stepName',
  pool: 'stepPool',
  review: 'stepReview',
}

const EMPTY_MANUAL_PG: ManualPgConnection = {
  db_host: '',
  db_port: 5432,
  admin_user: 'postgres',
  admin_password: '',
}

// slug 实时校验正则——与后端 is_valid_slug 完全对齐
const SLUG_REGEX = /^[a-z][a-z0-9_-]{0,49}$/

function isManualPgValid(pg: ManualPgConnection): boolean {
  const port = pg.db_port ?? 5432
  return (
    pg.db_host.trim().length > 0 &&
    pg.admin_user.trim().length > 0 &&
    pg.admin_password.length > 0 &&
    port >= 1 &&
    port <= 65535
  )
}

export default function ProvisionWizardPage() {
  const t = useTranslations('provisionPage')
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="text-sm text-gray-500">
            <i className="fas fa-spinner fa-spin mr-2"></i>{t('loadingEllipsis')}
          </div>
        </div>
      }
    >
      <ProvisionWizardInner />
    </Suspense>
  )
}

function ProvisionWizardInner() {
  const t = useTranslations('provisionPage')
  const router = useRouter()
  const searchParams = useSearchParams()
  const notify = useNotification()
  const currentOrganization = useAppStore((s) => s.currentOrganization)

  const orgIdFromQuery = searchParams.get('org')
  const organizationId = orgIdFromQuery
    ? parseInt(orgIdFromQuery, 10)
    : currentOrganization?.id ?? null

  const [authChecked, setAuthChecked] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!localStorage.getItem('token')) {
      router.replace('/login')
      return
    }
    // 必须挂在租户下开通项目，禁止无 organization_id 的隐式建租户
    if (!organizationId || !Number.isFinite(organizationId)) {
      notify.error(t('errNeedOrgConsole'))
      router.replace('/orgs')
      return
    }
    setAuthChecked(true)
  }, [router, organizationId, notify])

  const [stepIdx, setStepIdx] = useState(0)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [pgMode, setPgMode] = useState<PgMode>('platform')
  const [poolId, setPoolId] = useState<number | null>(null)
  const [manualPg, setManualPg] = useState<ManualPgConnection>(EMPTY_MANUAL_PG)
  const [submitting, setSubmitting] = useState(false)

  const [pools, setPools] = useState<PgPoolPublicEntry[] | null>(null)
  const [platformPg, setPlatformPg] = useState<PlatformPgInstance | null>(null)
  const [webhookConfig, setWebhookConfig] = useState<ProvisionWebhookConfig | null>(null)
  const [webhookWantRedis, setWebhookWantRedis] = useState(false)

  useEffect(() => {
    if (!authChecked) return
    Promise.all([
      pgPoolAPI.listAvailable(),
      pgPoolAPI.platformInstance(),
      pgPoolAPI.webhookConfig(),
    ])
      .then(([poolsRes, platformRes, webhookRes]) => {
        setPools(poolsRes.data)
        setPlatformPg(platformRes.data)
        setWebhookConfig(webhookRes.data)
        if (platformRes.data.available && platformRes.data.provision_ready !== false) {
          setPgMode('platform')
        } else if (webhookRes.data.enabled) {
          setPgMode('webhook')
        } else if (poolsRes.data.length === 0) {
          setPgMode('manual')
        } else {
          setPgMode('pool')
          const platformPool = poolsRes.data.find((p) => p.is_platform_instance)
          if (platformPool) setPoolId(platformPool.id)
        }
      })
      .catch((e) => notify.error(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked])

  useEffect(() => {
    if (slugTouched) return
    const derived = name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
    setSlug(derived)
  }, [name, slugTouched])

  const slugIsValid = SLUG_REGEX.test(slug)
  const platformStepValid =
    platformPg?.available === true && platformPg.provision_ready !== false
  const pgStepValid =
    pgMode === 'platform'
      ? platformStepValid
      : pgMode === 'webhook'
        ? webhookConfig?.enabled === true
        : pgMode === 'pool'
          ? poolId !== null
          : isManualPgValid(manualPg)

  const canAdvance = (() => {
    switch (STEPS[stepIdx].id) {
      case 'name':
        return name.trim().length >= 1 && name.trim().length <= 200 && slugIsValid
      case 'pool':
        return pgStepValid
      case 'review':
        return !submitting
    }
  })()

  const submit = async () => {
    if (!pgStepValid) return
    setSubmitting(true)
    try {
      const body = {
        name: name.trim(),
        slug,
        ...(pgMode === 'platform'
          ? { use_platform_pg: true as const }
          : pgMode === 'webhook'
            ? {
                use_provision_webhook: true as const,
                requested_resources: webhookWantRedis
                  ? ['postgresql', 'redis']
                  : ['postgresql'],
              }
            : pgMode === 'pool' && poolId !== null
              ? { pg_pool_id: poolId }
              : { pg_connection: manualPg }),
        template_slug: DEFAULT_TEMPLATE_SLUG,
        ...(organizationId && Number.isFinite(organizationId)
          ? { organization_id: organizationId }
          : {}),
      }
      const res =
        organizationId && Number.isFinite(organizationId)
          ? await organizationAPI.createProject(organizationId, body)
          : await projectProvisionAPI.provision(body)
      if (res.data.provisioned) {
        notify.success(t('projectCreated', { name: res.data.name }))
      } else {
        notify.info(t('alreadyExistsEnter'))
      }
      router.push(`/workspace/${res.data.project_id}`)
    } catch (e) {
      notify.error(e)
      setSubmitting(false)
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <i className="fas fa-spinner fa-spin text-gray-400"></i>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <header className="mb-8">
          <button
            onClick={() => router.push('/workspace')}
            className="text-xs text-gray-500 hover:text-gray-800 mb-4"
          >
            <i className="fas fa-arrow-left mr-1"></i> {t('backToProjectList')}
          </button>
          <h1 className="text-2xl font-semibold text-gray-900">{t('newProjectTitle')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('newProjectSubtitle')}
          </p>
        </header>

        <ol className="flex items-center mb-8 text-xs">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex items-center flex-1">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0 ${
                  i < stepIdx
                    ? 'bg-blue-100 text-blue-700'
                    : i === stepIdx
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {i < stepIdx ? <i className="fas fa-check text-[10px]"></i> : i + 1}
              </div>
              <span
                className={`ml-2 ${
                  i === stepIdx ? 'text-gray-900 font-medium' : 'text-gray-500'
                }`}
              >
                {t(STEP_LABEL_KEYS[s.id])}
              </span>
              {i < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-px mx-3 ${
                    i < stepIdx ? 'bg-blue-300' : 'bg-gray-200'
                  }`}
                ></div>
              )}
            </li>
          ))}
        </ol>

        <div className="bg-white border border-gray-200 rounded-xl p-6 min-h-[300px]">
          {STEPS[stepIdx].id === 'name' && (
            <StepName
              name={name}
              slug={slug}
              slugTouched={slugTouched}
              slugIsValid={slugIsValid}
              onNameChange={setName}
              onSlugChange={(v) => {
                setSlugTouched(true)
                setSlug(v)
              }}
            />
          )}

          {STEPS[stepIdx].id === 'pool' && (
            <StepPool
              pools={pools}
              platformPg={platformPg}
              webhookConfig={webhookConfig}
              webhookWantRedis={webhookWantRedis}
              onWebhookWantRedisChange={setWebhookWantRedis}
              mode={pgMode}
              poolId={poolId}
              manualPg={manualPg}
              onModeChange={setPgMode}
              onPoolChange={setPoolId}
              onManualChange={setManualPg}
            />
          )}

          {STEPS[stepIdx].id === 'review' && (
            <StepReview
              name={name}
              slug={slug}
              pgMode={pgMode}
              platformPg={platformPg}
              webhookWantRedis={webhookWantRedis}
              pool={pools?.find((p) => p.id === poolId) ?? null}
              manualPg={manualPg}
            />
          )}
        </div>

        <div className="flex items-center justify-between mt-6">
          <button
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            disabled={stepIdx === 0 || submitting}
            className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
          >
            <i className="fas fa-chevron-left mr-1"></i> {t('prevStep')}
          </button>
          {stepIdx < STEPS.length - 1 ? (
            <button
              onClick={() => setStepIdx((i) => Math.min(STEPS.length - 1, i + 1))}
              disabled={!canAdvance}
              className="btn-primary disabled:opacity-50"
            >
              {t('nextStep')} <i className="fas fa-chevron-right ml-1"></i>
            </button>
          ) : (
            <button onClick={submit} disabled={!canAdvance} className="btn-primary disabled:opacity-50">
              {submitting ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  {pgMode === 'webhook'
                    ? t('provisioningWebhook')
                    : t('creatingEllipsis')}
                </>
              ) : (
                <>
                  <i className="fas fa-rocket mr-2"></i> {t('finishCreate')}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function StepName({
  name,
  slug,
  slugTouched,
  slugIsValid,
  onNameChange,
  onSlugChange,
}: {
  name: string
  slug: string
  slugTouched: boolean
  slugIsValid: boolean
  onNameChange: (v: string) => void
  onSlugChange: (v: string) => void
}) {
  const t = useTranslations('provisionPage')
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-medium text-gray-900 mb-1">{t('stepNameTitle')}</h2>
        <p className="text-sm text-gray-500">{t('stepNameHint')}</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          {t('projectNameLabel')} <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={200}
          className="w-full input-base"
          placeholder={t('projectNamePlaceholder')}
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          slug <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={slug}
          onChange={(e) => onSlugChange(e.target.value.toLowerCase())}
          maxLength={50}
          className={`w-full input-base font-mono text-sm ${
            slug && !slugIsValid ? 'border-red-300' : ''
          }`}
          placeholder="my-blog"
        />
        <p className="text-xs text-gray-500 mt-1">
          {t('slugHint')}
          {!slugTouched && name && (
            <span className="text-gray-400 ml-1">{t('slugAutoDerived')}</span>
          )}
        </p>
        {slug && !slugIsValid && (
          <p className="text-xs text-red-600 mt-1">{t('slugInvalid')}</p>
        )}
      </div>
    </div>
  )
}

function StepPool({
  pools,
  platformPg,
  webhookConfig,
  webhookWantRedis,
  onWebhookWantRedisChange,
  mode,
  poolId,
  manualPg,
  onModeChange,
  onPoolChange,
  onManualChange,
}: {
  pools: PgPoolPublicEntry[] | null
  platformPg: PlatformPgInstance | null
  webhookConfig: ProvisionWebhookConfig | null
  webhookWantRedis: boolean
  onWebhookWantRedisChange: (v: boolean) => void
  mode: PgMode
  poolId: number | null
  manualPg: ManualPgConnection
  onModeChange: (m: PgMode) => void
  onPoolChange: (id: number) => void
  onManualChange: (pg: ManualPgConnection) => void
}) {
  const t = useTranslations('provisionPage')
  if (pools === null || platformPg === null || webhookConfig === null) {
    return (
      <div className="text-center py-12">
        <i className="fas fa-spinner fa-spin text-gray-400"></i>
        <p className="text-sm text-gray-500 mt-2">{t('loadingPgConfig')}</p>
      </div>
    )
  }

  const platformAvailable =
    platformPg.available === true && platformPg.provision_ready !== false

  return (
    <div>
      <h2 className="text-base font-medium text-gray-900 mb-1">{t('stepPoolTitle')}</h2>
      <p className="text-sm text-gray-500 mb-4">
        {t('stepPoolDesc1')}
        {mode !== 'webhook' && ` ${t('stepPoolDescRedisNote')}`}
      </p>

      <div className="flex flex-wrap gap-2 mb-5">
        {platformPg.available && (
          <button
            type="button"
            onClick={() => onModeChange('platform')}
            className={`px-3 py-1.5 text-sm rounded-lg border transition ${
              mode === 'platform'
                ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            {t('platformDbOption')}
            {platformAvailable && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                {t('recommendedBadge')}
              </span>
            )}
          </button>
        )}
        {webhookConfig.enabled && (
          <button
            type="button"
            onClick={() => onModeChange('webhook')}
            className={`px-3 py-1.5 text-sm rounded-lg border transition ${
              mode === 'webhook'
                ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            {t('opsAutoProvision')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onModeChange('pool')}
          className={`px-3 py-1.5 text-sm rounded-lg border transition ${
            mode === 'pool'
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
              : 'border-gray-200 text-gray-600 hover:border-gray-300'
          }`}
        >
          {t('selectFromPool')}
        </button>
        <button
          type="button"
          onClick={() => onModeChange('manual')}
          className={`px-3 py-1.5 text-sm rounded-lg border transition ${
            mode === 'manual'
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
              : 'border-gray-200 text-gray-600 hover:border-gray-300'
          }`}
        >
          {t('manualConnection')}
        </button>
      </div>

      {mode === 'webhook' ? (
        <div className="p-4 rounded-lg border border-violet-200 bg-violet-50/60">
          <div className="flex items-start gap-3">
            <i className="fas fa-cloud text-violet-600 mt-0.5"></i>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900">{t('opsAutoProvisionWebhookTitle')}</div>
              <p className="text-xs text-gray-600 mt-2 leading-relaxed">
                {webhookConfig.description ?? t('webhookDefaultDesc')}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                {t('webhookClickDesc')}
                {webhookConfig.supports_async_poll && (
                  <span className="block mt-1 text-violet-700">
                    {t('webhookAsyncPollNote', { secs: webhookConfig.poll_max_secs ?? 600 })}
                  </span>
                )}
              </p>
              {webhookConfig.supports_redis && (
                <label className="flex items-center gap-2 mt-4 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={webhookWantRedis}
                    onChange={(e) => onWebhookWantRedisChange(e.target.checked)}
                    className="rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                  />
                  {t('webhookRedisCheckbox')}
                </label>
              )}
            </div>
          </div>
        </div>
      ) : mode === 'platform' && platformPg.available ? (
        platformAvailable ? (
          <div className="p-4 rounded-lg border border-blue-200 bg-blue-50/60">
            <div className="flex items-start gap-3">
              <i className="fas fa-database text-blue-600 mt-0.5"></i>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900">
                  {t('platformDbInUse')}
                </div>
                <div className="text-xs text-gray-600 font-mono mt-1">
                  {platformPg.db_host}:{platformPg.db_port}
                  {platformPg.management_db_name && (
                    <span className="text-gray-400 ml-2">
                      {t('managementDbLabel', { name: platformPg.management_db_name })}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                  {t.rich('platformDbDesc', { strong: (chunks) => <strong>{chunks}</strong> })}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-lg border border-amber-200 bg-amber-50/80">
            <div className="flex items-start gap-3">
              <i className="fas fa-exclamation-triangle text-amber-600 mt-0.5"></i>
              <div className="flex-1 min-w-0 text-sm">
                <div className="font-medium text-gray-900">{t('platformDbUnavailable')}</div>
                <p className="text-xs text-gray-600 mt-1 font-mono">
                  {platformPg.db_host}:{platformPg.db_port}
                </p>
                {platformPg.provision_error && (
                  <p className="text-xs text-amber-800 mt-2 break-all">{platformPg.provision_error}</p>
                )}
                <p className="text-xs text-gray-500 mt-2">
                  {t.rich('platformDbUnavailableHint', { code: (chunks) => <span className="font-mono">{chunks}</span> })}
                </p>
              </div>
            </div>
          </div>
        )
      ) : mode === 'pool' ? (
        pools.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-gray-200 rounded-lg">
            <i className="fas fa-server text-2xl text-gray-300 mb-2"></i>
            <p className="text-sm text-gray-500">
              {t('poolEmptyHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pools.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPoolChange(p.id)}
                className={`w-full text-left p-3 rounded-lg border transition ${
                  poolId === p.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <i
                      className={`fas ${
                        poolId === p.id ? 'fa-check-circle text-blue-500' : 'fa-circle text-gray-300'
                      }`}
                    ></i>
                    <div>
                      <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                        {p.name}
                        {p.is_platform_instance && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                            {t('platformInstanceBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 font-mono">
                        {p.db_host}:{p.db_port}
                      </div>
                    </div>
                  </div>
                  {p.note && (
                    <span className="text-xs text-gray-500 max-w-[200px] truncate">{p.note}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('hostLabel')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={manualPg.db_host}
                onChange={(e) => onManualChange({ ...manualPg, db_host: e.target.value })}
                className="w-full input-base"
                placeholder={t('hostPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('portLabel')} <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                value={manualPg.db_port ?? 5432}
                onChange={(e) =>
                  onManualChange({ ...manualPg, db_port: parseInt(e.target.value, 10) || 5432 })
                }
                className="w-full input-base"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t('adminUserLabel')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={manualPg.admin_user}
              onChange={(e) => onManualChange({ ...manualPg, admin_user: e.target.value })}
              className="w-full input-base"
              placeholder="postgres"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t('adminPasswordLabel')} <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              value={manualPg.admin_password}
              onChange={(e) => onManualChange({ ...manualPg, admin_password: e.target.value })}
              className="w-full input-base"
              autoComplete="new-password"
            />
            <p className="text-xs text-gray-500 mt-1">
              {t('adminPasswordHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function StepReview({
  name,
  slug,
  pgMode,
  platformPg,
  webhookWantRedis,
  pool,
  manualPg,
}: {
  name: string
  slug: string
  pgMode: PgMode
  platformPg: PlatformPgInstance | null
  webhookWantRedis: boolean
  pool: PgPoolPublicEntry | null
  manualPg: ManualPgConnection
}) {
  const t = useTranslations('provisionPage')
  const pgLabel =
    pgMode === 'webhook' ? (
      <>
        {t('opsAutoProvisionWebhookTitle')}
        {webhookWantRedis && (
          <span className="text-gray-400 text-xs ml-2">+ Redis</span>
        )}
      </>
    ) : pgMode === 'platform' && platformPg?.available ? (
      <>
        {t('platformDbOption')}{' '}
        <span className="text-gray-400 font-mono text-xs">
          ({platformPg.db_host}:{platformPg.db_port})
        </span>
      </>
    ) : pgMode === 'pool' && pool ? (
      <>
        {pool.name}{' '}
        <span className="text-gray-400 font-mono text-xs">
          ({pool.db_host}:{pool.db_port})
        </span>
      </>
    ) : pgMode === 'manual' ? (
      <>
        {t('manualConnectionShort')}{' '}
        <span className="text-gray-400 font-mono text-xs">
          ({manualPg.db_host}:{manualPg.db_port ?? 5432})
        </span>
      </>
    ) : (
      '—'
    )

  const rows: { id: string; label: string; v: React.ReactNode }[] = [
    { id: 'projectName', label: t('projectNameLabel'), v: name },
    { id: 'slug', label: 'slug', v: <span className="font-mono">{slug}</span> },
    { id: 'pg', label: 'PG', v: pgLabel },
  ]

  return (
    <div>
      <h2 className="text-base font-medium text-gray-900 mb-1">{t('finalConfirmTitle')}</h2>
      <p className="text-sm text-gray-500 mb-4">
        {pgMode === 'webhook'
          ? t('finalConfirmDescWebhook')
          : t('finalConfirmDescDefault')}
      </p>
      <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center px-4 py-2.5 text-sm">
            <div className="w-24 text-gray-500 shrink-0">{r.label}</div>
            <div className="text-gray-900 flex-1 break-all">{r.v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
