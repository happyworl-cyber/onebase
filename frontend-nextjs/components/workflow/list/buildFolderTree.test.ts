import assert from 'node:assert/strict'
import { buildFolderTree, catIdFromNames, deptIdFromName } from './utils'
import { ROOT_FOLDER_ID, UNCATEGORIZED_FOLDER_NAME, type WorkflowFolder } from './types'

const DEPT = '主机权限管理'
const deptFolder: WorkflowFolder = {
  id: deptIdFromName(DEPT),
  parent_id: ROOT_FOLDER_ID,
  name: DEPT,
  icon: 'fa-folder',
  color: 'text-slate-500',
  server_id: 1,
}

function ids(folders: WorkflowFolder[]): string[] {
  return folders.map((f) => f.id)
}

{
  const tree = buildFolderTree([], [deptFolder])
  assert.ok(ids(tree).includes(deptFolder.id), 'empty dept folder still appears')
  assert.ok(
    !ids(tree).includes(catIdFromNames(DEPT, UNCATEGORIZED_FOLDER_NAME)),
    'empty 未分类 must not be forced back after delete',
  )
}

{
  const tree = buildFolderTree([{ department: DEPT, category: UNCATEGORIZED_FOLDER_NAME }], [deptFolder])
  assert.ok(
    ids(tree).includes(catIdFromNames(DEPT, UNCATEGORIZED_FOLDER_NAME)),
    '未分类 appears when the dept has uncategorized workflows',
  )
}

{
  const uncategorizedFolder: WorkflowFolder = {
    id: catIdFromNames(DEPT, UNCATEGORIZED_FOLDER_NAME),
    parent_id: deptFolder.id,
    name: UNCATEGORIZED_FOLDER_NAME,
    icon: 'fa-inbox',
    color: 'text-slate-400',
    server_id: 2,
  }
  const tree = buildFolderTree([], [deptFolder, uncategorizedFolder])
  assert.ok(
    ids(tree).includes(uncategorizedFolder.id),
    'explicit empty 未分类 folder still appears until deleted',
  )
}

console.log('buildFolderTree tests passed')
