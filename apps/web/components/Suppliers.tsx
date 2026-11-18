import { CATEGORIES, CATEGORY_LABEL, NDA_METHODS } from "@/lib/rfq";

export function ManufacturerFields({ m }: { m?: Record<string, unknown> }) {
  const arr = (k: string) => ((m?.[k] as string[] | undefined) ?? []);
  const certs = ((m?.certifications as { name: string; evidence: string | null }[] | undefined) ?? [])
    .map((c) => (c.evidence ? `${c.name}: ${c.evidence}` : c.name)).join("\n");
  return (
    <>
      <div className="grid2">
        <label>Name<input name="display_name" required defaultValue={(m?.display_name as string) ?? ""} /></label>
        <label>Website (https)<input name="website" type="url" pattern="https://.*" defaultValue={(m?.website as string) ?? ""} /></label>
        <label>Legal name (as registered)<input name="legal_name" defaultValue={(m?.legal_name as string) ?? ""} /></label>
        <label>Country (ISO code, e.g. CN, US, GB)<input name="country" maxLength={2} defaultValue={(m?.country as string) ?? ""} /></label>
      </div>
      <fieldset className="licenses">
        <legend className="small muted">Categories</legend>
        <div className="grid2">
          {CATEGORIES.map((c) => (
            <label key={c} className="radio"><input type="checkbox" name="categories" value={c} defaultChecked={arr("categories").includes(c)} />{CATEGORY_LABEL[c]}</label>
          ))}
        </div>
      </fieldset>
      <div className="grid2">
        <label>Processes (one per line)<textarea name="processes" rows={3} defaultValue={arr("processes").join("\n")} placeholder={"2–6 layer FR-4\nSMT assembly, 0402 and up"} /></label>
        <label>Certifications (one per line, "name: where it was seen")<textarea name="certifications" rows={3} defaultValue={certs} placeholder="ISO 9001: certificate PDF on their site" /></label>
        <label>File formats they accept (one per line)<textarea name="file_formats" rows={2} defaultValue={arr("file_formats").join("\n")} placeholder={"Gerber X2\nSTEP"} /></label>
        <label>NDA method<select name="nda_method" defaultValue={(m?.nda_method as string) ?? "unknown"}>
          {Object.entries(NDA_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Lead times<input name="lead_time_note" defaultValue={(m?.lead_time_note as string) ?? ""} placeholder="Prototype PCBA about 2 weeks" /></label>
        <label>Notes<input name="notes" defaultValue={(m?.notes as string) ?? ""} /></label>
      </div>
    </>
  );
}

