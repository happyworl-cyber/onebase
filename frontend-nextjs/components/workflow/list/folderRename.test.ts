import assert from 'node:assert/strict'
import {
  applyCustomFoldersRename,
  canRenameFolder,
  catIdFromNames,
  deptIdFromName,
  remapExpandedAfterRename,
  remapFolderIdAfterDeptRename,
  renamedFolderId,
  siblingFolderNames,
  validateFolderRename,
} from './utils'
import { ROOT_FOLDER_ID, SHARED_DEPARTMENT_NAME, UNCATEGORIZED_FOLDER_NAME, type WorkflowFolder } from './types'

const DEPT = 'gm管理后台预发'
const deptId = deptIdFromName(DEPT)
const catId = catIdFromNames(DEPT, '透明研发')
const uncatId = catIdFromNames(DEPT, UNCATEGORIZED_FOLDER_NAME)
const sharedId = deptIdFromName(SHARED_DEPARTMENT_NAME)

assert.equal(canRenameFolder(ROOT_FOLDER_ID), false)
assert.equal(canRenameFolder(sharedId), false)
assert.equal(canRenameFolder(uncatId), false)
assert.equal(canRenameFolder(deptId), true)
assert.equal(canRenameFolder(catId), true)

assert.equal(validateFolderRename('', [], DEPT), '文件夹名称不能为空')
assert.equal(validateFolderRename('a/b', [], DEPT), "文件夹名称不能包含 '/'")
assert.equal(validateFolderRename('测'.repeat(65), [], DEPT), '文件夹名称不能超过 64 个字符')
assert.equal(validateFolderRename(SHARED_DEPARTMENT_NAME, [], DEPT), `不能使用保留名称「${SHARED_DEPARTMENT_NAME}」`)
assert.equal(validateFolderRename(UNCATEGORIZED_FOLDER_NAME, [], DEPT), `不能使用保留名称「${UNCATEGORIZED_FOLDER_NAME}」`)
assert.equal(validateFolderRename('已有', ['已有'], DEPT), '文件夹「已有」已存在')
assert.equal(validateFolderRename(DEPT, ['其它'], DEPT), null)
assert.equal(validateFolderRename('新服务', ['其它'], DEPT), null)

assert.equal(renamedFolderId(deptId, '新服务'), deptIdFromName('新服务'))
assert.equal(renamedFolderId(catId, '新分类'), catIdFromNames(DEPT, '新分类'))
assert.equal(renamedFolderId(ROOT_FOLDER_ID, 'x'), null)

assert.equal(remapFolderIdAfterDeptRename(deptId, DEPT, '新服务'), deptIdFromName('新服务'))
assert.equal(
  remapFolderIdAfterDeptRename(catId, DEPT, '新服务'),
  catIdFromNames('新服务', '透明研发'),
)
assert.equal(remapFolderIdAfterDeptRename(deptIdFromName('其它'), DEPT, '新服务'), deptIdFromName('其它'))

const expanded = remapExpandedAfterRename(new Set([deptId, catId, ROOT_FOLDER_ID]), deptId, '新服务')
assert.ok(expanded.has(deptIdFromName('新服务')))
assert.ok(expanded.has(catIdFromNames('新服务', '透明研发')))
assert.ok(expanded.has(ROOT_FOLDER_ID))
assert.ok(!expanded.has(deptId))
assert.ok(!expanded.has(catId))

const folders: WorkflowFolder[] = [
  { id: deptId, parent_id: ROOT_FOLDER_ID, name: DEPT, icon: 'fa-folder', color: 'text-slate-500' },
  { id: catId, parent_id: deptId, name: '透明研发', icon: 'fa-tag', color: 'text-slate-500' },
  { id: deptIdFromName('其它'), parent_id: ROOT_FOLDER_ID, name: '其它', icon: 'fa-folder', color: 'text-slate-500' },
]
assert.deepEqual(siblingFolderNames(folders, deptId).sort(), ['其它'])
assert.deepEqual(siblingFolderNames(folders, catId), [])

const renamedDept = applyCustomFoldersRename(folders, deptId, '新服务')
assert.ok(renamedDept.some((f) => f.id === deptIdFromName('新服务') && f.name === '新服务'))
assert.ok(renamedDept.some((f) => f.id === catIdFromNames('新服务', '透明研发') && f.parent_id === deptIdFromName('新服务')))
assert.ok(!renamedDept.some((f) => f.id === deptId))

const renamedCat = applyCustomFoldersRename(folders, catId, '新分类')
assert.ok(renamedCat.some((f) => f.id === catIdFromNames(DEPT, '新分类') && f.name === '新分类'))
assert.ok(!renamedCat.some((f) => f.id === catId))

console.log('folderRename tests passed')
