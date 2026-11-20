"use client";
import Link from "next/link";

/** Shown instead of the bare crash page when a page or form fails unexpectedly. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tooLarge = /body exceeded|too large|413|payload/i.test(error.message);
  return (
    <main>
      <h1>Something went wrong</h1>
      <p className="banner banner-error">
        {tooLarge ? "The file was too large to send this way. Use the upload box on the Project inputs page (files go straight to storage), or try again."
          : "The page could not finish what it was doing. Nothing you already saved is lost."}
      </p>
      {error.digest && <p className="small muted">Reference: {error.digest}</p>}
      <p><button className="btn btn-primary" type="button" onClick={reset}>Try again</button> <Link className="btn" href="/projects">Back to projects</Link></p>
    </main>
  );
}
