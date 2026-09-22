'use client'

/**
 * 执行回放视图 —— 工作流详情/编辑页的"执行回放"入口打开的全屏层。
 * 运行选择（左） + G6 执行图（中，ReplayGraphCanvas） + 选中节点详情（右）。
 *
 * mockRuns/mockRunDetails 仅供本地 dev 预览页注入 fixture、跳过真实网络请求
 * （同依赖图 WorkflowGraphCanvas 的 mockData prop 先例），生产路径不传。
 */

import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDateTime } from '@/lib/utils'
import type { WorkflowEdgeDef, WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'
import {
  emptyResponseReason,
  isEmptyResponseNode,
  isEmptyValue,
  nodeConfigHighlights,
  REPLAY_SPECIAL_DESCRIPTION,
} from './replayGraphData'
import {
  fetchReplayRunDetail,
  fetchReplayRuns,
  type ReplayRunDetail,
  type ReplayRunSummary,
} from './replayApi'

const ReplayGraphCanvas = dynamic(() => import('./ReplayGraphCanvas'), { ssr: false })

const RUN_STATUS_META: Record<string, { labelKey: string; className: string }> = {
  completed: { labelKey: 'statusCompleted', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { labelKey: 'statusFailed', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  timeout: { labelKey: 'statusTimeout', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  running: { labelKey: 'statusRunning', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  pending: { labelKey: 'statusPending', className: 'bg-slate-50 text-slate-600 border-slate-200' },
}

function runStatusMeta(status: string) {
  return RUN_STATUS_META[status] ?? { labelKey: '', className: 'bg-slate-50 text-slate-600 border-slate-200' }
}

/** 快照区块展示文案：空值显式写"（空）"，否则格式化 JSON——别让"没数据"和"没显示"混为一谈。 */
function formatSnapshot(v: unknown, t: (k: string) => string): string {
  return isEmptyValue(v) ? t('empty') : JSON.stringify(v, null, 2)
}

interface Props {
  workflowId: number
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  onClose: () => void
  mockRuns?: ReplayRunSummary[] | null
  mockRunDetails?: Record<number, ReplayRunDetail> | null
  /**
   * 从"执行记录"列表某一行的"查看执行回放"进来时，预选这次运行；运行列表仍完整展示、
   * 可再切换到别的 run。不在列表里（如已被清理）时静默回退到默认（最近一次）。
   */
  initialRunId?: number | null
}

export default function ExecutionReplayView({
  workflowId,
  nodes,
  edges,
  onClose,
  mockRuns = null,
  mockRunDetails = null,
  initialRunId = null,
}: Props) {
  const t = useTranslations('wfReplay')
  const [runs, setRuns] = useState<ReplayRunSummary[]>([])
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [runDetail, setRunDetail] = useState<ReplayRunDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

// 默认选中项：优先用调用方指定的 initialRunId（如"执行记录"某行点进来的那次运行），
  // 但要求它确实在本次拉到的列表里，否则（已被清理等）静默回退到最近一次，不留一个选不中的死态。
  const pickDefaultRunId = (list: ReplayRunSummary[]): number | null =>
    (initialRunId != null && list.some((r) => r.id === initialRunId) ? initialRunId : list[0]?.id) ?? null

  // 运行列表：mock 优先（dev 预览），否则真实拉取；缺省选中最近一次（列表已按 started_at DESC 排序）。
  useEffect(() => {
    if (mockRuns) {
      setRuns(mockRuns)
      setLoadingRuns(false)
      setSelectedRunId(pickDefaultRunId(mockRuns))
      return
    }
    let cancelled = false
    setLoadingRuns(true)
    setRunsError(null)
    fetchReplayRuns(workflowId)
      .then((list) => {
        if (cancelled) return
        setRuns(list)
        setSelectedRunId(pickDefaultRunId(list))
      })
      .catch((err) => {
        if (!cancelled) setRunsError(err?.message || t('runsLoadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoadingRuns(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, mockRuns])

  // 选中运行变化 → 拉该次运行明细（node_results）；换运行时清空之前选中的节点，避免详情面板
  // 残留上一次运行里同名节点的旧状态。
  useEffect(() => {
    setSelectedNodeId(null)
    if (selectedRunId == null) {
      setRunDetail(null)
      return
    }
    if (mockRunDetails) {
      setRunDetail(mockRunDetails[selectedRunId] ?? null)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    setDetailError(null)
    fetchReplayRunDetail(workflowId, selectedRunId)
      .then((detail) => {
        if (!cancelled) setRunDetail(detail)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err?.message || t('detailLoadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, selectedRunId, mockRunDetails])

  const nodeResults = runDetail?.node_results ?? []
  const selectedNodeResult = useMemo(
    () => (selectedNodeId ? nodeResults.find((r) => r.node_id === selectedNodeId) ?? null : null),
    [nodeResults, selectedNodeId],
  )
  const selectedNodeDef = useMemo(
    () => (selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null),
    [nodes, selectedNodeId],
  )

  const handleSelectNode = useCallback((id: string | null) => setSelectedNodeId(id), [])

  const selectedNodeHighlights = useMemo(
    () => (selectedNodeDef ? nodeConfigHighlights(selectedNodeDef.type, selectedNodeDef.config) : []),
    [selectedNodeDef],
  )

  const selectedEmptyReason = useMemo(
    () =>
      selectedNodeResult
        ? emptyResponseReason(selectedNodeResult.node_type ?? null, selectedNodeResult.status, selectedNodeResult.output)
        : null,
    [selectedNodeResult],
  )

  // 图上一个节点可能同时挂好几种标记（特殊类型角标/空响应琥珀/失败红/跳过灰/条件分支），
  // 这里把"这些标记分别代表什么"翻成人话一次性列出来，别让人对着图标猜。
  const markerNotes = useMemo(() => {
    if (!selectedNodeDef) return [] as { icon: string; text: string; className: string }[]
    const notes: { icon: string; text: string; className: string }[] = []
    const specialDesc = REPLAY_SPECIAL_DESCRIPTION[selectedNodeDef.type]
    if (specialDesc) notes.push({ icon: '🏷', text: specialDesc, className: 'text-slate-600' })
    if (!selectedNodeResult) {
      notes.push({ icon: '⚪', text: t('noteNotRun'), className: 'text-slate-400' })
      return notes
    }
    if (selectedNodeResult.status === 'failed') {
      notes.push({ icon: '❌', text: t('noteFailed'), className: 'text-rose-600' })
    } else if (selectedNodeResult.status === 'failed_allowed') {
      notes.push({ icon: '⚠', text: t('noteFailedTolerated'), className: 'text-amber-600' })
    } else if (selectedNodeResult.status === 'skipped') {
      notes.push({ icon: '⏭', text: t('noteSkipped'), className: 'text-slate-500' })
    }
    if (selectedNodeResult.branch) {
      notes.push({ icon: '🔀', text: t('noteBranch', { branch: selectedNodeResult.branch }), className: 'text-indigo-600' })
    }
    if (selectedEmptyReason) {
      notes.push({ icon: '⚠', text: t('noteEmpty', { reason: selectedEmptyReason }), className: 'text-amber-700' })
    }
    return notes
  }, [selectedNodeDef, selectedNodeResult, selectedEmptyReason])

  // 空响应节点 id 列表——判空口径与 ReplayGraphCanvas 图上角标共用同一个 isEmptyResponseNode，
  // 两处不会出现"总览数了 N 个、图上标出来的却不是这 N 个"的口径不一致。
  const emptyResponseNodeIds = useMemo(
    () =>
      nodeResults
        .filter((r) => isEmptyResponseNode(r.node_type ?? null, r.status, r.output))
        .map((r) => r.node_id),
    [nodeResults],
  )
  // 逐个聚焦游标：每次点击总览统计行推进一步，循环回到第一个；换节点选中会让这个游标脱节，
  // 但下次点击总览行时会按"当前选中节点是否在列表里"重新对齐（见 handleFocusEmptyResponse）。
  const [emptyFocusIndex, setEmptyFocusIndex] = useState(0)
  const handleFocusEmptyResponse = useCallback(() => {
    if (emptyResponseNodeIds.length === 0) return
    setEmptyFocusIndex((prevIndex) => {
      const currentIdx = selectedNodeId ? emptyResponseNodeIds.indexOf(selectedNodeId) : -1
      const nextIndex = currentIdx >= 0 ? (currentIdx + 1) % emptyResponseNodeIds.length : prevIndex % emptyResponseNodeIds.length
      setSelectedNodeId(emptyResponseNodeIds[nextIndex])
      return nextIndex
    })
  }, [emptyResponseNodeIds, selectedNodeId])

  return (
    <div data-alt="execution-replay-overlay" className="fixed inset-0 z-50 flex bg-white" style={{ right: 'var(--ai-panel-offset, 0px)' }}>
      {/* 左：运行选择列表 */}
      <aside data-alt="replay-run-list" className="w-72 shrink-0 border-r border-slate-200 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
          <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
            <i className="fas fa-clock-rotate-left text-[11px] text-slate-400" />
            {t('replay')}
          </h3>
          <button
            data-alt="replay-close-button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-lg leading-none"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingRuns ? (
            <div className="p-4 text-center text-xs text-slate-400">{t('loading')}</div>
          ) : runsError ? (
            <div className="p-4 text-center text-xs text-rose-500">{runsError}</div>
          ) : runs.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-400">{t('noRuns')}</div>
          ) : (
            <ul>
              {runs.map((run) => {
                const meta = runStatusMeta(run.status)
                const active = run.id === selectedRunId
                return (
                  <li key={run.id}>
                    <button
                      data-alt={`replay-run-item-${run.id}`}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`w-full text-left px-4 py-2.5 border-b border-slate-100 transition ${
                        active ? 'bg-indigo-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono text-slate-500">#{run.id}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${meta.className}`}>
                          {meta.labelKey ? t(meta.labelKey) : run.status}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        {formatDateTime(run.started_at)}
                        {run.elapsed_ms != null && <span className="ml-1.5">· {run.elapsed_ms}ms</span>}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* 中：G6 执行图 */}
      <div data-alt="replay-canvas-area" className="relative flex-1 min-w-0">
        {loadingDetail && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70">
            <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-4 py-2.5 text-sm text-slate-500 shadow-soft">
              <i className="fas fa-circle-notch fa-spin text-indigo-400" />
              {t('detailLoading')}
            </div>
          </div>
        )}
        {detailError && !loadingDetail && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/90">
            <div className="flex items-center gap-2 rounded-lg border border-rose-100 bg-white px-4 py-2.5 text-sm text-rose-600 shadow-soft">
              <i className="fas fa-triangle-exclamation" />
              {detailError}
            </div>
          </div>
        )}
        {!loadingRuns && runs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-sm text-slate-400">{t('noRunsCantReplay')}</div>
          </div>
        )}
        {selectedRunId != null && runDetail && (
          <ReplayGraphCanvas
            nodes={nodes}
            edges={edges}
            nodeResults={nodeResults}
            selectedNodeId={selectedNodeId}
            onSelectNode={handleSelectNode}
          />
        )}
      </div>

      {/* 右：运行总览 / 选中节点详情 */}
      <aside data-alt="replay-side-panel" className="w-80 shrink-0 border-l border-slate-200 p-4 overflow-y-auto">
        {/* 空响应统计常显（不放进下方两个互斥分支里）——否则点一次选中节点后统计行就被节点详情
            挤掉，"逐个聚焦"就没法连续点第二下了。 */}
        {runDetail && emptyResponseNodeIds.length > 0 && (
          <button
            data-alt="replay-empty-response-summary"
            onClick={handleFocusEmptyResponse}
            className="mb-3 flex w-full items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-700 hover:bg-amber-100 transition"
          >
            <span>{t('emptyRespNodes', { n: emptyResponseNodeIds.length })}</span>
            <span className="text-[10px] text-amber-500">{t('clickFocusEach')}</span>
          </button>
        )}
        {selectedNodeDef ? (
          <div data-alt="replay-node-detail">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{t('nodeDetail')}</div>
            <div className="text-sm font-medium text-slate-800 mb-1 flex items-center gap-1.5">
              {selectedNodeDef.label || selectedNodeDef.id}
              {selectedNodeResult && isEmptyResponseNode(selectedNodeResult.node_type ?? null, selectedNodeResult.status, selectedNodeResult.output) && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border bg-amber-50 text-amber-700 border-amber-200">
                  {t('emptyResp')}
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mb-1">{t('typeLabel', { type: selectedNodeDef.type })}</div>
            {markerNotes.length > 0 && (
              <div className="mt-1 mb-2 space-y-1 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-400">{t('markNote')}</div>
                {markerNotes.map((n, i) => (
                  <div key={i} className={`text-xs ${n.className}`}>
                    {n.icon} {n.text}
                  </div>
                ))}
              </div>
            )}
            {selectedNodeHighlights.length > 0 && (
              <div className="mt-2 space-y-1 rounded-lg border border-slate-100 bg-slate-50 p-2">
                {selectedNodeHighlights.map((h) => (
                  <div key={h.label} className="text-xs">
                    <span className="text-slate-400">{h.label}：</span>
                    <span className="text-slate-600 font-mono break-all">{h.value}</span>
                  </div>
                ))}
              </div>
            )}
            {selectedNodeDef.config != null && Object.keys(selectedNodeDef.config).length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600">{t('fullConfig')}</summary>
                <pre className="mt-1 p-2 bg-slate-50 rounded text-[11px] font-mono overflow-auto max-h-48">
                  {JSON.stringify(selectedNodeDef.config, null, 2)}
                </pre>
              </details>
            )}
            {selectedNodeResult ? (
              <>
                <div className="text-xs text-slate-500 mb-1">{t('nodeStatus', { status: selectedNodeResult.status })}</div>
                {selectedNodeResult.status === 'skipped' ? (
                  <div className="text-xs text-slate-500 mb-1">{t('elapsedSkipped')}</div>
                ) : (
                  selectedNodeResult.elapsed_ms != null && (
                    <div className="text-xs text-slate-500 mb-1">{t('elapsedMs', { ms: selectedNodeResult.elapsed_ms })}</div>
                  )
                )}
                {selectedNodeResult.branch && (
                  <div className="text-xs text-slate-500 mb-1">{t('branchTaken', { branch: selectedNodeResult.branch })}</div>
                )}
                {selectedNodeResult.error && (
                  <div className="mt-2 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg p-2 font-mono whitespace-pre-wrap">
                    {selectedNodeResult.error}
                  </div>
                )}
                <details className="mt-2">
                  <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600">{t('inputSnapshot')}</summary>
                  <pre className="mt-1 p-2 bg-slate-50 rounded text-[11px] font-mono overflow-auto max-h-48">
                    {formatSnapshot(selectedNodeResult.input, t)}
                  </pre>
                </details>
                <details className="mt-2" open>
                  <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600">{t('outputSnapshot')}</summary>
                  <pre className="mt-1 p-2 bg-slate-50 rounded text-[11px] font-mono overflow-auto max-h-48">
                    {formatSnapshot(selectedNodeResult.output, t)}
                  </pre>
                </details>
              </>
            ) : (
              <div className="mt-2 text-xs text-slate-400">{t('notReached')}</div>
            )}
          </div>
        ) : (
          <div data-alt="replay-run-summary">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{t('runOverview')}</div>
            {runDetail ? (
              <>
                <div className="text-xs text-slate-500 mb-1">
                  {t('runStatus', { label: (() => { const m = runStatusMeta(runDetail.status); return m.labelKey ? t(m.labelKey) : runDetail.status })() })}
                </div>
                {runDetail.elapsed_ms != null && (
                  <div className="text-xs text-slate-500 mb-1">{t('totalElapsed', { ms: runDetail.elapsed_ms })}</div>
                )}
                <div className="text-xs text-slate-500 mb-1">{t('startedAt', { time: formatDateTime(runDetail.started_at) })}</div>
                {emptyResponseNodeIds.length === 0 && (
                  <div className="text-xs text-slate-500 mb-1">{t('emptyRespCount', { n: 0 })}</div>
                )}
                {runDetail.error_message && (
                  <div className="mt-2 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg p-2 font-mono whitespace-pre-wrap">
                    {runDetail.error_message}
                  </div>
                )}
                <div className="mt-3 text-[11px] text-slate-400">{t('clickNodeHint')}</div>
              </>
            ) : (
              <div className="text-xs text-slate-400">{t('selectRunHint')}</div>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
