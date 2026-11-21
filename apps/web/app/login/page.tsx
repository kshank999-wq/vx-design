import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await searchParams;
  return (
    <main className="narrow">
      <img src="/logo-large.png" alt="" width={720} height={240} style={{ width: "100%", height: "auto", margin: "0 0 8px" }} />
      <h1>Sign in</h1>
      <p className="muted">Spec-driven electronics and hardware engineering.</p>
      <Banner error={error} notice={notice} />
      <form className="card stack">
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} required /></label>
        <div className="row">
          <SubmitButton formAction={signIn} pendingText="Signing in…">Sign in</SubmitButton>
          <SubmitButton formAction={signUp} variant="secondary" pendingText="Creating…">Create account</SubmitButton>
        </div>
      </form>
    </main>
  );
}
