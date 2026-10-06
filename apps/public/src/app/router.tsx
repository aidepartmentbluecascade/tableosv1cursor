import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { SharePage } from "../routes/SharePage.tsx";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$token",
  component: function ShareRoute() {
    const { token } = shareRoute.useParams();
    return <SharePage token={token} />;
  },
});

const formRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/f/$token",
  component: function FormRoute() {
    const { token } = formRoute.useParams();
    return <SharePage token={token} forceForm />;
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function Index() {
    return (
      <p style={{ padding: 24, fontFamily: "system-ui" }}>
        Open a shared Tabula link (<code>/s/…</code> or <code>/f/…</code>).
      </p>
    );
  },
});

const routeTree = rootRoute.addChildren([indexRoute, shareRoute, formRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
