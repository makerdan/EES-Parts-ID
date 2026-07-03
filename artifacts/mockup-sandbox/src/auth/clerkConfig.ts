import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains. Do not inline the env var, leave
// publishableKey undefined, or replace publishableKeyFromHost with anything else.
export const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev (Clerk hits dev FAPI directly), auto-set
// in prod. Do NOT gate on import.meta.env.PROD / NODE_ENV — the empty dev value
// is intentional, and any branching breaks the prod proxy.
export const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

export const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's setLocation
// prepends the base — strip it to avoid doubling.
export function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

export const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#0070ff",
    colorForeground: "#0d1117",
    colorMutedForeground: "#57606a",
    colorDanger: "#cf222e",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "#0d1117",
    colorNeutral: "#d0d7de",
    fontFamily: "'Inter', system-ui, sans-serif",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[400px] max-w-full overflow-hidden shadow-xl border border-[#d0d7de]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#0d1117] font-semibold",
    headerSubtitle: "text-[#57606a]",
    socialButtonsBlockButton: "border border-[#d0d7de] bg-white hover:bg-[#f6f8fa]",
    socialButtonsBlockButtonText: "text-[#0d1117] font-medium",
    formFieldLabel: "text-[#0d1117] font-medium",
    formButtonPrimary: "bg-[#0070ff] hover:bg-[#005fd6] text-white font-semibold",
    formFieldInput: "border border-[#d0d7de] bg-white text-[#0d1117]",
    footerActionText: "text-[#57606a]",
    footerActionLink: "text-[#0070ff] hover:text-[#005fd6] font-medium",
    dividerText: "text-[#57606a]",
    dividerLine: "bg-[#d0d7de]",
    identityPreviewEditButton: "text-[#0070ff]",
    formFieldSuccessText: "text-[#1a7f37]",
    alertText: "text-[#0d1117]",
    logoBox: "justify-center",
    logoImage: "h-12 w-12",
  },
};

export const clerkLocalization = {
  signIn: {
    start: {
      title: "Warehouse Admin",
      subtitle: "Sign in to access the Zone Editor",
    },
  },
  signUp: {
    start: {
      title: "Create your account",
      subtitle: "Request access to the admin tools",
    },
  },
};
