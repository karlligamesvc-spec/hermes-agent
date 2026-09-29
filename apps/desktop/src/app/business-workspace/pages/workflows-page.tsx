import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'

import { NEW_CHAT_ROUTE, projectDetailRoute, PROJECTS_ROUTE, routeDrawerNavigationState } from '../../routes'
import { createWorkflowDefinition } from '../api/adapters'
import type { WorkflowProject } from '../api/types'
import { BusinessPageHeader } from '../components/business-page-header'
import { ProjectCreateDialog } from '../components/project-create-dialog'
import { WorkflowStarterCard } from '../components/workflow-starter-card'
import {
  useVideoWorkflowCatalog,
  useWorkflowCatalog,
  useWorkflowDefinitions,
  useWorkflowProject,
  useWorkflowProjects
} from '../hooks/use-workflow-domain-lists'
import {
  type BusinessWorkflowStarter,
  businessWorkflowStarters,
  videoWorkflowStarters
} from '../view-model/workflow-starters'

export function WorkflowsView() {
  const { t } = useI18n()
  const c = t.businessWorkspace.workflows
  const location = useLocation()
  const navigate = useNavigate()
  const [reloadToken, setReloadToken] = useState(0)
  const [selectedStarter, setSelectedStarter] = useState<BusinessWorkflowStarter | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedProject, setSelectedProject] = useState<WorkflowProject | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [projectCreateOpen, setProjectCreateOpen] = useState(false)
  const [objectiveDraft, setObjectiveDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const catalog = useWorkflowCatalog(reloadToken)
  const videoCatalog = useVideoWorkflowCatalog(reloadToken)

  const launchContext = location.state as null | {
    businessGoalDraft?: unknown
    businessProjectId?: unknown
    businessStartSelection?: unknown
  }

  const startSelection = launchContext?.businessStartSelection === true

  const routeProjectId = new URLSearchParams(location.search).get('projectId')?.trim() ?? ''

  const targetProjectId =
    routeProjectId ||
    (typeof launchContext?.businessProjectId === 'string' ? launchContext.businessProjectId.trim() : '')

  const project = useWorkflowProject(targetProjectId || undefined)
  const projectItem = project.mode === 'ready' && project.item.id === targetProjectId ? project.item : null
  const projects = useWorkflowProjects(50, 'active')
  const chosenProject = selectedProjectId && selectedProjectId !== targetProjectId ? selectedProject : projectItem

  const targetObjective =
    typeof launchContext?.businessGoalDraft === 'string' ? launchContext.businessGoalDraft.slice(0, 4000) : ''

  const workflows = useWorkflowDefinitions(
    { limit: 50, ...((selectedProjectId || targetProjectId) ? { projectId: selectedProjectId || targetProjectId } : {}) },
    reloadToken
  )

  const alreadyAdded =
    selectedStarter !== null &&
    workflows.mode === 'ready' &&
    workflows.items.some(item => item.slug === selectedStarter.slug)

  const localStarters = businessWorkflowStarters(c)
  const localVideoStarters = videoWorkflowStarters(c)

  const starters = [
    ...(catalog.mode === 'ready'
      ? catalog.items
          .slice()
          .sort((left, right) => left.position - right.position)
          .flatMap(item => {
            const local = localStarters.find(starter => starter.id === item.id && starter.slug === item.slug)

            return local
              ? [{ ...local, businessPath: item.businessPath, recommended: item.recommended, version: item.version }]
              : []
          })
      : []),
    ...(videoCatalog.mode === 'ready'
      ? videoCatalog.items
          .slice()
          .sort((left, right) => left.position - right.position)
          .flatMap(item => {
            const local = localVideoStarters.find(starter => starter.id === item.id && starter.slug === item.slug)

            return local ? [{ ...local, recommended: item.recommended, version: item.version }] : []
          })
      : [])
  ]

  const catalogReady = catalog.mode === 'ready' || videoCatalog.mode === 'ready'
  const catalogLoading = !catalogReady && (catalog.mode === 'loading' || videoCatalog.mode === 'loading')
  const catalogUnavailable = catalog.mode === 'unavailable' && videoCatalog.mode === 'unavailable'

  const testCatalog = [catalog, videoCatalog].some(
    state => state.mode === 'ready' && /(?:local|test|staging|review)/i.test(state.version ?? '')
  )

  const recommended = starters.filter(starter => starter.recommended)
  const additional = starters.filter(starter => !starter.recommended)

  const videoStages = selectedStarter?.businessPath === 'video_production'
    ? selectedStarter.id === 'viral-video-remake'
      ? [
          c.videoStages.source.title,
          c.videoStages.transcript.title,
          c.videoStages.analysis.title,
          c.videoStages.project.title,
          c.videoStages.assets.title,
          c.videoStages.render.title,
          c.videoStages.delivery.title
        ]
      : [selectedStarter.title]
    : null

  const selectStarter = (starter: BusinessWorkflowStarter) => {
    if (targetProjectId && !projectItem) {
      return
    }

    setSelectedStarter(starter)
    setSelectedProjectId('')
    setSelectedProject(null)
    setObjectiveDraft(projectItem?.objective || targetObjective || starter.prompt)
    setSaveError(false)
    setTemplateOpen(true)
  }

  const openProject = () => {
    const projectId = selectedProjectId || targetProjectId

    if (projectId) {
      navigate(projectDetailRoute(projectId), { state: routeDrawerNavigationState(location) })
    } else {
      navigate(PROJECTS_ROUTE)
    }
  }

  const saveToProject = async () => {
    if (
      !selectedStarter ||
      !chosenProject ||
      selectedProjectId !== chosenProject.id ||
      !objectiveDraft.trim() ||
      alreadyAdded ||
      saving
    ) {
      return
    }

    setSaving(true)
    setSaveError(false)
    const outcome = await createWorkflowDefinition(objectiveDraft.trim(), selectedStarter, chosenProject.id)
    setSaving(false)

    if (outcome.mode !== 'created') {
      setSaveError(true)

      return
    }

    setSelectedStarter(null)
    setSelectedProjectId('')
    setReloadToken(token => token + 1)
    navigate(projectDetailRoute(chosenProject.id), { state: routeDrawerNavigationState(location) })
  }

  const onProjectCreated = async (created: WorkflowProject) => {
    setSelectedProject(created)
    setSelectedProjectId(created.id)
    setObjectiveDraft(created.objective || selectedStarter?.prompt || '')
    setProjectCreateOpen(false)

    if (!selectedStarter) {
      return
    }

    setSaving(true)
    const outcome = await createWorkflowDefinition(created.objective || selectedStarter.prompt, selectedStarter, created.id)
    setSaving(false)

    if (outcome.mode === 'created') {
      navigate(projectDetailRoute(created.id), { state: routeDrawerNavigationState(location) })
    } else {
      setSaveError(true)
    }
  }

  return (
    <section className="apex-business-surface apex-business-page apex-primary-page" data-business-workflows-page="">
      <div className="apex-primary-page-column">
        <BusinessPageHeader
          action={
            startSelection
              ? {
                  icon: 'arrow-left',
                  label: t.common.back,
                  onClick: () => navigate(NEW_CHAT_ROUTE, { state: launchContext })
                }
              : targetProjectId
              ? {
                  icon: 'arrow-left',
                  label: projectItem ? c.backToProject : t.businessWorkspace.projects.backToProjects,
                  onClick: openProject
                }
              : {
                  icon: 'play',
                  label: c.startGoal,
                  onClick: () => navigate(NEW_CHAT_ROUTE, { state: { businessGoalFocus: true } })
                }
          }
          description={startSelection ? c.goalSelectionDescription : targetProjectId ? c.projectDescription : c.description}
          eyebrow={c.eyebrow}
          icon="list-unordered"
          title={c.title}
          trailing={
            testCatalog ? (
              <p
                className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
                role="status"
              >
                {c.testDataNotice}
              </p>
            ) : undefined
          }
        />
      </div>
      {targetProjectId && (
        <section
          className="mx-auto w-full max-w-[65.625rem] rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-5 py-4"
          data-project-workflow-context=""
        >
          <p className="text-xs font-medium text-primary">{c.projectContext}</p>
          {projectItem ? (
            <>
              <h2 className="mt-1 text-lg font-semibold">{projectItem.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{projectItem.objective}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground" role="status">
              {project.mode === 'loading' ? c.projectLoading : c.projectUnavailable}
            </p>
          )}
        </section>
      )}
      {selectedProjectId && selectedStarter && chosenProject && !templateOpen && (
        <section
          className="mx-auto mt-5 w-full max-w-[65.625rem] rounded-2xl border border-primary/40 bg-(--ui-bg-elevated) p-5 shadow-sm"
          data-project-workflow-create=""
        >
          <p className="text-xs font-medium text-primary">{c.createEyebrow}</p>
          <h2 className="mt-1 text-lg font-semibold">{selectedStarter.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{c.createForProject(chosenProject.name)}</p>
          <label className="mt-4 grid gap-2 text-sm font-medium" htmlFor="project-workflow-objective">
            {c.objectiveLabel}
            <Textarea
              className="min-h-24 resize-y"
              id="project-workflow-objective"
              maxLength={4000}
              onChange={event => setObjectiveDraft(event.target.value)}
              value={objectiveDraft}
            />
          </label>
          {alreadyAdded && (
            <p className="mt-3 text-sm text-amber-700" role="status">
              {c.alreadyAdded}
            </p>
          )}
          {saveError && (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {c.saveFailed}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button disabled={saving} onClick={() => setSelectedStarter(null)} size="sm" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button
              aria-busy={saving || undefined}
              disabled={!objectiveDraft.trim() || saving || alreadyAdded}
              onClick={() => void saveToProject()}
              size="sm"
            >
              {saving ? c.savingWorkflow : c.saveWorkflow}
            </Button>
          </div>
        </section>
      )}
      <Dialog onOpenChange={setTemplateOpen} open={templateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{selectedStarter?.title || c.title}</DialogTitle>
            <DialogDescription>{selectedStarter?.summary}</DialogDescription>
          </DialogHeader>
          {selectedStarter && (
            <div className="space-y-4 text-sm">
              <p className="text-xs text-muted-foreground">{c.version(selectedStarter.version)}</p>
              <div>
                <h3 className="font-medium">{c.templateScope}</h3>
                <p className="mt-1 text-muted-foreground">{selectedStarter.summary}</p>
              </div>
              <div>
                <h3 className="font-medium">{c.templateExample}</h3>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-(--ui-bg-elevated) p-3 text-muted-foreground">{selectedStarter.prompt}</p>
              </div>
              <div>
                <h3 className="font-medium">{c.templateSteps}</h3>
                {videoStages ? (
                  <ol className="mt-1 list-inside list-decimal space-y-1 text-muted-foreground">
                    {videoStages.map(stage => <li key={stage}>{stage}</li>)}
                  </ol>
                ) : (
                  <>
                    <ol className="mt-1 list-inside list-decimal space-y-1 text-muted-foreground">
                      <li>{c.templateStepProject}</li>
                      <li>{c.templateStepGoal}</li>
                      <li>{c.templateStepRun}</li>
                    </ol>
                    <p className="mt-2 text-xs text-muted-foreground">{c.templateExecutionNote}</p>
                  </>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setTemplateOpen(false)} size="sm" variant="ghost">{t.common.cancel}</Button>
            {startSelection ? (
              <Button disabled={!selectedStarter} onClick={() => {
                if (!selectedStarter) {return}

                navigate(NEW_CHAT_ROUTE, { state: {
                  ...launchContext,
                  businessStartSelection: true,
                  businessWorkflowId: selectedStarter.id,
                  businessWorkflowSlug: selectedStarter.slug,
                  businessWorkflowVersion: selectedStarter.version,
                  businessWorkflowCatalogProvenance: testCatalog ? 'test' : 'production'
                } })
              }} size="sm">{c.use}</Button>
            ) : (
              <>
                {targetProjectId && (
                  <Button onClick={() => {
                    setSelectedProjectId(targetProjectId)
                    setTemplateOpen(false)
                  }} size="sm" variant="outline">{c.joinCurrentProject}</Button>
                )}
                <Button onClick={() => {
                  setTemplateOpen(false)
                  setProjectPickerOpen(true)
                }} size="sm" variant="outline">{c.joinExistingProject}</Button>
                <Button onClick={() => {
                  setTemplateOpen(false)
                  setProjectCreateOpen(true)
                }} size="sm">{c.newProjectAndJoin}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setProjectPickerOpen} open={projectPickerOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{c.joinExistingProject}</DialogTitle>
            <DialogDescription>{c.chooseProjectDescription}</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {projects.mode === 'ready' && projects.items.length ? (
              projects.items.map(item => (
                <Button className="w-full justify-start text-left" key={item.id} onClick={() => {
                  setSelectedProject(item)
                  setSelectedProjectId(item.id)
                  setObjectiveDraft(item.objective || selectedStarter?.prompt || '')
                  setProjectPickerOpen(false)
                }} variant="outline">{item.name}</Button>
              ))
            ) : (
              <p className="py-4 text-sm text-muted-foreground">
                {projects.mode === 'loading'
                  ? c.projectLoading
                  : projects.mode === 'ready'
                    ? c.noActiveProjects
                    : c.projectUnavailable}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ProjectCreateDialog
        onCreated={created => void onProjectCreated(created)}
        onOpenChange={setProjectCreateOpen}
        open={projectCreateOpen}
      />
      <section
        className="mx-auto w-full max-w-[65.625rem] border-b border-(--ui-stroke-tertiary) py-6"
        data-saved-workflows=""
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">
              {targetProjectId ? t.businessWorkspace.projects.workflowsTitle : c.savedTitle}
            </h2>
            {targetProjectId && <p className="mt-1 text-xs text-muted-foreground">{c.addingToProject}</p>}
          </div>
          {workflows.mode === 'ready' && (
            <span className="text-xs text-(--ui-text-tertiary)">{c.savedCount(workflows.items.length)}</span>
          )}
        </div>
        {workflows.mode === 'loading' ? (
          <div className="mt-4 flex min-h-20 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader className="size-6" label={c.loadingSaved} type="lemniscate-bloom" />
            {c.loadingSaved}
          </div>
        ) : workflows.mode === 'ready' && workflows.items.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) shadow-xs">
            {workflows.items.map(workflow => (
              <Button
                className="flex min-h-16 w-full items-center justify-between gap-4 rounded-none border-b border-(--ui-stroke-tertiary) px-4 py-3 text-left last:border-b-0"
                key={workflow.id}
                onClick={() =>
                  navigate(projectDetailRoute(workflow.projectId), {
                    state: routeDrawerNavigationState(location)
                  })
                }
                variant="ghost"
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium">{workflow.name}</strong>
                  <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                    {workflow.description || workflow.slug}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-(--ui-text-tertiary)">
                  {workflow.version ? <span>{c.version(workflow.version)}</span> : null}
                  {t.businessWorkspace.projects.lifecycle(workflow.status)}
                  <Codicon name="arrow-right" size="0.75rem" />
                </span>
              </Button>
            ))}
          </div>
        ) : workflows.mode === 'ready' ? (
          <p className="mt-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-5 text-xs text-muted-foreground">
            {targetProjectId ? c.projectSavedEmpty : c.savedEmpty}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/45 bg-amber-50/40 px-4 py-4 text-xs text-amber-800 dark:bg-amber-950/15 dark:text-amber-200">
            <span>{c.savedUnavailable}</span>
            <Button
              aria-label={`${c.retryCatalog} · ${c.savedTitle}`}
              onClick={() => setReloadToken(token => token + 1)}
              size="sm"
              variant="outline"
            >
              <Codicon name="refresh" size="0.875rem" />
              {c.retryCatalog}
            </Button>
          </div>
        )}
      </section>
      {catalogLoading ? (
        <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={c.title} type="lemniscate-bloom" />
          <span>{c.title}</span>
        </div>
      ) : !catalogReady ? (
        <div
          className="mx-auto grid min-h-72 w-full max-w-[65.625rem] place-items-center py-10 text-center"
          data-workflow-recovery=""
        >
          <div>
            <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
            <EmptyState
              description={catalogUnavailable ? c.localCatalogNotice : c.catalogUnavailableDescription}
              title={c.catalogUnavailable}
            />
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setReloadToken(token => token + 1)} size="sm">
                <Codicon name="refresh" size="0.875rem" />
                {c.retryCatalog}
              </Button>
              <Button
                onClick={targetProjectId ? openProject : () => navigate(NEW_CHAT_ROUTE)}
                size="sm"
                variant="ghost"
              >
                {targetProjectId ? c.backToProject : c.backToStart}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="mx-auto w-full max-w-[65.625rem] py-5">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">{c.recommendedTitle}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{c.recommendedDescription}</p>
              </div>
              <span className="text-xs text-(--ui-text-tertiary)">{c.pathCount(recommended.length)}</span>
            </div>
            <div className="apex-workflow-entry-grid grid gap-1" data-recommended-workflows="">
              {recommended.map(starter => (
                <WorkflowStarterCard
                  action={targetProjectId ? c.selectForProject : c.use}
                  disabled={Boolean(targetProjectId) && (!projectItem || saving)}
                  key={starter.id}
                  onSelect={() => selectStarter(starter)}
                  starter={starter}
                  variant="featured"
                />
              ))}
            </div>

            <div className="mb-4 mt-7 flex items-center justify-between gap-4 border-t border-(--ui-stroke-tertiary) pt-6">
              <h2 className="text-base font-semibold">{c.additionalTitle}</h2>
              <span className="text-xs text-(--ui-text-tertiary)">{c.pathCount(additional.length)}</span>
            </div>
            <div
              className="grid grid-cols-1 gap-3 min-[760px]:grid-cols-2 min-[1100px]:grid-cols-3"
              data-additional-workflows=""
            >
              {additional.map(starter => (
                <WorkflowStarterCard
                  action={targetProjectId ? c.selectForProject : c.useShort}
                  disabled={Boolean(targetProjectId) && (!projectItem || saving)}
                  key={starter.id}
                  onSelect={() => selectStarter(starter)}
                  starter={starter}
                  variant="compact"
                />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
