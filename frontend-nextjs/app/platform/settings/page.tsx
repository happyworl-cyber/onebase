'use client'

/**
 * `/platform/settings` —— 平台全局设置（仅超管）。
 *
 * 首个设置项：对外调用基址 / 网关域名。运维在此填写并保存后**即时生效**：
 * 接口文档展示的调用地址会立即用这个域名，无需改代码、无需重新构建前端、无需重启后端。
 *
 * 鉴权：平台 layout 已拦截非超管；后端路由 + handler 再校验一层。
 */

import { useEffect, useState } from 'react'
import { platformSettingsAPI, type PlatformSettings } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'

export default function PlatformSettingsPage() {
  const notify = useNotification()
  const [settings, setSettings] = useState<PlatformSettings | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await platformSettingsAPI.get()
      setSettings(res.data)
      setDraft(res.data.public_base_url ?? '')
    } catch (err: any) {
      notify.error(err)
      setSettings(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const trimmed = draft.trim().replace(/\/+$/, '')
  const invalid = trimmed !== '' && !/^https?:\/\//i.test(trimmed)
  const dirty = trimmed !== (settings?.public_base_url ?? '')

  const handleSave = async () => {
    if (invalid) {
      notify.error('对外基址必须以 http:// 或 https:// 开头')
      return
    }
    setSaving(true)
    try {
      await platformSettingsAPI.update({ public_base_url: trimmed === '' ? null : trimmed })
      notify.success('已保存，接口文档将立即使用新的对外地址')
      await load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">网关域名</h1>
        <p className="text-sm text-slate-500 mt-1">平台级默认对外调用基址，全局生效；各项目可在自己的设置里覆盖。仅超级管理员可修改。</p>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl shadow-sm p-8 text-center text-sm text-slate-400">加载中…</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm p-6 space-y-5">
          <div>
            <h2 className="font-semibold text-slate-800">对外调用基址（网关域名）</h2>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              接口文档里展示的调用地址会用这个域名拼接。运维在网关层新增对外域名后，填在这里即可，
              <span className="text-slate-700 font-medium">保存后立即生效，无需重启或重新发布</span>。
              留空则自动回落到环境变量 <code className="bg-slate-100 px-1 rounded">PUBLIC_BASE_URL</code> 或网关转发头。
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">对外基址 URL</label>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://gw.example.com"
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 ${
                invalid
                  ? 'border-red-400 focus:ring-red-200'
                  : 'border-slate-300 focus:ring-indigo-200 focus:border-indigo-400'
              }`}
            />
            {invalid ? (
              <p className="text-xs text-red-500 mt-1">必须以 http:// 或 https:// 开头。</p>
            ) : (
              <p className="text-xs text-slate-400 mt-1">不含末尾斜杠；例如 https://gw.example.com</p>
            )}
          </div>

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 w-28 shrink-0">当前生效地址</span>
              <code className="text-slate-800 break-all">{settings?.effective_base_url || '（浏览器 origin）'}</code>
            </div>
            {settings?.env_public_base_url && (
              <div className="flex items-center gap-2">
                <span className="text-slate-500 w-28 shrink-0">环境变量兜底</span>
                <code className="text-slate-600 break-all">{settings.env_public_base_url}</code>
              </div>
            )}
            <p className="text-xs text-slate-400 pt-1">
              优先级：本页配置 &gt; 环境变量 PUBLIC_BASE_URL &gt; 网关转发头 X-Forwarded-Host &gt; 浏览器 origin
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || invalid || !dirty}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            {dirty && !saving && <span className="text-xs text-amber-600">有未保存的改动</span>}
          </div>
        </div>
      )}
    </div>
  )
}
