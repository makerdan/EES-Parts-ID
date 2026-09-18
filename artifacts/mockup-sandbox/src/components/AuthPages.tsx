import { SignIn, SignUp } from "@clerk/react";
import { basePath } from "../auth/clerkConfig";

export function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#f6f8fa] px-4">
      {/* path must be the full browser path — Clerk reads window.location.pathname directly */}
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

export function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#f6f8fa] px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}
