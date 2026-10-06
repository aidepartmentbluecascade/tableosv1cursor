import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
  redirect,
} from "@tanstack/react-router";
import { api, ApiProblemError } from "../lib/api.ts";
import { authQueryKey } from "../features/auth/use-auth.ts";
import { queryClient } from "../lib/query-client.ts";
import { SearchPaletteHost } from "./providers.tsx";
import { LoginPage } from "../routes/login.tsx";
import { SignupPage } from "../routes/signup.tsx";
import { HomePage } from "../routes/home.tsx";
import { BasePage } from "../routes/base.tsx";
import { ContactsPage } from "../routes/contacts.tsx";

async function ensureAuth() {
  try {
    return await queryClient.fetchQuery({
      queryKey: authQueryKey,
      queryFn: () => api.me(),
      staleTime: 60_000,
    });
  } catch (error) {
    if (
      error instanceof ApiProblemError &&
      (error.problem.status === 401 ||
        error.problem.status === 503 ||
        error.problem.status === 502)
    ) {
      throw redirect({ to: "/login" });
    }
    // Proxy/backend outages often surface as opaque 500s on /auth/me.
    if (error instanceof ApiProblemError && error.problem.status >= 500) {
      throw redirect({ to: "/login" });
    }
    throw error;
  }
}

async function redirectIfAuthed() {
  try {
    await queryClient.fetchQuery({
      queryKey: authQueryKey,
      queryFn: () => api.me(),
      staleTime: 60_000,
    });
    throw redirect({ to: "/" });
  } catch (error) {
    if (isRedirect(error)) {
      throw error;
    }
  }
}

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <SearchPaletteHost />
    </>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: redirectIfAuthed,
  component: LoginPage,
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  beforeLoad: redirectIfAuthed,
  component: SignupPage,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    const me = await ensureAuth();
    return { me };
  },
  component: HomePage,
});

const baseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bases/$baseId",
  beforeLoad: async () => {
    const me = await ensureAuth();
    return { me };
  },
  component: function BaseRouteComponent() {
    const { baseId } = baseRoute.useParams();
    return <BasePage baseId={baseId} />;
  },
});

const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  validateSearch: (search: Record<string, unknown>) => ({
    workspaceId:
      typeof search.workspaceId === "string" ? search.workspaceId : "",
  }),
  beforeLoad: async ({ search }) => {
    const me = await ensureAuth();
    if (!search.workspaceId) {
      throw redirect({ to: "/" });
    }
    return { me, workspaceId: search.workspaceId };
  },
  component: function ContactsRouteComponent() {
    const { workspaceId } = contactsRoute.useSearch();
    return <ContactsPage workspaceId={workspaceId} />;
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  homeRoute,
  baseRoute,
  contactsRoute,
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
