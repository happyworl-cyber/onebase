'use client'

import { useCallback, useEffect, useState, useMemo } from 'react'
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Panel,
  Handle,
  Position,
} from 'reactflow'

interface Column {
  column_name: string
  data_type: string
  is_nullable: string
  is_primary_key?: boolean
}

interface TableNode {
  table_name: string
  columns: Column[]
}

interface ForeignKey {
  constraint_name: string
  table_name: string
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
}

interface ERDiagramProps {
  tables: TableNode[]
  foreignKeys: ForeignKey[]
}

// 自定义表节点组件
function TableNodeComponent({ data }: { data: TableNode }) {
  return (
    <div className="bg-white border-2 border-gray-300 rounded-lg shadow-md min-w-[250px] relative">
      {/* 连接点 - 四个方向都可以连接 */}
      <Handle type="target" position={Position.Top} className="w-3 h-3 !bg-blue-500" />
      <Handle type="target" position={Position.Left} className="w-3 h-3 !bg-blue-500" />
      <Handle type="source" position={Position.Bottom} className="w-3 h-3 !bg-blue-500" />
      <Handle type="source" position={Position.Right} className="w-3 h-3 !bg-blue-500" />
      
      {/* 表头 */}
      <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-4 py-2 rounded-t-lg">
        <div className="flex items-center space-x-2">
          <i className="fas fa-table text-sm"></i>
          <h3 className="font-semibold text-sm">{data.table_name}</h3>
        </div>
      </div>

      {/* 列列表 */}
      <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
        {data.columns.slice(0, 10).map((col, idx) => (
          <div
            key={idx}
            className="px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 flex-1 min-w-0">
                {col.is_primary_key && (
                  <i className="fas fa-key text-yellow-500 text-xs flex-shrink-0" title="主键"></i>
                )}
                <span className="text-xs font-mono text-gray-900 truncate">
                  {col.column_name}
                </span>
              </div>
              <span className="text-[10px] text-gray-500 ml-2 flex-shrink-0">
                {col.data_type}
              </span>
            </div>
          </div>
        ))}
        {data.columns.length > 10 && (
          <div className="px-3 py-1.5 text-center text-xs text-gray-400">
            ... 还有 {data.columns.length - 10} 个字段
          </div>
        )}
      </div>
    </div>
  )
}

export default function ERDiagram({ tables, foreignKeys }: ERDiagramProps) {
  // 使用 useMemo 避免每次渲染都创建新的 nodeTypes 对象
  const nodeTypes = useMemo(() => ({
    tableNode: TableNodeComponent,
  }), [])
  
  // Memoize defaultEdgeOptions 避免 React Flow 警告
  const defaultEdgeOptions = useMemo(() => ({
    type: 'smoothstep' as const,
    animated: true,
    style: { stroke: '#3b82f6', strokeWidth: 2 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: '#3b82f6',
    },
  }), [])
  
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [layoutType, setLayoutType] = useState<'grid' | 'circular' | 'hierarchical'>('grid')

  // 生成节点和边
  useEffect(() => {
    if (!tables || tables.length === 0) return

    // 创建节点
    const newNodes: Node[] = tables.map((table, index) => {
      const position = calculatePosition(index, tables.length, layoutType)
      return {
        id: table.table_name,
        type: 'tableNode',
        position,
        data: table,
      }
    })

    // 创建边（表关系）
    const newEdges: Edge[] = foreignKeys.map((fk, index) => ({
      id: `${fk.table_name}-${fk.foreign_table_name}-${index}`,
      source: fk.table_name,
      target: fk.foreign_table_name,
      type: 'smoothstep',
      animated: true,
      label: `${fk.column_name} → ${fk.foreign_column_name}`,
      labelStyle: { fontSize: 10, fill: '#6b7280', fontWeight: 500 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
      style: { 
        stroke: '#3b82f6', 
        strokeWidth: 2.5,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: '#3b82f6',
        width: 25,
        height: 25,
      },
    }))

    console.log(`✅ ER 图已更新: ${tables.length} 张表, ${foreignKeys.length} 个外键关系`)

    setNodes(newNodes)
    setEdges(newEdges)
  }, [tables, foreignKeys, layoutType])

  // 计算节点位置
  const calculatePosition = (
    index: number,
    total: number,
    layout: 'grid' | 'circular' | 'hierarchical'
  ) => {
    const nodeWidth = 280
    const nodeHeight = 300
    const padding = 50

    if (layout === 'grid') {
      const cols = Math.ceil(Math.sqrt(total))
      const col = index % cols
      const row = Math.floor(index / cols)
      return {
        x: col * (nodeWidth + padding),
        y: row * (nodeHeight + padding),
      }
    } else if (layout === 'circular') {
      const radius = Math.max(300, total * 50)
      const angle = (index / total) * 2 * Math.PI
      return {
        x: radius + radius * Math.cos(angle),
        y: radius + radius * Math.sin(angle),
      }
    } else {
      // hierarchical
      const level = Math.floor(index / 3)
      const posInLevel = index % 3
      return {
        x: posInLevel * (nodeWidth + padding),
        y: level * (nodeHeight + padding),
      }
    }
  }

  const handleLayoutChange = (type: 'grid' | 'circular' | 'hierarchical') => {
    setLayoutType(type)
  }

  return (
    <div className="h-[calc(100vh-200px)] w-full border border-gray-200 rounded-lg bg-gray-50">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
      >
        <Background color="#e5e7eb" gap={16} />
        <Controls />
        
        {/* 布局切换面板 */}
        <Panel position="top-right" className="bg-white rounded-lg shadow-lg p-2 space-y-1">
          <div className="text-xs font-semibold text-gray-700 px-2 py-1">布局</div>
          <button
            onClick={() => handleLayoutChange('grid')}
            className={`w-full px-3 py-1.5 text-xs rounded transition-colors ${
              layoutType === 'grid'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <i className="fas fa-th mr-2"></i>网格
          </button>
          <button
            onClick={() => handleLayoutChange('circular')}
            className={`w-full px-3 py-1.5 text-xs rounded transition-colors ${
              layoutType === 'circular'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <i className="fas fa-circle-notch mr-2"></i>环形
          </button>
          <button
            onClick={() => handleLayoutChange('hierarchical')}
            className={`w-full px-3 py-1.5 text-xs rounded transition-colors ${
              layoutType === 'hierarchical'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <i className="fas fa-sitemap mr-2"></i>层级
          </button>
        </Panel>

        {/* 信息面板 */}
        <Panel position="top-left" className="bg-white rounded-lg shadow-lg p-3">
          <div className="space-y-2">
            <div className="flex items-center space-x-2 text-xs">
              <i className="fas fa-table text-blue-500"></i>
              <span className="text-gray-700">
                {tables.length} 张表
              </span>
            </div>
            <div className="flex items-center space-x-2 text-xs">
              <i className="fas fa-link text-green-500"></i>
              <span className="text-gray-700">
                {foreignKeys.length} 个关系
              </span>
            </div>
            {foreignKeys.length === 0 && tables.length > 0 && (
              <div className="mt-3 pt-2 border-t border-gray-200">
                <div className="text-xs text-amber-600 flex items-start space-x-1">
                  <i className="fas fa-info-circle mt-0.5 flex-shrink-0"></i>
                  <span>未检测到外键约束</span>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  )
}

