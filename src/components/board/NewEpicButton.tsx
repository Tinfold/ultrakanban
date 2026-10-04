import { LayersIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { EpicDialog } from './EpicDialog'

/** Starts the board's first epic; once it has some, the epics bar above the columns offers this. */
export function NewEpicButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label="New epic"
        title="Group the tickets of a larger piece of work in an epic"
        onClick={() => setOpen(true)}
      >
        <LayersIcon />
        <span className="hidden sm:inline">New epic</span>
      </Button>
      <EpicDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
