import { SubmitButton } from "@/components/SubmitButton";
import { certText, MODULE_KINDS, type ModuleRow } from "@/lib/modules";

/** Add or edit a module. Certifications are one per line: regime | identifier | https link to the grant, or a note. */
export function ModuleForm({ action, m }: { action: (form: FormData) => void | Promise<void>; m?: ModuleRow | null }) {
  return (
    <form action={action} className="stack small" data-testid="module-form">
      <div className="grid2">
        <label>Kind<select name="kind" defaultValue={m?.kind ?? "radio_module"} aria-label="Module kind">{Object.entries(MODULE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Name<input name="name" required defaultValue={m?.name} aria-label="Module name" /></label>
        <label>Manufacturer<input name="manufacturer" required defaultValue={m?.manufacturer} aria-label="Module manufacturer" /></label>
        <label>Part number<input name="mpn" required defaultValue={m?.mpn} aria-label="Module part number" /></label>
        <label>Interfaces (comma separated)<input name="interfaces" defaultValue={m?.interfaces.join(", ")} aria-label="Interfaces" placeholder="UART, SPI, I2C, USB" /></label>
        <label>Radios (comma separated)<input name="radios" defaultValue={m?.radios.join(", ")} aria-label="Radios" placeholder="Bluetooth LE, Wi-Fi 2.4 GHz" /></label>
        <label>Supply min (V)<input name="v_min" defaultValue={m?.supply.v_min} aria-label="Supply min" /></label>
        <label>Supply max (V)<input name="v_max" defaultValue={m?.supply.v_max} aria-label="Supply max" /></label>
        <label>Typical current (mA)<input name="i_typ_ma" defaultValue={m?.supply.i_typ_ma} aria-label="Typical current" /></label>
        <label>Peak current (mA)<input name="i_max_ma" defaultValue={m?.supply.i_max_ma} aria-label="Peak current" /></label>
        <label>Sleep current (µA)<input name="sleep_ua" defaultValue={m?.supply.sleep_ua} aria-label="Sleep current" /></label>
        <label>Lifecycle<select name="lifecycle" defaultValue={m?.lifecycle ?? "unknown"} aria-label="Lifecycle">
          {["active", "nrnd", "last_time_buy", "obsolete", "unknown"].map((l) => <option key={l} value={l}>{l.replace(/_/g, " ")}</option>)}</select></label>
        <label>Size X (mm)<input name="dim_x" defaultValue={m?.dimensions_mm.x} aria-label="Size X" /></label>
        <label>Size Y (mm)<input name="dim_y" defaultValue={m?.dimensions_mm.y} aria-label="Size Y" /></label>
        <label>Size Z (mm)<input name="dim_z" defaultValue={m?.dimensions_mm.z} aria-label="Size Z" /></label>
        <label>Source link (https)<input name="source_url" type="url" defaultValue={m?.source_url ?? ""} aria-label="Module source link" /></label>
        <label>Or source note<input name="source_note" defaultValue={m?.source_note ?? ""} aria-label="Module source note" /></label>
        <label>Read on<input name="checked_on" type="date" defaultValue={m?.checked_on ?? ""} aria-label="Read on" /></label>
      </div>
      <label>Description<input name="description" defaultValue={m?.description ?? ""} aria-label="Module description" /></label>
      <label>Performance, one per line as the datasheet states it (label: value)
        <textarea name="performance" rows={3} defaultValue={Object.entries(m?.performance ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")} aria-label="Performance" placeholder="TX power: +8 dBm" /></label>
      <label>Certifications, one per line: regime | identifier | https link to the grant or certificate, or where it was read
        <textarea name="certifications" rows={3} defaultValue={m ? certText(m) : ""} aria-label="Certifications" placeholder="FCC | 2AC7Z-EXAMPLE | https://fccid.io/…" /></label>
      <label>CAD, one per line: kind | https link
        <textarea name="cad" rows={2} defaultValue={(m?.cad ?? []).map((c) => `${c.kind} | ${c.url}`).join("\n")} aria-label="CAD links" placeholder="footprint | https://…" /></label>
      <p className="muted">Enter only what the manufacturer's documents state, with where you read it. A certification without a source is refused.</p>
      <div><SubmitButton pendingText="Saving…">{m ? "Save module" : "Add module"}</SubmitButton></div>
    </form>
  );
}
