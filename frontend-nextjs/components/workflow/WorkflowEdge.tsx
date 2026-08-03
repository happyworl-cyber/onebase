'use client'

import { BaseEdge, EdgeLabelRenderer, EdgeProps } from 'reactflow'
import { branchColor } from './workflowLayout'

function edgeColor(sourceHandle?: string | null) {
  return branchColor(sourceHandle)
}

function sBezier(sx: number, sy: number, tx: number, ty: number): string {
  const vc = Math.max(60, Math.abs(ty - sy) * 0.55)
  return `M ${sx} ${sy} C ${sx} ${sy + vc}, ${tx} ${ty - vc}, ${tx} ${ty}`
}

function loopBackPath(sx: number, sy: number, tx: number, ty: number) {
  // 回边入口固定在 loop 左侧：循环体底部先向下，再从整组节点左侧绕行，
  // 最后水平接入，避免与 body/done 正向边交叉。
  const outsideX = Math.min(sx, tx) - 72
  const sourceTurnY = sy + 36
  const radius = 12

  return {
    path: [
      `M ${sx} ${sy}`,
      `L ${sx} ${sourceTurnY - radius}`,
      `Q ${sx} ${sourceTurnY} ${sx - radius} ${sourceTurnY}`,
      `L ${outsideX + radius} ${sourceTurnY}`,
      `Q ${outsideX} ${sourceTurnY} ${outsideX} ${sourceTurnY - radius}`,
      `L ${outsideX} ${ty + radius}`,
      `Q ${outsideX} ${ty} ${outsideX + radius} ${ty}`,
      `L ${tx} ${ty}`,
    ].join(' '),
    label: { x: outsideX, y: (sourceTurnY + ty) / 2 },
  }
}

function labelPoint(sx: number, sy: number, tx: number, ty: number, t = 0.28) {
  const vc = Math.max(60, Math.abs(ty - sy) * 0.55)
  const cp1x = sx
  const cp1y = sy + vc
  const cp2x = tx
  const cp2y = ty - vc
  const u = 1 - t
  return {
    x: u ** 3 * sx + 3 * u ** 2 * t * cp1x + 3 * u * t ** 2 * cp2x + t ** 3 * tx,
    y: u ** 3 * sy + 3 * u ** 2 * t * cp1y + 3 * u * t ** 2 * cp2y + t ** 3 * ty,
  }
}

export default function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourceHandleId,
  label,
  markerEnd,
  selected,
  data,
}: EdgeProps) {
  const isLoopBack = (data as any)?.edgeType === 'loop_back'
  const isLoopSource = (data as any)?.sourceNodeType === 'loop'
  const color = isLoopBack ? '#d946ef' : edgeColor(sourceHandleId)
  const loopBack = isLoopBack
    ? loopBackPath(sourceX, sourceY, targetX, targetY)
    : null
  const path = loopBack?.path ?? sBezier(sourceX, sourceY, targetX, targetY)
  const labelText = isLoopBack
    ? '回边'
    : isLoopSource && sourceHandleId === 'body'
      ? '循环体'
      : isLoopSource && sourceHandleId === 'done'
        ? '完成'
        : typeof label === 'string'
          ? label
          : null
  const lp = labelText
    ? loopBack?.label ?? labelPoint(sourceX, sourceY, targetX, targetY, 0.22)
    : null

  return (
    <>
      <BaseEdge
        id={`${id}-glow`}
        path={path}
        style={{ stroke: color, strokeWidth: 6, strokeOpacity: 0.06 }}
      />
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth: selected ? 2.5 : 2,
          strokeDasharray: isLoopBack ? '8 6' : 'none',
          animation: isLoopBack
            ? 'workflow-edge-flow 1.1s linear infinite'
            : undefined,
        }}
      />
      {labelText && lp && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute"
            style={{ transform: `translate(-50%, -50%) translate(${lp.x}px, ${lp.y}px)` }}
          >
            <span
              className="inline-block rounded-md px-1.5 py-1 text-[10px] font-semibold leading-none shadow-sm"
              style={{
                color,
                background: '#fff',
                border: `1px solid ${color}66`,
              }}
            >
              {isLoopBack ? `↺ ${labelText}` : labelText}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
