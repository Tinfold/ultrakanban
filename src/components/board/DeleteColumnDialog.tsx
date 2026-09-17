import { useState } from 'react'
import type { Column } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ColorDot } from '@/components/common/TagChip'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBoardContext } from './board-context'

const DELETE_TICKETS = '__delete'

interface DeleteColumnDialogProps {
  column: Column
  ticketCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteColumnDialog({ column, ticketCount, open, onOpenChange }: DeleteColumnDialogProps) {
  const { detail, actions } = useBoardContext()
  const others = detail.columns.filter((other) => other.id !== column.id)
  const [target, setTarget] = useState<string>(others[0]?.id ?? DELETE_TICKETS)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete “${column.name}”?`}
      description={
        ticketCount
          ? `This column contains ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}.`
          : 'This column is empty.'
      }
      confirmLabel="Delete column"
      onConfirm={() => actions.deleteColumn(column.id, target === DELETE_TICKETS ? undefined : target)}
    >
      {ticketCount > 0 && (
        <div className="grid gap-2">
          <Label>Its tickets should be</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {others.map((other) => (
                <SelectItem key={other.id} value={other.id}>
                  <ColorDot color={other.color} />
                  Moved to {other.name}
                </SelectItem>
              ))}
              <SelectItem value={DELETE_TICKETS} className="text-destructive">
                Deleted permanently
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </ConfirmDialog>
  )
}
