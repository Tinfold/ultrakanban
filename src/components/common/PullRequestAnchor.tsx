import type { ComponentProps } from 'react'
import { Link } from 'wouter'
import { parseLocalPullRequestUrl } from '@shared/domain'

/**
 * A link to a pull request: a GitHub one opens in a new tab, a local one (`/b/<board>/pr/<number>`, see
 * `LocalPullRequest`) on its page here.
 */
export function PullRequestAnchor({ href, ...props }: ComponentProps<'a'> & { href: string }) {
  if (parseLocalPullRequestUrl(href)) return <Link href={href} {...props} />
  return <a href={href} target="_blank" rel="noreferrer" {...props} />
}
