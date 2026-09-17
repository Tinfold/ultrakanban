import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useActor } from '@/hooks/use-actor'

/** Lets the user choose the name used for assignments and activity. */
export function ActorMenu() {
  const [actor, setActor] = useActor()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Signed in as ${actor}`}>
          <UserAvatar name={actor} size="xs" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-64 gap-2">
        <Label htmlFor="actor-name">Your name</Label>
        <Input
          id="actor-name"
          defaultValue={actor}
          onBlur={(event) => event.currentTarget.value.trim() && setActor(event.currentTarget.value.trim())}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        <p className="text-xs text-muted-foreground">Shown on tickets you’re assigned and in activity logs.</p>
      </PopoverContent>
    </Popover>
  )
}
