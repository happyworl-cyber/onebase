import assert from 'node:assert/strict'
import {
  breadcrumbParts,
  fileDisplayName,
  folderDisplayName,
  isGetTooLargeError,
  lastConnectionStorageKey,
  parentPrefix,
  previewLanguageFromKey,
} from './objectStorageFiles'

assert.equal(previewLanguageFromKey('configs/app.xml'), 'xml')
assert.equal(previewLanguageFromKey('a/b.xsd'), 'xml')
assert.equal(previewLanguageFromKey('sheet.xslt'), 'xml')
assert.equal(previewLanguageFromKey('icon.svg'), 'xml')
assert.equal(previewLanguageFromKey('data.json'), 'json')
assert.equal(previewLanguageFromKey('readme.md'), 'text')
assert.equal(previewLanguageFromKey('noext'), 'text')

assert.equal(fileDisplayName('configs/a/b.xml', 'configs/'), 'a/b.xml')
assert.equal(fileDisplayName('configs/a/b.xml', 'configs/a/'), 'b.xml')
assert.equal(fileDisplayName('b.xml', ''), 'b.xml')

assert.equal(parentPrefix(''), '')
assert.equal(parentPrefix('configs/'), '')
assert.equal(parentPrefix('configs/a/'), 'configs/')
assert.equal(parentPrefix('configs/a'), 'configs/')

assert.deepEqual(breadcrumbParts(''), [])
assert.deepEqual(breadcrumbParts('configs/a/'), [
  { label: 'configs', prefix: 'configs/' },
  { label: 'a', prefix: 'configs/a/' },
])

assert.equal(folderDisplayName('configs/a/', 'configs/'), 'a')
assert.equal(folderDisplayName('configs/', ''), 'configs')

assert.equal(isGetTooLargeError('对象超过 5242880 字节，请改用 presign 下载'), true)
assert.equal(isGetTooLargeError('对象不存在'), false)

assert.equal(lastConnectionStorageKey(42), 'planeos.files.connection.42')

console.log('objectStorageFiles tests passed')
