import { useEffect, useState, lazy, Suspense, type ComponentType } from "react";
import {
  Switch,
  Route,
  useLocation,
  Router as WouterRouter,
} from "wouter";
import { ClerkProvider } from "@clerk/react";
import {
  clerkPubKey,
  clerkProxyUrl,
  clerkAppearance,
  clerkLocalization,
  basePath,
  stripBase,
} from "./auth/clerkConfig";
import { SignInPage, SignUpPage } from "./components/AuthPages";
import { AdminGate } from "./components/AdminGate";

const ZoneEditorPage = lazy(() =>
  import("./pages/ZoneEditor").then((m) => ({ default: m.ZoneEditor }))
);

const WarehouseMapViewerPage = lazy(() =>
  import("./pages/WarehouseMapViewer").then((m) => ({
    default: m.WarehouseMapViewer,
  }))
);

import { modules as discoveredModules } from "./.generated/mockup-components";

type ModuleMap = Record<string, () => Promise<Record<string, unknown>>>;

function _resolveComponent(
  mod: Record<string, unknown>,
  name: string,
): ComponentType | undefined {
  const fns = Object.values(mod).filter(
    (v) => typeof v === "function",
  ) as ComponentType[];
  return (
    (mod.default as ComponentType) ||
    (mod.Preview as ComponentType) ||
    (mod[name] as ComponentType) ||
    fns[fns.length - 1]
  );
}

function PreviewRenderer({
  componentPath,
  modules,
}: {
  componentPath: string;
  modules: ModuleMap;
}) {
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setComponent(null);
    setError(null);

    async function loadComponent(): Promise<void> {
      const key = `./components/mockups/${componentPath}.tsx`;
      const loader = modules[key];
      if (!loader) {
        setError(`No component found at ${componentPath}.tsx`);
        return;
      }

      try {
        const mod = await loader();
        if (cancelled) {
          return;
        }
        const name = componentPath.split("/").pop()!;
        const comp = _resolveComponent(mod, name);
        if (!comp) {
          setError(
            `No exported React component found in ${componentPath}.tsx\n\nMake sure the file has at least one exported function component.`,
          );
          return;
        }
        setComponent(() => comp);
      } catch (e) {
        if (cancelled) {
          return;
        }

        const message = e instanceof Error ? e.message : String(e);
        setError(`Failed to load preview.\n${message}`);
      }
    }

    void loadComponent();

    return () => {
      cancelled = true;
    };
  }, [componentPath, modules]);

  if (error) {
    return (
      <pre style={{ color: "red", padding: "2rem", fontFamily: "system-ui" }}>
        {error}
      </pre>
    );
  }

  if (!Component) return null;

  return <Component />;
}

const TOOLS = [
  {
    name: "Zone Editor",
    description:
      "Draw and manage warehouse zone boundaries on the floor plan. Zones are saved directly to the database.",
    path: "/zone-editor",
  },
  {
    name: "Warehouse Map",
    description:
      "Read-only pan/zoom view of the warehouse floor plan SVG. Useful for reviewing the layout without editing zones.",
    path: "/warehouse-map",
  },
];

function Gallery() {
  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-2xl mx-auto">
        <header className="mb-10">
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">
            Internal Admin Tools
          </h1>
          <p className="text-gray-500 text-sm">
            Bookmark this page to quickly reach any admin tool.
          </p>
        </header>

        <ul className="space-y-3">
          {TOOLS.map((tool) => (
            <li key={tool.path}>
              <a
                href={`${basePath}${tool.path}`}
                className="flex items-center justify-between p-5 bg-white rounded-xl border border-gray-200 hover:border-gray-400 hover:shadow-sm transition-all group"
              >
                <div>
                  <p className="font-medium text-gray-900 group-hover:text-black">
                    {tool.name}
                  </p>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {tool.description}
                  </p>
                </div>
                <span className="text-gray-400 group-hover:text-gray-700 ml-4 text-lg leading-none">
                  →
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function getPreviewPath(): string | null {
  const { pathname } = window.location;
  const local =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || "/"
      : pathname;
  const match = local.match(/^\/preview\/(.+)$/);
  return match ? (match[1] ?? null) : null;
}

function ZoneEditorRoute() {
  return (
    <AdminGate requireAdmin>
      <Suspense fallback={null}>
        <ZoneEditorPage />
      </Suspense>
    </AdminGate>
  );
}

function WarehouseMapRoute() {
  // Read-only tool — still needs a signed-in Clerk session for API access.
  return (
    <AdminGate requireAdmin={false}>
      <Suspense fallback={null}>
        <WarehouseMapViewerPage />
      </Suspense>
    </AdminGate>
  );
}

function AdminRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      // @ts-expect-error exactOptionalPropertyTypes + Clerk prebuilt theme type incompatibility
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={clerkLocalization}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <Switch>
        <Route path="/" component={Gallery} />
        {/* REQUIRED — copy "/sign-in/*?" and "/sign-up/*?" verbatim. The /*?
            optional wildcard is the only wouter syntax that matches both the bare
            URL and Clerk's OAuth sub-paths. */}
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/zone-editor" component={ZoneEditorRoute} />
        <Route path="/warehouse-map" component={WarehouseMapRoute} />
        <Route component={Gallery} />
      </Switch>
    </ClerkProvider>
  );
}

function App() {
  const previewPath = getPreviewPath();

  // Canvas preview iframes render arbitrary mockup components and must NOT be
  // wrapped in Clerk/auth — they are the design sandbox, not an admin tool.
  if (previewPath) {
    return (
      <PreviewRenderer
        componentPath={previewPath}
        modules={discoveredModules}
      />
    );
  }

  return (
    <WouterRouter base={basePath}>
      <AdminRoutes />
    </WouterRouter>
  );
}

export default App;
