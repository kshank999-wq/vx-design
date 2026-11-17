export function Banner({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <p role="alert" className="banner banner-error">{error}</p>;
  if (notice) return <p role="status" className="banner banner-notice">{notice}</p>;
  return null;
}
