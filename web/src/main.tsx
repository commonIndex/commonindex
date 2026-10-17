import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider, useParams } from 'react-router-dom'
import { Shell } from './components/Shell'
import { RouteError } from './components/RouteError'
import { prefetchDoc } from './data/gateway'
import { TasksView } from './views/Tasks'
import { SignIn } from './views/SignIn'
import './styles.css'

/** A page's code, loaded the first time its route is visited. One bundle of
 *  every page was 1.4MB before anything drew; most visits use two or three. */
const page = (load: () => Promise<Record<string, unknown>>, name: string) =>
  async () => ({ Component: (await load())[name] as React.ComponentType })

// The editor is most of a megabyte of ProseMirror that no other page uses, so
// it loads when a doc is opened for writing rather than with the app — through
// the router, like every other page, not React.lazy: a Suspense fallback, once
// shown, is held on screen ~300ms by React even when the code is already here,
// which was most of the time it took to open a doc.
const docEdit = async () => {
  const { DocEdit } = await import('./views/DocEdit')
  return {
    Component: function DocEditRoute() {
      const { id = '' } = useParams()
      // keyed, so moving between two docs starts a fresh editor and save loop
      return <DocEdit key={id} id={id} />
    },
  }
}

// A data router supplies reliable navigation blocking for unsaved editor work.
// Routes and URLs are unchanged; no route loaders or network behavior are added.
/** Every doc opens in the editor; this address showed only browser-made
 *  sample docs, which are gone. Old links still land on the doc. */
function DocRedirect() {
  const { id } = useParams()
  return <Navigate to={`/docs/edit/${id ?? ''}`} replace />
}

const router = createBrowserRouter(createRoutesFromElements(
  <>
  <Route path="/signin" element={<SignIn />} />
  <Route element={<Shell />}>
    {/* Pathless, so a page that throws renders RouteError in the Shell's
        outlet — the sidebar stays and there is a way back. */}
    <Route errorElement={<RouteError />}>
      <Route path="/" element={<Navigate to="/board" replace />} />
      <Route path="/code" lazy={page(() => import('./views/CodeQuery'), 'CodeQueryView')} />
      <Route path="/board" element={<TasksView />} />
      <Route path="/projects" lazy={page(() => import('./views/Projects'), 'ProjectsView')} />
      <Route path="/projects/:id" lazy={page(() => import('./views/Projects'), 'ProjectDetail')} />
      <Route path="/experiments" lazy={page(() => import('./views/Experiments'), 'ExperimentsView')} />
      <Route path="/experiments/new" lazy={page(() => import('./views/ExperimentNew'), 'ExperimentNew')} />
      <Route path="/experiments/plan" lazy={page(() => import('./views/ExperimentPlan'), 'ExperimentPlan')} />
      <Route path="/experiments/analysis" lazy={page(() => import('./views/ExperimentAnalysis'), 'ExperimentAnalysis')} />
      <Route path="/experiments/:id" lazy={page(() => import('./views/Experiments'), 'ExperimentDetail')} />
      <Route path="/docs" lazy={page(() => import('./views/Docs'), 'DocsView')} />
      <Route path="/docs/:id" element={<DocRedirect />} />
      {/* The loader asks for the doc as the route starts, while the editor's
          code is still downloading — the two used to arrive one after the other. */}
      <Route path="/docs/edit/:id" loader={({ params }) => { if (params.id) prefetchDoc(params.id); return null }}
        lazy={docEdit} />
      <Route path="/dashboards/new" lazy={page(() => import('./views/DashboardNew'), 'DashboardNew')} />
      <Route path="/dashboards" lazy={page(() => import('./views/Dashboards'), 'DashboardsView')} />
      <Route path="/dashboards/:id" lazy={page(() => import('./views/Dashboards'), 'DashboardDetail')} />
      <Route path="/designs" lazy={page(() => import('./views/Designs'), 'DesignsView')} />
      <Route path="/designs/:id" lazy={page(() => import('./views/Designs'), 'DesignDetail')} />
      <Route path="/videos" lazy={page(() => import('./views/Videos'), 'VideosView')} />
      <Route path="/videos/:id" lazy={page(() => import('./views/Videos'), 'VideoDetail')} />
      <Route path="/artifacts/:id" lazy={page(() => import('./views/Artifact'), 'ArtifactDetail')} />
      <Route path="/skills" lazy={page(() => import('./views/Skills'), 'SkillsView')} />
      <Route path="/skills/:id" lazy={page(() => import('./views/Skills'), 'SkillDetail')} />
      <Route path="/channels" lazy={page(() => import('./views/Channels'), 'ChannelsIndex')} />
      <Route path="/channels/:id" lazy={page(() => import('./views/Channels'), 'ChannelView')} />
      <Route path="/agents" lazy={page(() => import('./views/Agents'), 'AgentsView')} />
      <Route path="/agents/:id" lazy={page(() => import('./views/Agents'), 'AgentDetail')} />
      <Route path="/members" lazy={page(() => import('./views/Members'), 'MembersView')} />
      <Route path="/tokens" lazy={page(() => import('./views/Tokens'), 'TokensView')} />
      <Route path="/settings/sign-in" lazy={page(() => import('./views/SignInSettings'), 'SignInSettingsView')} />
      <Route path="*" element={<Navigate to="/board" replace />} />
    </Route>
  </Route>
  </>
))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
