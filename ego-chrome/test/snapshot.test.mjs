import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSemanticSnapshot } from '../extension/snapshot.js'

const ax = {
  nodes: [
    {
      nodeId: '1',
      role: { value: 'RootWebArea' },
      name: { value: 'Example account' },
      properties: [{ name: 'url', value: { value: 'https://example.com/account' } }],
      childIds: ['2', '3', '4'],
    },
    {
      nodeId: '2', parentId: '1', backendDOMNodeId: 10,
      role: { value: 'heading' }, name: { value: 'Account' },
      properties: [{ name: 'level', value: { value: 1 } }],
    },
    {
      nodeId: '3', parentId: '1', backendDOMNodeId: 11,
      role: { value: 'textbox' }, name: { value: 'Display name' }, value: { value: 'Alice' },
      properties: [{ name: 'required', value: { value: true } }],
    },
    {
      nodeId: '4', parentId: '1', backendDOMNodeId: 12,
      role: { value: 'button' }, name: { value: 'Save' },
      properties: [],
    },
  ],
}

const dom = {
  strings: ['DIV', 'aria-label', 'Open advanced settings'],
  documents: [{
    nodes: {
      backendNodeId: [20],
      nodeName: [0],
      attributes: [[1, 2]],
      isClickable: { index: [0] },
    },
  }],
}

test('semantic snapshot produces compact refs without images', () => {
  const result = buildSemanticSnapshot(ax, dom, { maxChars: 12000 })
  assert.match(result.content, /page "Example account" url="https:\/\/example.com\/account"/)
  assert.match(result.content, /heading "Account" \[level=1\]/)
  assert.match(result.content, /@1 textbox "Display name" \[value="Alice"\] \[required\]/)
  assert.match(result.content, /@2 button "Save"/)
  assert.match(result.content, /@3 clickable "Open advanced settings" \[dom-fallback\]/)
  assert.deepEqual(result.refs.map((ref) => ref.backendNodeId), [11, 12, 20])
})

test('snapshot respects character budget', () => {
  const result = buildSemanticSnapshot(ax, dom, { maxChars: 1000 })
  assert.ok(result.content.length <= 1000)
})
