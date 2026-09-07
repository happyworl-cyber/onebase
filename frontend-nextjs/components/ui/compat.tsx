'use client'

import React, { createContext, useContext } from 'react'

const cx = (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' ')

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-lg border border-gray-200 bg-white shadow-sm', className)} {...props} />
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('space-y-1.5 p-6 pb-3', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cx('text-lg font-semibold text-gray-900', className)} {...props} />
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx('text-sm text-gray-500', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('p-6 pt-3', className)} {...props} />
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'destructive' | 'secondary'
  size?: 'default' | 'sm'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
        variant === 'default' && 'bg-indigo-600 text-white hover:bg-indigo-700',
        variant === 'outline' && 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
        variant === 'destructive' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'secondary' && 'bg-gray-100 text-gray-800 hover:bg-gray-200',
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cx(
        'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx('text-sm font-medium text-gray-700', className)} {...props} />
}

type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  onCheckedChange?: (checked: boolean) => void
}

export function Checkbox({ className, onCheckedChange, ...props }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className={cx('h-4 w-4 rounded border-gray-300 text-indigo-600', className)}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      {...props}
    />
  )
}

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: 'default' | 'outline' | 'destructive' | 'secondary'
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
        variant === 'default' && 'bg-indigo-100 text-indigo-700',
        variant === 'outline' && 'border border-gray-300 text-gray-700',
        variant === 'destructive' && 'bg-red-100 text-red-700',
        variant === 'secondary' && 'bg-gray-100 text-gray-700',
        className,
      )}
      {...props}
    />
  )
}

type AlertProps = React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'destructive' }

export function Alert({ className, variant = 'default', ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={cx(
        'rounded-md border p-3 text-sm',
        variant === 'destructive' ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-700',
        className,
      )}
      {...props}
    />
  )
}

export function AlertDescription(props: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} />
}

export function Select({
  value,
  onValueChange,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
}) {
  const items = React.Children.toArray(children)
  const trigger = items.find(
    (child) => React.isValidElement(child) && child.type === SelectTrigger,
  ) as React.ReactElement<React.HTMLAttributes<HTMLSelectElement> & { id?: string }> | undefined
  const content = items.find(
    (child) => React.isValidElement(child) && child.type === SelectContent,
  ) as React.ReactElement<{ children: React.ReactNode }> | undefined

  return (
    <select
      id={trigger?.props.id}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      className={cx(
        'h-10 rounded-md border border-gray-300 bg-white px-3 text-sm',
        trigger?.props.className,
      )}
    >
      {content?.props.children}
    </select>
  )
}

export function SelectTrigger(_props: React.HTMLAttributes<HTMLSelectElement> & { id?: string }) {
  return null
}

export function SelectContent(_props: { children: React.ReactNode }) {
  return null
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  return placeholder ? <option value="">{placeholder}</option> : null
}

export function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
  return <option value={value}>{children}</option>
}

export const Table = (props: React.TableHTMLAttributes<HTMLTableElement>) => (
  <table className={cx('w-full text-sm', props.className)} {...props} />
)
export const TableHeader = (props: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...props} />
export const TableBody = (props: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />
export const TableRow = (props: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cx('border-b border-gray-200', props.className)} {...props} />
)
export const TableHead = (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cx('px-3 py-3 text-left font-medium text-gray-500', props.className)} {...props} />
)
export const TableCell = (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cx('px-3 py-3 text-gray-700', props.className)} {...props} />
)

const DialogContext = createContext<(() => void) | null>(null)

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  if (!open) return null
  return <DialogContext.Provider value={() => onOpenChange(false)}>{children}</DialogContext.Provider>
}

export function DialogContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const close = useContext(DialogContext)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={close || undefined}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx('w-full max-w-lg rounded-lg bg-white p-6 shadow-xl', className)}
        onMouseDown={(event) => event.stopPropagation()}
        {...props}
      />
    </div>
  )
}

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cx('space-y-1.5', className)} {...props} />
)
export const DialogTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cx('text-lg font-semibold', className)} {...props} />
)
export const DialogDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cx('text-sm text-gray-500', className)} {...props} />
)
export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cx('mt-6 flex justify-end gap-2', className)} {...props} />
)

type IconProps = React.HTMLAttributes<HTMLSpanElement>
const icon = (symbol: string) =>
  function Icon({ className, ...props }: IconProps) {
    return <span aria-hidden className={cx('inline-flex items-center justify-center', className)} {...props}>{symbol}</span>
  }

export const Loader2 = icon('◌')
export const AlertTriangle = icon('⚠')
export const Clock = icon('◷')
export const Mail = icon('✉')
export const AlertCircle = icon('!')
export const Check = icon('✓')
export const CheckCircle = icon('✓')
export const XCircle = icon('×')
