import {
  ROOT_FOLDER_ID,
  SHARED_DEPARTMENT_NAME,
  UNCATEGORIZED_FOLDER_ID,
  UNCATEGORIZED_FOLDER_NAME,
  DEFAULT_LIST_SORT,
  type WorkflowFolder,
  type WorkflowListItem,
  type WorkflowListPageState,
  type WorkflowListPerPage,
  type WorkflowListSort,
  type WorkflowListView,
} from './types'
import { FOLDER_NAME_PRESETS, LIST_PREFS_KEY } from './constants'

export const DEPT_PREFIX = 'dept:'
export const CAT_PREFIX = 'cat:'

export { SHARED_DEPARTMENT_NAME }

/** 共享部门下「未分类」分类文件夹 id */
export function sharedUncategorizedFolderId(): string {
  return uncategorizedFolderId(SHARED_DEPARTMENT_NAME)
}

export function uncategorizedFolderId(dept: string): string {
  return catIdFromNames(dept, UNCATEGORIZED_FOLDER_NAME)
}

function resolveCategoryForDept(_dept: string, cat: string): string {
  return cat || UNCATEGORIZED_FOLDER_NAME
}

/** 是否属于某部门的「未分类」（含尚未清洗的空 category） */
export function isUncategorizedPlacement(
  wf: Pick<WorkflowListItem, 'department' | 'category'>,
  dept?: string,
): boolean {
  const d = (wf.department || '').trim()
  const cat = (wf.category || '').trim()
  if (dept && d !== dept) return false
  if (!d && !cat) return !dept || dept === SHARED_DEPARTMENT_NAME
  if (!cat || cat === UNCATEGORIZED_FOLDER_NAME) return true
  return false
}

/** 从 API 字段解析 taxonomy；兼容旧单字段 category 组合串 */
export function resolveWorkflowTaxonomy(
  wf: Pick<WorkflowListItem, 'department' | 'category'>,
): { department: string | null; category: string | null } {
  const dept = (wf.department || '').trim()
  const cat = (wf.category || '').trim()
  if (dept) {
    return { department: dept, category: resolveCategoryForDept(dept, cat) }
  }
  if (!cat) return { department: SHARED_DEPARTMENT_NAME, category: UNCATEGORIZED_FOLDER_NAME }
  const slash = cat.indexOf('/')
  if (slash >= 0) {
    return {
      department: cat.slice(0, slash).trim() || null,
      category: cat.slice(slash + 1).trim() || UNCATEGORIZED_FOLDER_NAME,
    }
  }
  return { department: SHARED_DEPARTMENT_NAME, category: cat }
}

/** @deprecated 兼容旧调用 */
export function parseWorkflowTaxonomy(category: string | null | undefined) {
  return resolveWorkflowTaxonomy({ department: null, category: category ?? null })
}

export function formatWorkflowPlacement(department: string, category?: string | null) {
  const dept = department.trim()
  const cat = (category || '').trim()
  if (!dept) {
    return {
      department: SHARED_DEPARTMENT_NAME,
      category: UNCATEGORIZED_FOLDER_NAME,
    }
  }
  return { department: dept, category: cat || UNCATEGORIZED_FOLDER_NAME }
}

/** @deprecated */
export function formatWorkflowCategory(department: string, subcategory?: string | null) {
  const { department: d, category: c } = formatWorkflowPlacement(department, subcategory)
  if (!d) return ''
  if (!c) return d
  return `${d}/${c}`
}

export function deptIdFromName(name: string): string {
  return `${DEPT_PREFIX}${name}`
}

export function catIdFromNames(dept: string, cat: string): string {
  return `${CAT_PREFIX}${dept}/${cat}`
}

export function deptNameFromId(id: string): string | null {
  if (!id.startsWith(DEPT_PREFIX)) return null
  return id.slice(DEPT_PREFIX.length)
}

export function catNamesFromId(id: string): { dept: string; cat: string } | null {
  if (!id.startsWith(CAT_PREFIX)) return null
  const rest = id.slice(CAT_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  return { dept: rest.slice(0, slash), cat: rest.slice(slash + 1) }
}

export function isCategoryFolderId(folderId: string): boolean {
  return folderId.startsWith(CAT_PREFIX)
}

export function isDepartmentFolderId(folderId: string): boolean {
  return folderId.startsWith(DEPT_PREFIX)
}

/** 分类是否可拖到目标部门（非同一部门、目标是部门节点） */
export function canMoveCategoryToDept(categoryFolderId: string, targetDeptFolderId: string): boolean {
  const cat = catNamesFromId(categoryFolderId)
  const dept = deptNameFromId(targetDeptFolderId)
  if (!cat || !dept) return false
  return cat.dept !== dept
}

/** 目标部门下是否已有同名分类（工作流或空文件夹占位） */
export function categoryExistsInDept(
  workflows: WorkflowListItem[],
  customFolders: WorkflowFolder[],
  deptName: string,
  categoryName: string,
  excludeCategoryFolderId?: string,
): boolean {
  const targetCatId = catIdFromNames(deptName, categoryName)
  if (excludeCategoryFolderId && excludeCategoryFolderId === targetCatId) return false

  for (const wf of workflows) {
    const t = resolveWorkflowTaxonomy(wf)
    if (t.department === deptName && t.category === categoryName) return true
  }

  return customFolders.some((f) => f.id === targetCatId)
}

/** 移动分类后同步 localStorage 空文件夹占位 */
export function applyCustomFoldersCategoryMove(
  customFolders: WorkflowFolder[],
  categoryFolderId: string,
  targetDeptFolderId: string,
  hasWorkflows: boolean,
): WorkflowFolder[] {
  const cat = catNamesFromId(categoryFolderId)
  const targetDept = deptNameFromId(targetDeptFolderId)
  if (!cat || !targetDept) return customFolders

  const newCategoryFolderId = catIdFromNames(targetDept, cat.cat)
  const withoutOld = customFolders.filter(
    (f) => f.id !== categoryFolderId && f.id !== newCategoryFolderId,
  )

  if (hasWorkflows) return withoutOld

  const oldCustom = customFolders.find((f) => f.id === categoryFolderId)
  return [
    ...withoutOld,
    {
      ...(oldCustom ?? {
        name: cat.cat,
        icon: 'fa-tag',
        color: 'text-slate-500',
      }),
      id: newCategoryFolderId,
      parent_id: targetDeptFolderId,
      name: cat.cat,
    },
  ]
}

/** 丢弃 id 与 parent_id 不一致的脏数据 */
export function sanitizeCustomFolders(folders: WorkflowFolder[]): WorkflowFolder[] {
  return folders.filter((f) => {
    if (f.id === ROOT_FOLDER_ID) return false
    const dept = deptNameFromId(f.id)
    if (dept) return f.parent_id === ROOT_FOLDER_ID
    const cat = catNamesFromId(f.id)
    if (cat) return f.parent_id === deptIdFromName(cat.dept)
    return false
  })
}

/** 根据当前选中的文件夹，决定右上角「新建…」按钮的文案与目标父节点 */
export function resolveCreateFolderAction(folderId: string): {
  kind: 'department' | 'category'
  label: string
  parentId: string | null
  visible: boolean
} {
  if (folderId === ROOT_FOLDER_ID) {
    return { kind: 'department', label: '新建服务', parentId: null, visible: true }
  }
  if (folderId.startsWith(DEPT_PREFIX)) {
    return { kind: 'category', label: '新建分类', parentId: folderId, visible: true }
  }
  const cat = catNamesFromId(folderId)
  if (cat) {
    return {
      kind: 'category',
      label: '新建分类',
      parentId: deptIdFromName(cat.dept),
      visible: true,
    }
  }
  return { kind: 'department', label: '新建服务', parentId: null, visible: false }
}

/** @deprecated 仅兼容旧版 localStorage 自定义文件夹 */
export function folderIdFromName(name: string): string {
  return `folder-${name}`
}

export function workflowFolderId(wf: WorkflowListItem): string {
  const { department, category } = resolveWorkflowTaxonomy(wf)
  return catIdFromNames(department || SHARED_DEPARTMENT_NAME, category || UNCATEGORIZED_FOLDER_NAME)
}

export function folderTaxonomyFromFolderId(folderId: string): {
  department: string
  category: string | null
} | null {
  if (folderId === ROOT_FOLDER_ID) return null
  if (folderId === UNCATEGORIZED_FOLDER_ID || folderId === sharedUncategorizedFolderId()) {
    return { department: SHARED_DEPARTMENT_NAME, category: UNCATEGORIZED_FOLDER_NAME }
  }
  const cat = catNamesFromId(folderId)
  if (cat) return { department: cat.dept, category: cat.cat }
  const dept = deptNameFromId(folderId)
  if (dept) return { department: dept, category: null }
  return null
}

export function categoryFromFolderId(folderId: string): string | undefined {
  const tax = folderTaxonomyFromFolderId(folderId)
  if (!tax) return undefined
  if (!tax.category) return tax.department
  return `${tax.department}/${tax.category}`
}

function presetForFolderName(name: string): { icon: string; color: string } {
  return FOLDER_NAME_PRESETS[name] ?? { icon: 'fa-folder', color: 'text-slate-500' }
}

function folderKey(f: WorkflowFolder): string {
  return `${f.parent_id ?? 'root'}::${f.id}`
}

/** 全部工作流 → 部门 → 分类 */
export function buildFolderTree(
  workflows: Pick<WorkflowListItem, 'department' | 'category'>[],
  customFolders: WorkflowFolder[],
): WorkflowFolder[] {
  const folders: WorkflowFolder[] = [
    {
      id: ROOT_FOLDER_ID,
      parent_id: null,
      name: '全部工作流',
      icon: 'fa-layer-group',
      color: 'text-slate-500',
    },
  ]

  const seen = new Set<string>([folderKey(folders[0])])
  const deptCats = new Map<string, Set<string>>()

  const ensureDept = (deptName: string) => {
    if (!deptCats.has(deptName)) deptCats.set(deptName, new Set())
  }

  for (const wf of workflows) {
    const { department, category } = resolveWorkflowTaxonomy(wf)
    if (!department) continue
    ensureDept(department)
    if (category) deptCats.get(department)!.add(category)
  }

  const addFolder = (f: WorkflowFolder) => {
    const key = folderKey(f)
    if (seen.has(key)) return
    folders.push(f)
    seen.add(key)
  }

  for (const cf of customFolders) {
    if (cf.id === ROOT_FOLDER_ID) continue
    addFolder(cf)
    const dept = deptNameFromId(cf.id)
    if (dept && cf.parent_id === ROOT_FOLDER_ID) ensureDept(dept)
    const cat = catNamesFromId(cf.id)
    if (cat && cf.parent_id === deptIdFromName(cat.dept)) {
      ensureDept(cat.dept)
      deptCats.get(cat.dept)!.add(cat.cat)
    }
  }

  ensureDept(SHARED_DEPARTMENT_NAME)
  for (const deptName of Array.from(deptCats.keys())) {
    deptCats.get(deptName)!.add(UNCATEGORIZED_FOLDER_NAME)
  }

  const deptNames = Array.from(deptCats.keys()).sort((a, b) => {
    if (a === SHARED_DEPARTMENT_NAME) return -1
    if (b === SHARED_DEPARTMENT_NAME) return 1
    return a.localeCompare(b, 'zh-Hans-CN')
  })

  for (const deptName of deptNames) {
    const deptId = deptIdFromName(deptName)
    addFolder({
      id: deptId,
      parent_id: ROOT_FOLDER_ID,
      name: deptName,
      ...presetForFolderName(deptName),
    })
    const cats = deptCats.get(deptName)!
    for (const catName of Array.from(cats).sort((a, b) => {
      if (a === UNCATEGORIZED_FOLDER_NAME) return -1
      if (b === UNCATEGORIZED_FOLDER_NAME) return 1
      return a.localeCompare(b, 'zh-Hans-CN')
    })) {
      addFolder({
        id: catIdFromNames(deptName, catName),
        parent_id: deptId,
        name: catName,
        ...(catName === UNCATEGORIZED_FOLDER_NAME
          ? presetForFolderName(UNCATEGORIZED_FOLDER_NAME)
          : { icon: 'fa-tag', color: 'text-slate-500' }),
      })
    }
  }

  return folders
}

export function getFolderChildren(folders: WorkflowFolder[], parentId: string | null) {
  return folders.filter((f) => f.parent_id === parentId)
}

export function getFolderPath(folders: WorkflowFolder[], folderId: string): WorkflowFolder[] {
  const path: WorkflowFolder[] = []
  let cur = folders.find((f) => f.id === folderId)
  while (cur) {
    path.unshift(cur)
    cur = cur.parent_id ? folders.find((f) => f.id === cur!.parent_id) : undefined
  }
  return path
}

function collectDescendantIds(folders: WorkflowFolder[], folderId: string): Set<string> {
  const ids = new Set<string>([folderId])
  const walk = (pid: string) => {
    for (const child of getFolderChildren(folders, pid)) {
      ids.add(child.id)
      walk(child.id)
    }
  }
  walk(folderId)
  return ids
}

export function workflowsInFolder(
  workflows: WorkflowListItem[],
  folders: WorkflowFolder[],
  folderId: string,
  deep?: boolean,
): WorkflowListItem[] {
  if (folderId === ROOT_FOLDER_ID) return workflows
  const useDeep = deep ?? folderId.startsWith(DEPT_PREFIX)
  const ids = useDeep ? collectDescendantIds(folders, folderId) : new Set([folderId])
  return workflows.filter((w) => ids.has(workflowFolderId(w)))
}

/** 当前文件夹所属的部门名（部门节点或分类节点）；根返回 null */
export function resolveContextDepartment(folderId: string): string | null {
  if (folderId === ROOT_FOLDER_ID) return null
  if (folderId === UNCATEGORIZED_FOLDER_ID || folderId === sharedUncategorizedFolderId()) {
    return SHARED_DEPARTMENT_NAME
  }
  const cat = catNamesFromId(folderId)
  if (cat) return cat.dept
  return deptNameFromId(folderId)
}

/** 跨文件夹搜索：当前部门 + 「共享」 */
export function workflowsInGlobalSearchScope(
  workflows: WorkflowListItem[],
  folderId: string,
): WorkflowListItem[] {
  const normalizedId =
    folderId === UNCATEGORIZED_FOLDER_ID ? sharedUncategorizedFolderId() : folderId
  const contextDept = resolveContextDepartment(normalizedId)
  const allowedDepts = new Set<string>([SHARED_DEPARTMENT_NAME])
  if (contextDept) allowedDepts.add(contextDept)

  return workflows.filter((w) => {
    const { department } = resolveWorkflowTaxonomy(w)
    return department != null && allowedDepts.has(department)
  })
}

export function countInFolder(
  workflows: WorkflowListItem[],
  folders: WorkflowFolder[],
  folderId: string,
): number {
  return workflowsInFolder(workflows, folders, folderId, true).length
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const then = d.getTime()
  const now = Date.now()
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24))
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days === 2) return '2天前'
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

export function filterAndSortWorkflows(
  workflows: WorkflowListItem[],
  folders: WorkflowFolder[],
  state: WorkflowListPageState,
): WorkflowListItem[] {
  let data = state.globalSearch
    ? workflowsInGlobalSearchScope(workflows, state.folderId)
    : workflowsInFolder(
        workflows,
        folders,
        state.folderId,
        state.folderId === ROOT_FOLDER_ID || state.folderId.startsWith(DEPT_PREFIX),
      )

  if (state.status === 'on') data = data.filter((w) => w.is_enabled)
  if (state.status === 'off') data = data.filter((w) => !w.is_enabled)
  if (state.trigs.size) data = data.filter((w) => state.trigs.has(w.trigger_type))
  if (state.author) {
    data = data.filter((w) => (w.created_by_name || '未知') === state.author)
  }
  if (state.search.trim()) {
    const q = state.search.toLowerCase()
    data = data.filter((w) => {
      const hay = `${w.name} ${w.slug} ${w.description || ''} ${w.department || ''} ${w.category || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }

  const sorted = [...data]
  if (state.sort === 'updated_at') {
    sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  } else if (state.sort === 'created_at') {
    sorted.sort((a, b) => b.created_at.localeCompare(a.created_at))
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }
  return sorted
}

export function uniqueAuthors(
  workflows: WorkflowListItem[],
  folders: WorkflowFolder[],
  folderId: string,
  globalSearch?: boolean,
): string[] {
  const scope = globalSearch
    ? workflowsInGlobalSearchScope(workflows, folderId)
    : folderId === ROOT_FOLDER_ID
      ? workflows
      : workflowsInFolder(workflows, folders, folderId, true)
  return Array.from(new Set(scope.map((w) => w.created_by_name || '未知'))).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'),
  )
}

export function defaultActiveFolderId(
  workflows: WorkflowListItem[],
  folders: WorkflowFolder[],
): string {
  const depts = folders.filter((f) => f.parent_id === ROOT_FOLDER_ID && f.id !== UNCATEGORIZED_FOLDER_ID)
  const shared = depts.find((f) => f.name === SHARED_DEPARTMENT_NAME)
  if (shared && countInFolder(workflows, folders, shared.id) > 0) return shared.id
  const withItems = depts.find((f) => countInFolder(workflows, folders, f.id) > 0)
  return withItems?.id ?? ROOT_FOLDER_ID
}

export function listDepartments(workflows: WorkflowListItem[]): string[] {
  const set = new Set<string>()
  for (const wf of workflows) {
    const { department } = resolveWorkflowTaxonomy(wf)
    if (department) set.add(department)
  }
  return Array.from(set).sort((a, b) => {
    if (a === SHARED_DEPARTMENT_NAME) return -1
    if (b === SHARED_DEPARTMENT_NAME) return 1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
}

export function listCategories(workflows: WorkflowListItem[], department: string): string[] {
  const set = new Set<string>()
  for (const wf of workflows) {
    const t = resolveWorkflowTaxonomy(wf)
    if (t.department === department && t.category) set.add(t.category)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** @deprecated */
export function listSubcategories(workflows: WorkflowListItem[], department: string): string[] {
  return listCategories(workflows, department)
}

/** 列表当前选中的文件夹（进入编辑器再返回时恢复） */
export function folderNavStorageKey(databaseId?: number | null) {
  return `onebase:workflow-list-folder:${databaseId ?? 'all'}`
}

export function loadSavedFolderId(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const id = sessionStorage.getItem(key)
    if (id === UNCATEGORIZED_FOLDER_ID) {
      return sharedUncategorizedFolderId()
    }
    return id
  } catch {
    return null
  }
}

export function saveSavedFolderId(key: string, folderId: string) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(key, folderId)
  } catch {
    /* ignore */
  }
}

export function expandFolderPath(
  folders: WorkflowFolder[],
  folderId: string,
  expanded: Set<string>,
): Set<string> {
  const next = new Set(expanded)
  for (const f of getFolderPath(folders, folderId)) {
    next.add(f.id)
  }
  return next
}

export function loadCustomFolders(key: string): WorkflowFolder[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveCustomFolders(key: string, folders: WorkflowFolder[]) {
  localStorage.setItem(key, JSON.stringify(folders))
}

export function normalizeListPerPage(value: unknown): WorkflowListPerPage | undefined {
  const n = Number(value)
  if (n === 10 || n === 20 || n === 50) return n
  // 旧调试选项 4 条/页 → 10
  if (n === 4) return 10
  return undefined
}

export function loadListPrefs(): Partial<Pick<WorkflowListPageState, 'sort' | 'view' | 'perPage' | 'expanded'>> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(LIST_PREFS_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as Record<string, unknown>
    const sort = resolveSavedSort(p)
    return {
      sort,
      view: p.view as WorkflowListView | undefined,
      perPage: normalizeListPerPage(p.perPage as number | undefined),
      expanded: p.expanded ? new Set(p.expanded as string[]) : undefined,
    }
  } catch {
    return {}
  }
}

/** v2 起才持久化排序；旧版默认的 updated_at 迁移为 created_at */
function resolveSavedSort(p: Record<string, unknown>): WorkflowListSort | undefined {
  const sort = p.sort as WorkflowListSort | undefined
  if (p.v === 2 && sort) return sort
  if (sort === 'name') return 'name'
  return undefined
}

export function saveListPrefs(state: Pick<WorkflowListPageState, 'sort' | 'view' | 'perPage' | 'expanded'>) {
  localStorage.setItem(
    LIST_PREFS_KEY,
    JSON.stringify({
      v: 2,
      sort: state.sort,
      view: state.view,
      perPage: state.perPage,
      expanded: Array.from(state.expanded),
    }),
  )
}

/** 侧边栏计数：由 summary API 的 department/category 聚合行计算 */
export interface WorkflowGroupCount {
  department: string | null
  category: string | null
  count: number
}

export function placementsFromSummaryGroups(
  groups: WorkflowGroupCount[],
): Pick<WorkflowListItem, 'department' | 'category'>[] {
  return groups.map((g) => ({
    department: g.department,
    category: g.category,
  }))
}

export function countInFolderFromGroups(
  groups: WorkflowGroupCount[],
  folderId: string,
): number {
  if (folderId === ROOT_FOLDER_ID) {
    return groups.reduce((sum, g) => sum + g.count, 0)
  }
  if (folderId === UNCATEGORIZED_FOLDER_ID || folderId === sharedUncategorizedFolderId()) {
    return groups
      .filter((g) => isUncategorizedPlacement({ department: g.department, category: g.category }, SHARED_DEPARTMENT_NAME))
      .reduce((sum, g) => sum + g.count, 0)
  }
  const cat = catNamesFromId(folderId)
  if (cat?.cat === UNCATEGORIZED_FOLDER_NAME) {
    return groups
      .filter((g) => isUncategorizedPlacement({ department: g.department, category: g.category }, cat.dept))
      .reduce((sum, g) => sum + g.count, 0)
  }
  const dept = deptNameFromId(folderId)
  if (dept) {
    return groups.filter((g) => g.department === dept).reduce((sum, g) => sum + g.count, 0)
  }
  if (cat) {
    return groups.find((g) => g.department === cat.dept && g.category === cat.cat)?.count ?? 0
  }
  return 0
}

export function categoryWorkflowCountFromGroups(
  groups: WorkflowGroupCount[],
  dept: string,
  cat: string,
): number {
  return groups.find((g) => g.department === dept && g.category === cat)?.count ?? 0
}

export function categoryExistsInDeptFromGroups(
  groups: WorkflowGroupCount[],
  customFolders: WorkflowFolder[],
  deptName: string,
  categoryName: string,
  excludeCategoryFolderId?: string,
): boolean {
  const targetCatId = catIdFromNames(deptName, categoryName)
  if (excludeCategoryFolderId && excludeCategoryFolderId === targetCatId) return false

  if (
    groups.some(
      (g) => g.department === deptName && g.category === categoryName && g.count > 0,
    )
  ) {
    return true
  }

  return customFolders.some((f) => f.id === targetCatId)
}

export function defaultActiveFolderIdFromGroups(
  groups: WorkflowGroupCount[],
  folders: WorkflowFolder[],
): string {
  const depts = folders.filter((f) => f.parent_id === ROOT_FOLDER_ID && f.id !== UNCATEGORIZED_FOLDER_ID)
  const shared = depts.find((f) => f.name === SHARED_DEPARTMENT_NAME)
  if (shared && countInFolderFromGroups(groups, shared.id) > 0) return shared.id
  const withItems = depts.find((f) => countInFolderFromGroups(groups, f.id) > 0)
  return withItems?.id ?? ROOT_FOLDER_ID
}

export function listDepartmentsFromGroups(groups: WorkflowGroupCount[]): string[] {
  const set = new Set<string>()
  for (const g of groups) {
    if (g.department) set.add(g.department)
  }
  return Array.from(set).sort((a, b) => {
    if (a === SHARED_DEPARTMENT_NAME) return -1
    if (b === SHARED_DEPARTMENT_NAME) return 1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
}

export function listCategoriesFromGroups(
  groups: WorkflowGroupCount[],
  department: string,
): string[] {
  const set = new Set<string>()
  for (const g of groups) {
    if (g.department === department && g.category) set.add(g.category)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** 编辑器部门下拉：工作流聚合 + 空文件夹占位 + 当前值 */
export function editorDepartmentOptions(
  groups: WorkflowGroupCount[],
  folders: { name: string; parent_id: number | null }[],
  currentDept: string,
): string[] {
  const set = new Set(listDepartmentsFromGroups(groups))
  for (const f of folders) {
    if (f.parent_id === null) set.add(f.name)
  }
  const d = currentDept.trim()
  if (d) set.add(d)
  return Array.from(set).sort((a, b) => {
    if (a === SHARED_DEPARTMENT_NAME) return -1
    if (b === SHARED_DEPARTMENT_NAME) return 1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
}

/** 编辑器分类下拉：当前部门下的工作流 + 空文件夹 + 当前值 */
export function editorCategoryOptions(
  groups: WorkflowGroupCount[],
  folders: { id: number; name: string; parent_id: number | null }[],
  department: string,
  currentCat: string,
): string[] {
  const dept = department.trim()
  if (!dept) return []
  const set = new Set(listCategoriesFromGroups(groups, dept))
  set.add(UNCATEGORIZED_FOLDER_NAME)
  const deptFolder = folders.find((f) => f.parent_id === null && f.name === dept)
  if (deptFolder) {
    for (const f of folders) {
      if (f.parent_id === deptFolder.id) set.add(f.name)
    }
  }
  const c = currentCat.trim()
  if (c) set.add(c)
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}
