import { SignIn } from "@clerk/react";

export function Login() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <SignIn />
    </div>
  );
}
