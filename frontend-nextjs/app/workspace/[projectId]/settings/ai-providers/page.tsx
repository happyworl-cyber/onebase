'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Modal, { ConfirmDialog } from '@/components/Modal'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { useNotification } from '@/hooks/useNotification'
import {
  aiProviderAPI,
  type AiProvider,
  type AiProviderKind,
  type CreateAiProviderBody,
} from '@/lib/api'
import { AI_ASSISTANT_ENABLED } from '@/lib/aiAssistant'
import { useCurrentProjectCapabilities } from '@/lib/permissions'

const PROVIDERS: Record<AiProviderKind, {
  label: string
  icon: string
  baseUrl: string
  model: string
}> = {
  openai: {
    label: 'OpenAI',
    icon: 'fa-brain',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  anthropic: {
    label: 'Anthropic',
    icon: 'fa-a',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-latest',
  },
  qwen: {
    label: 'Qwen',
    icon: 'fa-cloud',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
}

interface ProviderForm {
  editing: AiProvider | null
  provider: AiProviderKind
  name: string
  base_url: string
  model: string
  api_key: string
  is_active: boolean
  is_default: boolean
}

function emptyForm(): ProviderForm {
  return {
    editing: null,
    provider: 'openai',
    name: 'OpenAI',
    base_url: PROVIDERS.openai.baseUrl,
    model: PROVIDERS.openai.model,
    api_key: '',
    is_active: true,
    is_default: false,
  }
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}

export default function AiProvidersPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = Number(params.projectId)
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<ProviderForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<AiProvider | null>(null)
  const [toggling, setToggling] = useState<AiProvider | null>(null)
  const [testingId, setTestingId] = useState<number | null>(null)
  const [updatingId, setUpdatingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await aiProviderAPI.list(projectId)
      setProviders(response.data.providers || [])
    } catch (error) {
      notify.error(error)
    } finally {
      setLoading(false)
    }
  }, [notify, projectId])

  useEffect(() => {
    if (caps.canManageMembers && Number.isFinite(projectId)) void load()
  }, [caps.canManageMembers, load, projectId])

  const formValid = useMemo(() => {
    if (!form) return false
    return !!(
      form.name.trim() &&
      form.base_url.trim() &&
      form.model.trim() &&
      (form.editing || form.api_key.trim())
    )
  }, [form])

  if (!AI_ASSISTANT_ENABLED) {
    return <ForbiddenPlaceholder reason="AI 助手已被环境变量 NEXT_PUBLIC_AI_ASSISTANT_ENABLED 关闭" />
  }

  if (!caps.canManageMembers) {
    return <ForbiddenPlaceholder reason="AI 模型配置需要项目 admin、owner 或平台超管权限" />
  }

  const openCreate = () => setForm(emptyForm())
  const openEdit = (provider: AiProvider) => setForm({
    editing: provider,
    provider: provider.provider,
    name: provider.name,
    base_url: provider.base_url,
    model: provider.model,
    api_key: '',
    is_active: provider.is_active,
    is_default: provider.is_default,
  })

  const changeKind = (kind: AiProviderKind) => {
    if (!form) return
    const preset = PROVIDERS[kind]
    setForm({
      ...form,
      provider: kind,
      name: form.editing ? form.name : preset.label,
      base_url: preset.baseUrl,
      model: preset.model,
    })
  }

  const save = async () => {
    if (!form || !formValid) {
      notify.warning('请完整填写名称、Base URL、模型和 API Key')
      return
    }
    setSaving(true)
    try {
      if (form.editing) {
        await aiProviderAPI.update(projectId, form.editing.id, {
          provider: form.provider,
          name: form.name.trim(),
          base_url: form.base_url.trim(),
          model: form.model.trim(),
          ...(form.api_key.trim() ? { api_key: form.api_key.trim() } : {}),
          is_active: form.is_active,
          is_default: form.is_default,
        })
        notify.success('AI Provider 已更新')
      } else {
        const body: CreateAiProviderBody = {
          provider: form.provider,
          name: form.name.trim(),
          base_url: form.base_url.trim(),
          model: form.model.trim(),
          api_key: form.api_key.trim(),
          is_active: form.is_active,
          is_default: form.is_default,
        }
        await aiProviderAPI.create(projectId, body)
        notify.success('AI Provider 已创建并启用')
      }
      setForm(null)
      await load()
    } catch (error) {
      notify.error(error)
    } finally {
      setSaving(false)
    }
  }

  const setDefault = async (provider: AiProvider) => {
    setUpdatingId(provider.id)
    try {
      await aiProviderAPI.update(projectId, provider.id, { is_default: true })
      notify.success(`已将 ${provider.name} 设为默认模型`)
      await load()
    } catch (error) {
      notify.error(error)
    } finally {
      setUpdatingId(null)
    }
  }

  const test = async (provider: AiProvider) => {
    setTestingId(provider.id)
    try {
      const response = await aiProviderAPI.test(projectId, provider.id)
      notify.success(`连接成功，耗时 ${response.data.latency_ms} ms`)
    } catch (error) {
      notify.error(error)
    } finally {
      setTestingId(null)
    }
  }

  const toggleActive = async () => {
    if (!toggling) return
    const nextActive = !toggling.is_active
    setUpdatingId(toggling.id)
    try {
      await aiProviderAPI.update(projectId, toggling.id, { is_active: nextActive })
      notify.success(`${toggling.name} 已${nextActive ? '启用' : '停用'}`)
      setToggling(null)
      await load()
    } catch (error) {
      notify.error(error)
    } finally {
      setUpdatingId(null)
    }
  }

  const remove = async () => {
    if (!deleting) return
    setUpdatingId(deleting.id)
    try {
      await aiProviderAPI.remove(projectId, deleting.id)
      notify.success(`已删除 ${deleting.name}`)
      setDeleting(null)
      await load()
    } catch (error) {
      notify.error(error)
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div className="max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI 模型</h1>
          <p className="mt-1 text-sm text-gray-500">
            配置项目级 AI Provider。API Key 加密保存且永不回显；聊天默认使用标记为“默认”的模型。
          </p>
        </div>
        <button type="button" onClick={openCreate} className="btn-primary whitespace-nowrap">
          <i className="fas fa-plus mr-2" />新建 Provider
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-5 py-3 text-left font-medium">Provider</th>
              <th className="px-5 py-3 text-left font-medium">模型 / Base URL</th>
              <th className="px-5 py-3 text-left font-medium">状态</th>
              <th className="px-5 py-3 text-left font-medium">更新时间</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={5} className="px-5 py-12 text-center text-gray-400"><i className="fas fa-spinner fa-spin mr-2" />加载中...</td></tr>
            )}
            {!loading && providers.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-12 text-center text-gray-400">尚未配置 Provider，AI 对话暂不可用。</td></tr>
            )}
            {!loading && providers.map((provider) => (
              <tr key={provider.id} className="hover:bg-gray-50/60">
                <td className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                      <i className={`fas ${PROVIDERS[provider.provider].icon}`} />
                    </span>
                    <div>
                      <div className="font-medium text-gray-900">{provider.name}</div>
                      <div className="text-xs text-gray-500">{PROVIDERS[provider.provider].label}</div>
                    </div>
                  </div>
                </td>
                <td className="max-w-sm px-5 py-4">
                  <div className="font-mono text-gray-800">{provider.model}</div>
                  <div className="mt-1 truncate font-mono text-xs text-gray-400" title={provider.base_url}>{provider.base_url}</div>
                </td>
                <td className="px-5 py-4">
                  <div className="flex flex-wrap gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      provider.is_active
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {provider.is_active ? '已启用' : '已停用'}
                    </span>
                    {provider.is_default && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">默认</span>}
                    <span className={`rounded-full px-2 py-0.5 text-xs ${provider.api_key_configured ? 'bg-gray-100 text-gray-600' : 'bg-red-50 text-red-700'}`}>
                      {provider.api_key_configured ? '密钥已配置' : '缺少密钥'}
                    </span>
                  </div>
                </td>
                <td className="px-5 py-4 text-xs text-gray-500">{formatDate(provider.updated_at)}</td>
                <td className="px-5 py-4 text-right whitespace-nowrap">
                  <button type="button" onClick={() => void test(provider)} disabled={testingId === provider.id} className="mr-3 text-emerald-600 hover:text-emerald-800 disabled:opacity-50">
                    {testingId === provider.id ? <i className="fas fa-spinner fa-spin" /> : '测试'}
                  </button>
                  {provider.is_active && !provider.is_default && (
                    <button type="button" onClick={() => void setDefault(provider)} disabled={updatingId === provider.id} className="mr-3 text-indigo-600 hover:text-indigo-800 disabled:opacity-50">
                      设为默认
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setToggling(provider)}
                    disabled={updatingId === provider.id}
                    className={`mr-3 disabled:opacity-50 ${
                      provider.is_active
                        ? 'text-amber-600 hover:text-amber-800'
                        : 'text-emerald-600 hover:text-emerald-800'
                    }`}
                  >
                    {provider.is_active ? '停用' : '启用'}
                  </button>
                  <button type="button" onClick={() => openEdit(provider)} className="mr-3 text-blue-600 hover:text-blue-800">编辑</button>
                  <button type="button" onClick={() => setDeleting(provider)} className="text-red-600 hover:text-red-800">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={!!form}
        onClose={() => { if (!saving) setForm(null) }}
        title={form?.editing ? '编辑 AI Provider' : '新建 AI Provider'}
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setForm(null)} disabled={saving} className="btn-default">取消</button>
            <button type="button" onClick={() => void save()} disabled={saving || !formValid} className="btn-primary disabled:opacity-50">
              {saving ? <><i className="fas fa-spinner fa-spin mr-2" />保存中...</> : '保存'}
            </button>
          </div>
        }
      >
        {form && (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Provider *</label>
              <select value={form.provider} onChange={(event) => changeKind(event.target.value as AiProviderKind)} className="input-base w-full">
                {Object.entries(PROVIDERS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">配置名称 *</label>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="input-base w-full" placeholder="如：生产 OpenAI" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">模型 *</label>
              <input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} className="input-base w-full font-mono" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Base URL *</label>
              <input type="url" value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} className="input-base w-full font-mono" />
              <p className="mt-1 text-xs text-gray-400">生产环境仅允许 HTTPS；后端会拦截内网、环回和保留地址。</p>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                API Key {form.editing ? '' : '*'}
              </label>
              <input
                type="password"
                autoComplete="new-password"
                value={form.api_key}
                onChange={(event) => setForm({ ...form, api_key: event.target.value })}
                className="input-base w-full font-mono"
                placeholder={form.editing ? '留空表示保留现有密钥' : '输入 API Key'}
              />
              <p className="mt-1 text-xs text-gray-400">密钥只在本次提交中使用，保存后不会回显。</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(event) => setForm({
                  ...form,
                  is_active: event.target.checked,
                  is_default: event.target.checked ? form.is_default : false,
                })}
                className="h-4 w-4 rounded text-indigo-600"
              />
              启用此 Provider
            </label>
            <label className={`flex items-center gap-2 text-sm ${
              form.is_active ? 'text-gray-700' : 'text-gray-400'
            }`}>
              <input
                type="checkbox"
                checked={form.is_default}
                disabled={!form.is_active}
                onChange={(event) => setForm({ ...form, is_default: event.target.checked })}
                className="h-4 w-4 rounded text-indigo-600 disabled:opacity-50"
              />
              设为项目默认 Provider
            </label>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!toggling}
        onClose={() => setToggling(null)}
        onConfirm={() => void toggleActive()}
        title={`${toggling?.is_active ? '停用' : '启用'} AI Provider`}
        message={
          toggling?.is_active
            ? `确认停用「${toggling?.name || ''}」吗？聊天将不再选择该 Provider；若它是默认项，后端会自动切换默认模型。`
            : `确认启用「${toggling?.name || ''}」吗？启用后它可被 AI 聊天使用。`
        }
        confirmText={toggling?.is_active ? '停用' : '启用'}
        type={toggling?.is_active ? 'warning' : 'info'}
        loading={!!toggling && updatingId === toggling.id}
      />

      <ConfirmDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title="删除 AI Provider"
        message={`确认删除「${deleting?.name || ''}」吗？该操作不会删除任何聊天记录，但可能导致项目暂时无法使用 AI 助手。`}
        confirmText="删除"
        loading={!!deleting && updatingId === deleting.id}
      />
    </div>
  )
}
