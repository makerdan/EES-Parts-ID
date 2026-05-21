import { useEffect, useState, lazy, Suspense, type ComponentType } from "react";

const ZoneEditorPage = lazy(() =>
  import("./pages/ZoneEditor").then((m) => ({ default: m.ZoneEditor }))
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

function getBasePath(): string {
  return import.meta.env.BASE_URL.replace(/\/$/, "");
}

const TOOLS = [
  {
    name: "Zone Editor",
    description:
      "Draw and manage warehouse zone boundaries on the floor plan. Zones are saved directly to the database.",
    path: "/zone-editor",
  },
];

function Gallery() {
  const basePath = getBasePath();
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
  const basePath = getBasePath();
  const { pathname } = window.location;
  const local =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || "/"
      : pathname;
  const match = local.match(/^\/preview\/(.+)$/);
  return match ? match[1] : null;
}

function isZoneEditorPath(): boolean {
  const basePath = getBasePath();
  const { pathname } = window.location;
  const local =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || "/"
      : pathname;
  return local === "/zone-editor" || local.startsWith("/zone-editor/");
}

function App() {
  const previewPath = getPreviewPath();

  if (previewPath) {
    return (
      <PreviewRenderer
        componentPath={previewPath}
        modules={discoveredModules}
      />
    );
  }

  if (isZoneEditorPath()) {
    return (
      <Suspense fallback={null}>
        <ZoneEditorPage />
      </Suspense>
    );
  }

  return <Gallery />;
}

export default App;
