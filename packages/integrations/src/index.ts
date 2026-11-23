/**
 * Provider connectors and the capability registry (spec §4).
 *
 * Every external tool or API is wrapped in an adapter that declares which
 * operations it supports. An operation is only callable by the orchestrator
 * once the G0 audit has marked it `verified` in public.tool_capabilities —
 * having an API is not evidence that write/edit access works.
 */

export type CapabilityStatus = "untested" | "verified" | "partial" | "blocked";

export interface CapabilityRecord {
  toolName: string;
  operation: string;
  status: CapabilityStatus;
  toolVersion?: string;
  deploymentMode?: string;
  license?: string;
  commercialOk?: boolean;
  verifiedAt?: string;
}

export interface IntegrationAdapter<Ops extends string = string> {
  /** Matches tool_capabilities.tool_name. */
  readonly toolName: string;
  readonly operations: readonly Ops[];
  /** Reports the installed/remote version, used for reproducibility records. */
  version(): Promise<string>;
}

export class CapabilityNotVerifiedError extends Error {
  constructor(toolName: string, operation: string, status: CapabilityStatus | "missing") {
    super(`${toolName}.${operation} is ${status}; run the G0 verification spike before using it`);
    this.name = "CapabilityNotVerifiedError";
  }
}

/** Throws unless the operation has passed G0 verification. */
export function assertCapability(
  registry: readonly CapabilityRecord[],
  toolName: string,
  operation: string,
): CapabilityRecord {
  const record = registry.find((r) => r.toolName === toolName && r.operation === operation);
  if (!record) throw new CapabilityNotVerifiedError(toolName, operation, "missing");
  if (record.status !== "verified") throw new CapabilityNotVerifiedError(toolName, operation, record.status);
  return record;
}

export * from "./sourcing/types.ts";
export * from "./sourcing/normalize.ts";
export * from "./sourcing/bom.ts";
export * from "./sourcing/fixture.ts";
export * from "./sourcing/nexar.ts";
export * from "./sourcing/digikey.ts";
export * from "./sourcing/mouser.ts";
export * from "./sourcing/providers.ts";
export * from "./sourcing/relay.ts";
export * from "./imaging/types.ts";
export * from "./imaging/gemini.ts";
export * from "./imaging/openai.ts";
export * from "./imaging/fixture.ts";
export * from "./imaging/providers.ts";
