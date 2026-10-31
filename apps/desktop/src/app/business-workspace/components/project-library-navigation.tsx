import '../project-prototype.css'

import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import { PROJECTS_ROUTE, WORKFLOWS_ROUTE } from '../../routes'
import { PROJECT_PROTOTYPE_COPY } from '../project-prototype-copy'

export function ProjectLibraryNavigation({ active }: { active: 'projects' | 'workflows' }) {
  const { locale } = useI18n()
  const copy = PROJECT_PROTOTYPE_COPY[locale]
  const navigate = useNavigate()

  return <nav aria-label={copy.peers} className="apex-project-peers">
    <Button aria-current={active === 'projects' ? 'page' : undefined} onClick={() => navigate(PROJECTS_ROUTE)} variant="ghost">{copy.projects}</Button>
    <Button aria-current={active === 'workflows' ? 'page' : undefined} onClick={() => navigate(WORKFLOWS_ROUTE)} variant="ghost">{copy.library}</Button>
  </nav>
}
