import assert from 'node:assert/strict'
import { buildListQueryParams } from './listApi'
import {
  DEFAULT_LIST_PER_PAGE,
  DEFAULT_LIST_SORT,
  ROOT_FOLDER_ID,
  type WorkflowListPageState,
} from './types'

function baseState(over: Partial<WorkflowListPageState> = {}): WorkflowListPageState {
  return {
    folderId: ROOT_FOLDER_ID,
    expanded: new Set([ROOT_FOLDER_ID]),
    status: 'all',
    trigs: new Set(),
    author: null,
    updater: null,
    sort: DEFAULT_LIST_SORT,
    view: 'compact',
    search: '',
    globalSearch: false,
    page: 1,
    perPage: DEFAULT_LIST_PER_PAGE,
    ...over,
  }
}

{
  const params = buildListQueryParams(baseState())
  assert.equal(params.include_authors, '1')
  assert.equal(params.include_updaters, '1')
  assert.equal('updater' in params, false)
  assert.equal('author' in params, false)
}

{
  const params = buildListQueryParams(baseState({ updater: '宗心', author: '李四' }))
  assert.equal(params.updater, '宗心')
  assert.equal(params.author, '李四')
}

console.log('listApi tests passed')
