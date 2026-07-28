'use client'

import { useCallback, useRef, useState } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Connection,
  Edge,
  Node,
  addEdge,
  useNodesState,
  useEdgesState,
  Panel,
  ReactFlowInstance,
  MarkerType,
} from 'reactflow'
import { nodeTypes, NODE_TYPE_META } from './NodeTypes'
import NodeConfigPanel from './NodeConfigPanel'

export interface WorkflowNodeDef {
  id: string
  type: string
  label?: string
  config: any
}

export interface WorkflowEdgeDef {
  from: string
  to: string
  branch?: string
}

interface Props {
  initialNodes: WorkflowNodeDef[]
  initialEdges: WorkflowEdgeDef[]
  onChange: (nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]) => void
}

let nodeIdCounter = 0

function generateNodeId(type: string) {
  nodeIdCounter++
  return `${type}_${Date.now().toString(36)}_${nodeIdCounter}`
}

function toFlowNodes(defs: WorkflowNodeDef[]): Node[] {
  return defs.map((n, i) => ({
    id: n.id,
    type: 'workflowNode',
    position: n.config?._position || { x: 250 + (i % 3) * 220, y: 80 + Math.floor(i / 3) * 150 },
    data: { ...n, nodeType: n.type },
  }))
}

function toFlowEdges(defs: WorkflowEdgeDef[]): Edge[] {
  return defs.map((e, i) => ({
    id: `e-${e.from}-${e.to}-${i}`,
    source: e.from,
    target: e.to,
    sourceHandle: e.branch || null,
    animated: true,
    label: e.branch || undefined,
    style: { stroke: e.branch === 'false' ? '#f87171' : e.branch === 'true' ? '#4ade80' : '#94a3b8', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.branch === 'false' ? '#f87171' : e.branch === 'true' ? '#4ade80' : '#94a3b8' },
  }))
}

function fromFlowNodes(nodes: Node[]): WorkflowNodeDef[] {
  return nodes.map(n => ({
    id: n.id,
    type: n.data.nodeType,
    label: n.data.label,
    config: { ...n.data.config, _position: n.position },
  }))
}

function fromFlowEdges(edges: Edge[]): WorkflowEdgeDef[] {
  return edges.map(e => ({
    from: e.source,
    to: e.target,
    ...(e.sourceHandle ? { branch: e.sourceHandle } : {}),
  }))
}

export default function WorkflowCanvas({ initialNodes, initialEdges, onChange }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(initialNodes))
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(initialEdges))
  const [selectedNode, setSelectedNode] = useState<WorkflowNodeDef | null>(null)
  const [showPalette, setShowPalette] = useState(false)
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null)

  const syncChange = useCallback((newNodes: Node[], newEdges: Edge[]) => {
    onChange(fromFlowNodes(newNodes), fromFlowEdges(newEdges))
  }, [onChange])

  const onConnect = useCallback((params: Connection) => {
    setEdges(eds => {
      const newEdges = addEdge({
        ...params,
        animated: true,
        style: { stroke: params.sourceHandle === 'false' ? '#f87171' : params.sourceHandle === 'true' ? '#4ade80' : '#94a3b8', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: params.sourceHandle === 'false' ? '#f87171' : params.sourceHandle === 'true' ? '#4ade80' : '#94a3b8' },
        label: params.sourceHandle || undefined,
      }, eds)
      setTimeout(() => syncChange(nodes, newEdges), 0)
      return newEdges
    })
  }, [nodes, setEdges, syncChange])

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNode({
      id: node.id,
      type: node.data.nodeType,
      label: node.data.label,
      config: node.data.config,
    })
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [])

  const handleNodeConfigChange = useCallback((updated: WorkflowNodeDef) => {
    setNodes(nds => {
      const newNodes = nds.map(n =>
        n.id === updated.id
          ? { ...n, data: { ...updated, nodeType: updated.type } }
          : n
      )
      syncChange(newNodes, edges)
      return newNodes
    })
    setSelectedNode(updated)
  }, [edges, setNodes, syncChange])

  const handleNodeDelete = useCallback(() => {
    if (!selectedNode) return
    setNodes(nds => {
      const newNodes = nds.filter(n => n.id !== selectedNode.id)
      setEdges(eds => {
        const newEdges = eds.filter(e => e.source !== selectedNode.id && e.target !== selectedNode.id)
        setTimeout(() => syncChange(newNodes, newEdges), 0)
        return newEdges
      })
      return newNodes
    })
    setSelectedNode(null)
  }, [selectedNode, setNodes, setEdges, syncChange])

  const addNode = useCallback((type: string) => {
    const id = generateNodeId(type)
    const center = reactFlowInstance.current?.getViewport()
    const position = {
      x: 250 + Math.random() * 100,
      y: 150 + nodes.length * 80 + Math.random() * 50,
    }
    const newNode: Node = {
      id,
      type: 'workflowNode',
      position,
      data: { id, nodeType: type, label: '', config: getDefaultConfig(type) },
    }
    setNodes(nds => {
      const newNodes = [...nds, newNode]
      syncChange(newNodes, edges)
      return newNodes
    })
    setShowPalette(false)
    setSelectedNode({ id, type, label: '', config: getDefaultConfig(type) })
  }, [nodes, edges, setNodes, syncChange])

  const onNodesChangeWrapper = useCallback((changes: any) => {
    onNodesChange(changes)
    setTimeout(() => {
      setNodes(nds => {
        syncChange(nds, edges)
        return nds
      })
    }, 0)
  }, [onNodesChange, setNodes, edges, syncChange])

  const onEdgesChangeWrapper = useCallback((changes: any) => {
    onEdgesChange(changes)
    setTimeout(() => {
      setEdges(eds => {
        syncChange(nodes, eds)
        return eds
      })
    }, 0)
  }, [onEdgesChange, setEdges, nodes, syncChange])

  return (
    <div className="flex h-full">
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChangeWrapper}
          onEdgesChange={onEdgesChangeWrapper}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onInit={(instance) => { reactFlowInstance.current = instance }}
          nodeTypes={nodeTypes}
          fitView
          snapToGrid
          snapGrid={[16, 16]}
          deleteKeyCode={['Backspace', 'Delete']}
          className="bg-gray-50"
        >
          <Background gap={16} size={1} color="#e2e8f0" />
          <Controls position="bottom-left" />
          <MiniMap
            nodeColor={() => '#818cf8'}
            maskColor="rgba(0,0,0,0.08)"
            className="!bg-white !border !border-gray-200 !rounded-lg !shadow-sm"
          />
          <Panel position="top-left">
            <div className="relative">
              <button
                onClick={() => setShowPalette(!showPalette)}
                className="px-4 py-2 bg-white border border-gray-200 rounded-lg shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
              >
                <span className="text-lg leading-none">+</span> 添加节点
              </button>
              {showPalette && (
                <div className="absolute top-full left-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-lg p-2 w-[200px] z-50">
                  {Object.entries(NODE_TYPE_META).map(([type, meta]) => (
                    <button
                      key={type}
                      onClick={() => addNode(type)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 flex items-center gap-2 transition-colors"
                    >
                      <span className="text-base">{meta.icon}</span>
                      <span className="text-sm text-gray-700">{meta.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Panel>
        </ReactFlow>
      </div>

      {selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          onChange={handleNodeConfigChange}
          onClose={() => setSelectedNode(null)}
          onDelete={handleNodeDelete}
        />
      )}
    </div>
  )
}

function getDefaultConfig(type: string): any {
  switch (type) {
    case 'code':
      return { code: 'function execute(ctx)\n  ctx.body = { ok = true }\nend' }
    case 'db_query':
      return { sql: '', params: '' }
    case 'db_execute':
      return { sql: '', params: '' }
    case 'http_call':
      return { method: 'GET', url: '', headers: '', body: '' }
    case 'condition':
      return { expression: '' }
    case 'transform':
      return { mapping: '' }
    case 'response':
      return { status_code: 200, body: '', headers: '' }
    default:
      return {}
  }
}
