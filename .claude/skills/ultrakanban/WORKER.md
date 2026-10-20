---
name: ultrakanban
description: Work one ticket from an ultrakanban board - plan, checklist, review, feedback. The short version of SKILL.md that the agent loop gives its runs.
---

# Working a ticket from an ultrakanban board

The board is an HTTP API (`$KANBAN`, board `$BOARD`; full reference: `GET $KANBAN/api`). Send
`-H "X-Actor: $ME"` on every write, where `$ME` is the name you were given (`<agent>/<model>/<effort>`). Use that exact
name as `agent`. Your ticket is already claimed and in progress. Work only that one.

## Rules

- Read the ticket and its comments first; the newest instruction wins. If they conflict or are unclear, ask in a
  comment and stop.
- Never move a ticket to the done column: it moves there by itself when the pull request is merged.
- If someone moves your ticket out of progress, or unassigns or reassigns it, it is no longer yours: stop and say in a
  comment what you had done.
- If the ticket can't be worked because it waits for something else, append `Blocked by #12` to its description (or tag
  it `blocked` for something off the board) with `PATCH /api/tickets/$TICKET` and `ifVersion`, comment why, and release
  it: `POST /api/tickets/$TICKET/release` with `{"agent":"$ME","moveTo":"<column it came from>"}`.
- Keep your context small: search before reading, trim JSON with `jq`, print only failures of long output.

## Read the ticket

```sh
curl -s $KANBAN/api/tickets/$TICKET            # title, description, tags, pull request
curl -s $KANBAN/api/tickets/$TICKET/activity   # comments and history, oldest first
```

## Post your plan and size estimate

Before the work: a short markdown plan and a size: `S` small, `M` a few files, `L` large or with open questions.

```sh
curl -s -X POST $KANBAN/api/tickets/$TICKET/plan -H 'Content-Type: application/json' -H "X-Actor: $ME" \
  -d "{\"agent\":\"$ME\",\"estimate\":\"M\",\"plan\":\"<markdown>\"}"
```

If the response has `"approval": "pending"`, stop and exit: approval is your go-ahead. Never approve your own plan.
Post one plan per ticket, again only if it changes a lot.

## Checklist

Check each `- [ ]` step off as soon as you finish it (0-based), not all at once. Check off only what you did; leave a
skipped step unchecked and say why in your review comment.

```sh
curl -s -X POST $KANBAN/api/tickets/$TICKET/checklist/0 -H 'Content-Type: application/json' -H "X-Actor: $ME" \
  -d '{"checked":true}'
```

Post a comment on a notable decision or when blocked: `POST /api/tickets/$TICKET/comments` with `{"body":"<markdown>"}`.
Attach screenshots of visible changes: `POST /api/tickets/$TICKET/attachments -F file=@shot.png` (PNG, JPEG, GIF, WebP,
MP4, WebM, up to 25 MB).

## Submit for review

Push a branch, open the pull request, then:

```sh
curl -s -X POST $KANBAN/api/tickets/$TICKET/review -H 'Content-Type: application/json' -H "X-Actor: $ME" \
  -d "{\"agent\":\"$ME\",\"pullRequest\":\"$PR_URL\",\"comment\":\"What changed and how it was verified.\"}"
```

Re-read the ticket first to be sure it is still yours. A ticket tagged `question` needs an answer, not a change:
submit it with the answer as the comment and no `pullRequest`.

## Review feedback

Check ticket comments, `gh pr view $PR_URL --comments`, `gh api repos/$OWNER/$REPO/pulls/$NUMBER/comments` and
`gh pr checks $PR_URL`. Address every point, push fixes, reply on the pull request, and summarise in a ticket comment.
Resolve merge conflicts by merging the base branch into the pull request's branch. If the pull request is closed
without merging, comment why and release into Cancelled (`{"agent":"$ME","moveTo":"Cancelled"}`).

If failing CI doesn't come from the code (billing limits, lost runners, missing secrets, unrelated flaky tests), push
nothing: explain in a ticket comment and stop.

End every pull request comment, review and inline reply with `<!-- ultrakanban:<your name> -->`.

## Errors

`409 already_claimed` / `claimed_by_other`: not yours, don't touch. `409 version_conflict`: re-read and redo.
`409 awaiting_approval`: stop. `429 usage_reserve_reached`: stop and report.

Filing tickets, epics, splitting a ticket into sub-tickets and orchestration are in the full skill, `SKILL.md` in the
ultrakanban repository (`.claude/skills/ultrakanban/SKILL.md`), or `GET $KANBAN/api`.
