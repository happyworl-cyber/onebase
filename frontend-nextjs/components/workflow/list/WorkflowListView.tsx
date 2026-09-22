'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import FolderTree from './FolderTree'
import WorkflowBreadcrumb from './WorkflowBreadcrumb'
import WorkflowListToolbar from './WorkflowListToolbar'
import WorkflowRow, { WorkflowCard } from './WorkflowRow'
import WorkflowListPagination from './WorkflowListPagination'
import NewFolderDialog from './NewFolderDialog'
import WorkflowConfirmDialog from './WorkflowConfirmDialog'
import WorkflowListHeader from './WorkflowListHeader'
import WorkflowBatchBanner from './WorkflowBatchBanner'
import WorkflowBatchBar, { type BatchModalType } from './WorkflowBatchBar'
import WorkflowBatchModals from './WorkflowBatchModals'
import WorkflowBatchImportModal from './WorkflowBatchImportModal'
import { showToast } from '@/components/Toast'
import { customFoldersStorageKey, FOLDER_NAME_PRESETS } from './constants'
import {
  DEFAULT_LIST_PER_PAGE,
  DEFAULT_LIST_SORT,
  ROOT_FOLDER_ID,
  type WorkflowFolder,
  type WorkflowListItem,
  type WorkflowListPageState,
} from './types'
import {
  buildFolderTree,
  folderTaxonomyFromFolderId,
  applyCustomFoldersCategoryMove,
  applyCustomFoldersRename,
  canRenameFolder,
  catIdFromNames,
  catNamesFromId,
  categoryExistsInDeptFromGroups,
  categoryWorkflowCountFromGroups,
  defaultActiveFolderIdFromGroups,
  deptIdFromName,
  deptNameFromId,
  remapFolderIdAfterDeptRename,
  remapExpandedAfterRename,
  renamedFolderId,
  siblingFolderNames,
  expandFolderPath,
  folderNavStorageKey,
  loadCustomFolders,
  loadListPrefs,
  loadSavedFolderId,
  normalizeListPerPage,
  placementsFromSummaryGroups,
  resolveCreateFolderAction,
  sanitizeCustomFolders,
  saveCustomFolders,
  saveListPrefs,
  saveSavedFolderId,
  workflowFolderId,
  countInFolderFromGroups,
  type WorkflowGroupCount,
} from './utils'
import {
  apiFoldersToCustomFolders,
  createApiFolder,
  deleteApiFolder,
  ensureApiDeptFolder,
  fetchApiFolders,
  findApiCategoryFolder,
  moveApiCategoryFolder,
  renameApiFolder,
  type ApiWorkflowFolder,
} from './folderApi'
import { fetchWorkflowList, fetchWorkflowSummary } from './listApi'
import { WORKFLOW_GRAPH_ENTRY_VISIBLE } from '@/lib/featureFlags'

export interface WorkflowListViewProps {
  cleaning: boolean
  defaultDatabaseId?: number | null
  /** workspace 的 projectId（tenants.id），用于拼"依赖图"按钮的跳转链接。 */
  projectId?: number | null
  refreshToken?: number
  onSummaryChange?: (groups: WorkflowGroupCount[], total: number) => void
  onNewWorkflow: (folderPlacement?: { department: string; category?: string | null }) => void
  onEdit: (wf: WorkflowListItem) => void
  onToggle: (wf: WorkflowListItem) => void
  onPublish: (wf: WorkflowListItem) => void
  onDiscardDraft: (wf: WorkflowListItem) => void
  onRun: (wf: WorkflowListItem) => void
  onShowRuns: (wf: WorkflowListItem) => void
  onDuplicate: (wf: WorkflowListItem) => void
  onShare: (wf: WorkflowListItem) => void
  onOpenVersionHistory?: (wf: WorkflowListItem) => void
  onExport: (wf: WorkflowListItem) => void
  onDelete: (wf: WorkflowListItem) => void
  onCleanupRuns: () => void
  onShowMcpGuide: () => void
  onMoveCategory?: (
    categoryFolderId: string,
    targetDeptFolderId: string,
    opts: { workflowCount: number },
  ) => Promise<void>
  onRenameFolder?: (
    folderId: string,
    newName: string,
    opts: { workflowCount: number },
  ) => Promise<void>
}

function initialExpanded(folders: WorkflowFolder[]): Set<string> {
  return new Set(folders.map((f) => f.id))
}

export default function WorkflowListView({
  cleaning,
  defaultDatabaseId,
  projectId,
  refreshToken = 0,
  onSummaryChange,
  onNewWorkflow,
  onEdit,
  onToggle,
  onPublish,
  onDiscardDraft,
  onRun,
  onShowRuns,
  onDuplicate,
  onShare,
  onOpenVersionHistory,
  onExport,
  onDelete,
  onCleanupRuns,
  onShowMcpGuide,
  onMoveCategory,
  onRenameFolder,
}: WorkflowListViewProps) {
  const tr = useTranslations('wfManager')
  const storageKey = customFoldersStorageKey(defaultDatabaseId)
  const folderNavKey = folderNavStorageKey(defaultDatabaseId)
  const [customFolders, setCustomFolders] = useState<WorkflowFolder[]>([])
  const [apiFolders, setApiFolders] = useState<ApiWorkflowFolder[]>([])
  const [newFolderParent, setNewFolderParent] = useState<string | null | false>(false)
  const [renameTarget, setRenameTarget] = useState<string | false>(false)
  const [renamingFolder, setRenamingFolder] = useState(false)
  const [movingCategory, setMovingCategory] = useState(false)
  const [pendingMove, setPendingMove] = useState<{
    categoryFolderId: string
    targetDeptFolderId: string
    message: string
    workflowCount: number
  } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ folderId: string; message: string } | null>(
    null,
  )
  const [deletingFolder, setDeletingFolder] = useState(false)

  const [summaryGroups, setSummaryGroups] = useState<WorkflowGroupCount[]>([])
  const [summaryTotal, setSummaryTotal] = useState(0)
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [authors, setAuthors] = useState<string[]>([])
  const [updaters, setUpdaters] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedMap, setSelectedMap] = useState<Map<number, WorkflowListItem>>(new Map())
  const [batchModal, setBatchModal] = useState<BatchModalType>(null)
  const [moveSubset, setMoveSubset] = useState<WorkflowListItem[] | null>(null)
  const [showBatchImport, setShowBatchImport] = useState(false)
  const bannerCheckboxRef = useRef<HTMLInputElement>(null)

  const useServerFolders = defaultDatabaseId != null

  const reloadRemoteFolders = useCallback(async () => {
    if (defaultDatabaseId == null) return
    try {
      const remote = await fetchApiFolders(defaultDatabaseId)
      setApiFolders(remote)
      setCustomFolders(apiFoldersToCustomFolders(remote))
    } catch (err) {
      console.warn(tr('loadEmptyFoldersFailed'), err)
      setCustomFolders(sanitizeCustomFolders(loadCustomFolders(storageKey)))
    }
  }, [defaultDatabaseId, storageKey])

  const persistLocalCustomFolders = useCallback(
    (next: WorkflowFolder[]) => {
      const clean = sanitizeCustomFolders(next)
      setCustomFolders(clean)
      if (!useServerFolders) saveCustomFolders(storageKey, clean)
    },
    [storageKey, useServerFolders],
  )

  const folders = useMemo(
    () => buildFolderTree(placementsFromSummaryGroups(summaryGroups), customFolders),
    [summaryGroups, customFolders],
  )

  const prefs = useMemo(() => loadListPrefs(), [])

  const [state, setState] = useState<WorkflowListPageState>(() => {
    const savedFolder = loadSavedFolderId(folderNavStorageKey(defaultDatabaseId))
    return {
      folderId: savedFolder ?? ROOT_FOLDER_ID,
      expanded: prefs.expanded ?? new Set([ROOT_FOLDER_ID]),
      status: 'all',
      trigs: new Set(),
      author: null,
      updater: null,
      sort: prefs.sort ?? DEFAULT_LIST_SORT,
      view: prefs.view ?? 'compact',
      search: '',
      globalSearch: false,
      page: 1,
      perPage: normalizeListPerPage(prefs.perPage) ?? DEFAULT_LIST_PER_PAGE,
    }
  })

  useEffect(() => {
    if (useServerFolders) {
      void reloadRemoteFolders()
      return
    }
    persistLocalCustomFolders(loadCustomFolders(storageKey))
  }, [useServerFolders, reloadRemoteFolders, storageKey, persistLocalCustomFolders])

  // 文件夹树就绪后：展开当前路径（含二级分类的父部门）
  useEffect(() => {
    if (folders.length <= 1) return
    setState((s) => {
      const nextExpanded = expandFolderPath(folders, s.folderId, s.expanded)
      const unchanged =
        nextExpanded.size === s.expanded.size &&
        Array.from(nextExpanded).every((id) => s.expanded.has(id))
      return unchanged ? s : { ...s, expanded: nextExpanded }
    })
  }, [folders])

  // 首次进入且无历史选中时，默认打开第一个有数据的部门
  useEffect(() => {
    if (summaryTotal === 0) return
    if (loadSavedFolderId(folderNavKey)) return
    setState((s) => {
      if (s.folderId !== ROOT_FOLDER_ID) return s
      const next = defaultActiveFolderIdFromGroups(summaryGroups, folders)
      if (next === ROOT_FOLDER_ID) return s
      saveSavedFolderId(folderNavKey, next)
      return {
        ...s,
        folderId: next,
        expanded: expandFolderPath(folders, next, s.expanded),
      }
    })
  }, [summaryTotal, summaryGroups, folders, folderNavKey])

  useEffect(() => {
    saveListPrefs({
      sort: state.sort,
      view: state.view,
      perPage: state.perPage,
      expanded: state.expanded,
    })
  }, [state.sort, state.view, state.perPage, state.expanded])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(state.search), 300)
    return () => window.clearTimeout(t)
  }, [state.search])

  const listState = useMemo(
    () => ({ ...state, search: debouncedSearch }),
    [state, debouncedSearch],
  )

  const reloadSummary = useCallback(async () => {
    try {
      const summary = await fetchWorkflowSummary(defaultDatabaseId)
      setSummaryGroups(summary.groups)
      setSummaryTotal(summary.total)
      onSummaryChange?.(summary.groups, summary.total)
    } catch (err) {
      console.error(tr('loadStatsFailed'), err)
    }
  }, [defaultDatabaseId, onSummaryChange])

  const reloadList = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchWorkflowList(listState, defaultDatabaseId)
      setWorkflows(result.workflows)
      setListTotal(result.total)
      setAuthors(result.authors ?? [])
      setUpdaters(result.updaters ?? [])
    } catch (err) {
      console.error(tr('loadListFailed'), err)
    } finally {
      setLoading(false)
    }
  }, [listState, defaultDatabaseId])

  useEffect(() => {
    void reloadSummary()
  }, [reloadSummary, refreshToken])

  useEffect(() => {
    void reloadList()
  }, [reloadList, refreshToken])

  // 筛选变化时回到第一页（搜索由 debounce 单独触发，不重复重置）
  useEffect(() => {
    setState((s) => (s.page === 1 ? s : { ...s, page: 1 }))
  }, [
    state.folderId,
    state.globalSearch,
    state.status,
    state.trigs,
    state.author,
    state.updater,
    state.sort,
    state.perPage,
    debouncedSearch,
  ])

  const totalPages = Math.max(1, Math.ceil(listTotal / state.perPage))
  const currentPage = Math.min(state.page, totalPages)

  useEffect(() => {
    if (state.page !== currentPage) {
      setState((s) => ({ ...s, page: currentPage }))
    }
  }, [state.page, currentPage])

  const pageData = workflows

  const selectedList = useMemo(() => Array.from(selectedMap.values()), [selectedMap])
  const selectedCount = selectedMap.size
  const batchActive = selectedCount > 0
  const currentPageIds = useMemo(() => pageData.map((w) => w.id), [pageData])
  const allPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selectedMap.has(id))
  const somePageSelected = currentPageIds.some((id) => selectedMap.has(id))

  const clearSelection = useCallback(() => {
    setSelectedMap(new Map())
    setBatchModal(null)
  }, [])

  const toggleSelect = useCallback((wf: WorkflowListItem) => {
    setSelectedMap((prev) => {
      const next = new Map(prev)
      if (next.has(wf.id)) next.delete(wf.id)
      else next.set(wf.id, wf)
      return next
    })
  }, [])

  const togglePageAll = useCallback(() => {
    setSelectedMap((prev) => {
      const next = new Map(prev)
      const allSel = currentPageIds.length > 0 && currentPageIds.every((id) => next.has(id))
      if (allSel) {
        currentPageIds.forEach((id) => next.delete(id))
      } else {
        pageData.forEach((wf) => next.set(wf.id, wf))
      }
      return next
    })
  }, [currentPageIds, pageData])

  useEffect(() => {
    const el = bannerCheckboxRef.current
    if (!el) return
    el.indeterminate = somePageSelected && !allPageSelected
  }, [somePageSelected, allPageSelected])

  const handleBatchComplete = useCallback(() => {
    clearSelection()
    void reloadSummary()
    void reloadList()
  }, [clearSelection, reloadSummary, reloadList])

  const resetFiltersOnFolderChange = useCallback((folderId: string) => {
    saveSavedFolderId(folderNavKey, folderId)
    clearSelection()
    setState((s) => ({
      ...s,
      folderId,
      page: 1,
      globalSearch: false,
      trigs: new Set(),
      author: null,
      updater: null,
      status: 'all',
      search: '',
      expanded: expandFolderPath(folders, folderId, s.expanded),
    }))
  }, [folderNavKey, folders, clearSelection])

  const folderPlacementForNew = folderTaxonomyFromFolderId(state.folderId) ?? undefined

  // 依赖图入口带 scope：只有选中到具体「分类」节点（department+category 都确定）才带 query，
  // 纯部门节点/根节点/搜索态一律进全量视图——后端 department+category 必须同时给才生效。
  const router = useRouter()
  const graphScope = useMemo(() => catNamesFromId(state.folderId), [state.folderId])
  const graphHref = useMemo(() => {
    const base = `/workspace/${projectId}/automation/workflow-graph`
    if (!graphScope) return base
    const qs = new URLSearchParams({ department: graphScope.dept, category: graphScope.cat })
    return `${base}?${qs.toString()}`
  }, [projectId, graphScope])

  // 多入口 focus（P1.3⑤）行级入口："在依赖图中查看此工作流"——进全量图（不带 scope，
  // 保留该工作流的完整上下游上下文）+ focus=id 自动定位，而不是复用带 scope 的 graphHref
  // （分类主集可能不含它调用/被调用的外部工作流，focus 场景要看的是这条工作流本身的全貌）。
  const openWorkflowInGraph = useCallback(
    (wf: WorkflowListItem) => {
      if (projectId == null) return
      router.push(`/workspace/${projectId}/automation/workflow-graph?focus=${wf.id}`)
    },
    [projectId, router],
  )

  const createFolderAction = useMemo(
    () => resolveCreateFolderAction(state.folderId),
    [state.folderId],
  )

  const newFolderParentName =
    newFolderParent === false
      ? ''
      : newFolderParent === null
        ? tr('allWorkflows')
        : folders.find((f) => f.id === newFolderParent)?.name ?? tr('allWorkflows')

  const newFolderKind: 'department' | 'category' =
    newFolderParent !== false && newFolderParent !== null && newFolderParent.startsWith('dept:')
      ? 'category'
      : 'department'

  const isEmptyFolder =
    !state.search &&
    !state.globalSearch &&
    state.status === 'all' &&
    state.trigs.size === 0 &&
    !state.author &&
    !state.updater &&
    listTotal === 0 &&
    countInFolderFromGroups(summaryGroups, state.folderId) === 0

  const handleCreateFolder = async (name: string) => {
    if (newFolderParent === false) return
    const parentId = newFolderParent === null ? ROOT_FOLDER_ID : newFolderParent
    const trimmed = name.trim()
    if (!trimmed) return

    let folder: WorkflowFolder
    if (parentId === ROOT_FOLDER_ID) {
      folder = {
        id: deptIdFromName(trimmed),
        parent_id: ROOT_FOLDER_ID,
        name: trimmed,
        ...(FOLDER_NAME_PRESETS[trimmed] ?? { icon: 'fa-folder', color: 'text-slate-500' }),
      }
    } else if (parentId.startsWith('dept:')) {
      const dept = deptNameFromId(parentId)!
      folder = {
        id: catIdFromNames(dept, trimmed),
        parent_id: parentId,
        name: trimmed,
        icon: 'fa-tag',
        color: 'text-slate-500',
      }
    } else {
      return
    }

    if (useServerFolders && defaultDatabaseId != null) {
      try {
        let parentApiId: number | null = null
        if (parentId !== ROOT_FOLDER_ID) {
          const dept = deptNameFromId(parentId)
          if (!dept) return
          const deptRow = await ensureApiDeptFolder(defaultDatabaseId, dept, apiFolders)
          parentApiId = deptRow.id
        }
        await createApiFolder(defaultDatabaseId, trimmed, parentApiId)
        await reloadRemoteFolders()
        void reloadSummary()
      } catch (err) {
        console.error(tr('createFolderFailed'), err)
        showToast('error', tr('createFolderFailedToast'))
        return
      }
    } else {
      persistLocalCustomFolders([...customFolders.filter((f) => f.id !== folder.id), folder])
    }

    setNewFolderParent(false)
    saveSavedFolderId(folderNavKey, folder.id)
    resetFiltersOnFolderChange(folder.id)
  }

  const handleMoveCategory = (categoryFolderId: string, targetDeptFolderId: string) => {
    if (!onMoveCategory) return
    const cat = catNamesFromId(categoryFolderId)
    const targetDept = deptNameFromId(targetDeptFolderId)
    if (!cat || !targetDept || cat.dept === targetDept) return

    const workflowCount = categoryWorkflowCountFromGroups(summaryGroups, cat.dept, cat.cat)

    if (categoryExistsInDeptFromGroups(summaryGroups, customFolders, targetDept, cat.cat, categoryFolderId)) {
      showToast('warning', tr('moveConflict', { dept: targetDept, cat: cat.cat }))
      return
    }

    const message =
      workflowCount > 0
        ? tr('moveDescWithWf', { cat: cat.cat, n: workflowCount, from: cat.dept, to: targetDept })
        : tr('moveDescEmpty', { cat: cat.cat, from: cat.dept, to: targetDept })

    setPendingMove({ categoryFolderId, targetDeptFolderId, message, workflowCount })
  }

  const executeMoveCategory = async () => {
    if (!onMoveCategory || !pendingMove) return
    const { categoryFolderId, targetDeptFolderId, workflowCount } = pendingMove
    const cat = catNamesFromId(categoryFolderId)
    const targetDept = deptNameFromId(targetDeptFolderId)
    if (!cat || !targetDept) return

    const newCategoryFolderId = catIdFromNames(targetDept, cat.cat)
    setMovingCategory(true)
    try {
      if (workflowCount > 0) {
        await onMoveCategory(categoryFolderId, targetDeptFolderId, { workflowCount })
      }

      if (useServerFolders && defaultDatabaseId != null) {
        const targetDeptRow = await ensureApiDeptFolder(defaultDatabaseId, targetDept, apiFolders)
        const catRow = findApiCategoryFolder(apiFolders, cat.dept, cat.cat)
        if (catRow) {
          await moveApiCategoryFolder(catRow.id, targetDeptRow.id)
        } else if (workflowCount === 0) {
          await createApiFolder(defaultDatabaseId, cat.cat, targetDeptRow.id)
        }
        await reloadRemoteFolders()
      } else {
        persistLocalCustomFolders(
          applyCustomFoldersCategoryMove(customFolders, categoryFolderId, targetDeptFolderId, workflowCount > 0),
        )
      }

      setState((s) => {
        const nextFolderId = s.folderId === categoryFolderId ? newCategoryFolderId : s.folderId
        if (s.folderId === categoryFolderId) {
          saveSavedFolderId(folderNavKey, newCategoryFolderId)
        }
        const nextExpanded = new Set(s.expanded)
        nextExpanded.add(ROOT_FOLDER_ID)
        nextExpanded.add(targetDeptFolderId)
        return { ...s, folderId: nextFolderId, expanded: nextExpanded }
      })
      setPendingMove(null)
      showToast('success', tr('categoryMoved'))
      void reloadSummary()
      void reloadList()
    } catch (err) {
      console.error(tr('moveCategoryFailed'), err)
      showToast('error', tr('moveCategoryFailedToast'))
    } finally {
      setMovingCategory(false)
    }
  }

  const handleDeleteFolder = (folderId: string) => {
    if (folderId === ROOT_FOLDER_ID) return
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) return
    const isDept = folderId.startsWith('dept:')
    const count = countInFolderFromGroups(summaryGroups, folderId)
    const children = folders.filter((f) => f.parent_id === folderId)
    if (count > 0) {
      showToast('warning', isDept ? tr('deptHasWf') : tr('catHasWf'))
      return
    }
    if (isDept && children.length > 0) {
      showToast('warning', tr('deptHasCat'))
      return
    }
    const label = isDept ? tr('kindService') : tr('kindCategory')
    setPendingDelete({
      folderId,
      message: tr('confirmDeleteEmpty', { label, name: folder.name }),
    })
  }

  const executeDeleteFolder = async () => {
    if (!pendingDelete) return
    const { folderId } = pendingDelete
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) {
      setPendingDelete(null)
      return
    }
    setDeletingFolder(true)
    try {
      if (useServerFolders && defaultDatabaseId != null) {
        let serverId = folder.server_id
        if (serverId == null) {
          if (folderId.startsWith('dept:')) {
            const dept = deptNameFromId(folderId)
            serverId = apiFolders.find((f) => f.parent_id === null && f.name === dept)?.id
          } else {
            const cat = catNamesFromId(folderId)
            if (cat) serverId = findApiCategoryFolder(apiFolders, cat.dept, cat.cat)?.id
          }
        }
        if (serverId != null) {
          await deleteApiFolder(serverId)
        }
        await reloadRemoteFolders()
      } else {
        persistLocalCustomFolders(customFolders.filter((f) => f.id !== folderId))
      }

      if (state.folderId === folderId) {
        saveSavedFolderId(folderNavKey, ROOT_FOLDER_ID)
        setState((s) => ({ ...s, folderId: ROOT_FOLDER_ID }))
      }
      setPendingDelete(null)
      showToast('success', tr('deleted'))
      void reloadSummary()
      void reloadList()
    } catch (err) {
      console.error(tr('deleteFolderFailed'), err)
      showToast('error', tr('deleteFolderFailedToast'))
    } finally {
      setDeletingFolder(false)
    }
  }

  const executeRenameFolder = async (folderId: string, newName: string) => {
    const folder = folders.find((f) => f.id === folderId)
    if (!folder || !canRenameFolder(folderId)) return
    const trimmed = newName.trim()
    if (!trimmed || trimmed === folder.name) {
      setRenameTarget(false)
      return
    }
    const workflowCount = countInFolderFromGroups(summaryGroups, folderId)
    setRenamingFolder(true)
    try {
      if (useServerFolders && defaultDatabaseId != null) {
        let serverId = folder.server_id
        if (serverId == null) {
          if (folderId.startsWith('dept:')) {
            const dept = deptNameFromId(folderId)
            serverId = apiFolders.find((f) => f.parent_id === null && f.name === dept)?.id
          } else {
            const cat = catNamesFromId(folderId)
            if (cat) serverId = findApiCategoryFolder(apiFolders, cat.dept, cat.cat)?.id
          }
        }
        if (serverId != null) {
          await renameApiFolder(serverId, trimmed)
        }
        await reloadRemoteFolders()
      } else {
        persistLocalCustomFolders(applyCustomFoldersRename(customFolders, folderId, trimmed))
      }

      if (workflowCount > 0 && onRenameFolder) {
        await onRenameFolder(folderId, trimmed, { workflowCount })
      }

      const oldDept = deptNameFromId(folderId)
      setState((s) => {
        let mapped = s.folderId
        if (oldDept) {
          mapped = remapFolderIdAfterDeptRename(s.folderId, oldDept, trimmed)
        } else if (s.folderId === folderId) {
          mapped = renamedFolderId(folderId, trimmed) ?? s.folderId
        }
        saveSavedFolderId(folderNavKey, mapped)
        return {
          ...s,
          folderId: mapped,
          expanded: remapExpandedAfterRename(s.expanded, folderId, trimmed),
        }
      })
      setRenameTarget(false)
      showToast('success', tr('renamed'))
      void reloadSummary()
      void reloadList()
    } catch (err) {
      console.error(tr('renameFailed'), err)
      showToast('error', tr('renameFailedToast'))
      void reloadRemoteFolders()
      void reloadSummary()
      void reloadList()
    } finally {
      setRenamingFolder(false)
    }
  }

  const renameFolder = renameTarget ? folders.find((f) => f.id === renameTarget) : undefined
  const renameKind: 'department' | 'category' =
    renameTarget && renameTarget.startsWith('dept:') ? 'department' : 'category'
  const renameCount = renameTarget ? countInFolderFromGroups(summaryGroups, renameTarget) : 0

  return (
    <div className="-m-6 flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden min-h-[calc(100vh-56px)] h-[calc(100vh-56px)]">
      <div className="flex flex-1 min-h-0">
        <FolderTree
          folders={folders}
          summaryGroups={summaryGroups}
          totalCount={summaryTotal}
          activeId={state.folderId}
          expanded={state.expanded}
          onSelect={resetFiltersOnFolderChange}
          onToggleExpand={(id) =>
            setState((s) => {
              const next = new Set(s.expanded)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return { ...s, expanded: next }
            })
          }
          onNewFolder={(parentId) => setNewFolderParent(parentId)}
          onRenameFolder={(folderId) => setRenameTarget(folderId)}
          onDeleteFolder={handleDeleteFolder}
          onMoveCategory={onMoveCategory ? handleMoveCategory : undefined}
          movingCategory={movingCategory}
        />

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between shrink-0 gap-3">
            <WorkflowBreadcrumb
              folders={folders}
              folderId={state.folderId}
              globalSearch={state.globalSearch}
              search={state.search}
              onSelectFolder={resetFiltersOnFolderChange}
            />
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <button
                type="button"
                data-alt="mcp-guide-button"
                onClick={onShowMcpGuide}
                className="px-2.5 py-2 text-sm bg-white text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-50 flex items-center gap-1.5"
              >
                <i className="fas fa-plug text-[10px]" />
                {tr('mcpAccess')}
              </button>
              {createFolderAction.visible && (
                <button
                  type="button"
                  onClick={() => setNewFolderParent(createFolderAction.parentId)}
                  className="px-2.5 py-2 text-sm bg-white text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5"
                >
                  <i className="fas fa-folder-plus text-[10px] text-slate-400" />
                  {createFolderAction.label}
                </button>
              )}
              <button
                type="button"
                onClick={onCleanupRuns}
                disabled={cleaning}
                className="px-2.5 py-2 text-sm bg-white text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-50 disabled:opacity-50"
              >
                {cleaning ? tr('cleaning') : tr('cleanStuck')}
              </button>
              <button
                type="button"
                onClick={() => setShowBatchImport(true)}
                className="px-2.5 py-2 text-sm bg-white text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-50 flex items-center gap-1.5"
              >
                <i className="fas fa-layer-group text-[10px]" />
                {tr('batchImport')}
              </button>
              {WORKFLOW_GRAPH_ENTRY_VISIBLE && projectId != null && (
                <button
                  type="button"
                  data-alt="open-dependency-graph-button"
                  onClick={() => router.push(graphHref)}
                  className="px-2.5 py-2 text-sm bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5"
                  title={graphScope ? tr('graphScopeTitle', { dept: graphScope.dept, cat: graphScope.cat }) : tr('graphAllTitle')}
                >
                  <i className="fas fa-share-nodes text-[10px] text-slate-400" />
                  {tr('graph')}
                </button>
              )}
              <button
                type="button"
                onClick={() => onNewWorkflow(folderPlacementForNew)}
                className="px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-semibold flex items-center gap-1.5"
              >
                <i className="fas fa-plus text-[9px]" />
                {tr('newWorkflow')}
              </button>
            </div>
          </div>

          <WorkflowListToolbar
            state={state}
            authors={authors}
            updaters={updaters}
            onSearch={(search) => setState((s) => ({ ...s, search, page: 1 }))}
            onToggleGlobalSearch={() =>
              setState((s) => ({ ...s, globalSearch: !s.globalSearch, page: 1 }))
            }
            onSetStatus={(status) => setState((s) => ({ ...s, status, page: 1 }))}
            onToggleTrig={(key, checked) =>
              setState((s) => {
                const trigs = new Set(s.trigs)
                if (checked) trigs.add(key)
                else trigs.delete(key)
                return { ...s, trigs, page: 1 }
              })
            }
            onClearTrigs={() => setState((s) => ({ ...s, trigs: new Set(), page: 1 }))}
            onSetAuthor={(author) => setState((s) => ({ ...s, author, page: 1 }))}
            onSetUpdater={(updater) => setState((s) => ({ ...s, updater, page: 1 }))}
            onSetSort={(sort) => setState((s) => ({ ...s, sort, page: 1 }))}
            onSetView={(view) => setState((s) => ({ ...s, view, page: 1 }))}
            onResetFilters={() =>
              setState((s) => ({
                ...s,
                search: '',
                globalSearch: false,
                trigs: new Set(),
                author: null,
                updater: null,
                status: 'all',
                page: 1,
              }))
            }
          />

          <WorkflowBatchBanner
            visible={batchActive}
            selectedCount={selectedCount}
            pageCount={currentPageIds.length}
            allPageSelected={allPageSelected}
            onTogglePageAll={togglePageAll}
            onClear={clearSelection}
            bannerCheckboxRef={bannerCheckboxRef}
          />

          <div className="flex-1 overflow-y-auto" key={`${currentPage}-${state.view}-${state.folderId}`}>
            {loading ? (
              <div className="text-center py-16 text-slate-400 text-sm">{tr('loading')}</div>
            ) : listTotal === 0 ? (
              <div className="text-center py-16 text-slate-400 fade-in">
                {isEmptyFolder ? (
                  <>
                    <i className="fas fa-folder-open text-4xl text-slate-200 mb-3 block" />
                    <p className="text-sm font-medium text-slate-500">{tr('emptyFolder')}</p>
                    <button
                      type="button"
                      onClick={() => onNewWorkflow(folderPlacementForNew)}
                      className="mt-3 px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-semibold"
                    >
                      <i className="fas fa-plus text-[9px] mr-1" />
                      {tr('newWorkflow')}
                    </button>
                  </>
                ) : (
                  <>
                    <i className="fas fa-filter text-3xl text-slate-200 mb-3 block" />
                    <p className="text-sm">{tr('noMatchWorkflows')}</p>
                  </>
                )}
              </div>
            ) : state.view === 'compact' ? (
              <div className="animate-[fadeUp_0.14s_ease-out]">
                <WorkflowListHeader />
                {pageData.map((wf) => (
                  <WorkflowRow
                    key={wf.id}
                    workflow={wf}
                    folderId={workflowFolderId(wf)}
                    folders={folders}
                    globalSearch={state.globalSearch}
                    search={debouncedSearch}
                    onEdit={() => onEdit(wf)}
                    onToggle={() => onToggle(wf)}
                    onPublish={() => onPublish(wf)}
                    onDiscardDraft={() => onDiscardDraft(wf)}
                    onRun={() => onRun(wf)}
                    onShowRuns={() => onShowRuns(wf)}
                    onDuplicate={() => onDuplicate(wf)}
                    onShare={() => onShare(wf)}
                    onOpenVersionHistory={onOpenVersionHistory ? () => onOpenVersionHistory(wf) : undefined}
                    onExport={() => onExport(wf)}
                    onMove={() => {
                      setMoveSubset([wf])
                      setBatchModal('move')
                    }}
                    onDelete={() => onDelete(wf)}
                    onOpenGraph={WORKFLOW_GRAPH_ENTRY_VISIBLE && projectId != null ? () => openWorkflowInGraph(wf) : undefined}
                    selected={selectedMap.has(wf.id)}
                    onSelectToggle={() => toggleSelect(wf)}
                  />
                ))}
              </div>
            ) : (
              <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-3 animate-[fadeUp_0.14s_ease-out]">
                {pageData.map((wf) => (
                  <WorkflowCard
                    key={wf.id}
                    workflow={wf}
                    folderId={workflowFolderId(wf)}
                    folders={folders}
                    globalSearch={state.globalSearch}
                    search={debouncedSearch}
                    onEdit={() => onEdit(wf)}
                    onToggle={() => onToggle(wf)}
                    onPublish={() => onPublish(wf)}
                    onDiscardDraft={() => onDiscardDraft(wf)}
                    onRun={() => onRun(wf)}
                    onShowRuns={() => onShowRuns(wf)}
                    onDuplicate={() => onDuplicate(wf)}
                    onShare={() => onShare(wf)}
                    onOpenVersionHistory={onOpenVersionHistory ? () => onOpenVersionHistory(wf) : undefined}
                    onExport={() => onExport(wf)}
                    onMove={() => {
                      setMoveSubset([wf])
                      setBatchModal('move')
                    }}
                    onDelete={() => onDelete(wf)}
                    onOpenGraph={WORKFLOW_GRAPH_ENTRY_VISIBLE && projectId != null ? () => openWorkflowInGraph(wf) : undefined}
                    selected={selectedMap.has(wf.id)}
                    onSelectToggle={() => toggleSelect(wf)}
                  />
                ))}
              </div>
            )}
          </div>

          <WorkflowListPagination
            page={currentPage}
            perPage={state.perPage}
            total={listTotal}
            onPageChange={(page) => setState((s) => ({ ...s, page }))}
            onPerPageChange={(perPage) => setState((s) => ({ ...s, perPage, page: 1 }))}
          />
        </div>
      </div>

      {newFolderParent !== false && (
        <NewFolderDialog
          parentName={newFolderParentName}
          kind={newFolderKind}
          onConfirm={handleCreateFolder}
          onCancel={() => setNewFolderParent(false)}
        />
      )}

      {renameFolder && (
        <NewFolderDialog
          parentName={renameFolder.name}
          kind={renameKind}
          mode="rename"
          initialName={renameFolder.name}
          workflowCount={renameCount}
          siblingNames={siblingFolderNames(folders, renameFolder.id)}
          onConfirm={(name) => void executeRenameFolder(renameFolder.id, name)}
          onCancel={() => {
            if (!renamingFolder) setRenameTarget(false)
          }}
        />
      )}

      <WorkflowConfirmDialog
        open={pendingMove !== null}
        title={tr('moveCategoryModal')}
        message={pendingMove?.message ?? ''}
        confirmLabel={tr('move')}
        loading={movingCategory}
        onConfirm={() => void executeMoveCategory()}
        onCancel={() => {
          if (!movingCategory) setPendingMove(null)
        }}
      />

      <WorkflowConfirmDialog
        open={pendingDelete !== null}
        title={tr('deleteFolderModal')}
        message={pendingDelete?.message ?? ''}
        confirmLabel={tr('delete')}
        loading={deletingFolder}
        onConfirm={() => void executeDeleteFolder()}
        onCancel={() => {
          if (!deletingFolder) setPendingDelete(null)
        }}
      />

      <WorkflowBatchBar
        visible={batchActive}
        count={selectedCount}
        onExport={() => setBatchModal('export')}
        onStatus={() => setBatchModal('status')}
        onMove={() => {
          setMoveSubset(null)
          setBatchModal('move')
        }}
        onDelete={() => setBatchModal('delete')}
        onClear={clearSelection}
      />

      <WorkflowBatchModals
        modal={batchModal}
        workflows={moveSubset ?? selectedList}
        onClose={() => {
          setBatchModal(null)
          setMoveSubset(null)
        }}
        onComplete={handleBatchComplete}
        summaryGroups={summaryGroups}
        customFolders={customFolders}
        currentFolderId={state.folderId}
      />

      {showBatchImport && (
        <WorkflowBatchImportModal
          databaseId={defaultDatabaseId}
          onClose={() => setShowBatchImport(false)}
          onDone={() => {
            void reloadSummary()
            void reloadList()
          }}
        />
      )}

      <style jsx global>{`
        @keyframes fadeUp {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  )
}
