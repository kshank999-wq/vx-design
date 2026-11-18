import { CATEGORY_LABEL, ManufacturingCategory } from "@vx/contracts";

export const CATEGORIES = ManufacturingCategory.options;
export { CATEGORY_LABEL };

export const NDA_METHODS: Record<string, string> = {
  our_template: "Signs our template", their_template: "Uses their own NDA", mutual: "Mutual NDA",
  none_required: "No NDA needed for quoting", unknown: "Not known yet",
};
export const MFR_STATUS: Record<string, string> = {
  candidate: "Candidate (not verified)", verified: "Verified", approved: "Approved vendor", inactive: "Inactive",
};
export const RECIPIENT_STATUS: Record<string, string> = {
  pending: "Not released", invited: "Invited", viewed: "Opened the packet", quoted: "Quoted", declined: "Declined", revoked: "Access revoked",
};
export const RFQ_STATUS: Record<string, string> = {
  draft: "Draft", packaging: "Building the packet…", ready: "Packet ready: owner approval needed", approved: "Approved: ready to release",
  sent: "Sent: suppliers quoting", closed: "Closed", canceled: "Canceled",
};
export const lines = (s: string) => s.split(/\r?\n|;/).map((x) => x.trim()).filter(Boolean);
export const fmtMoney = (n: number | null | undefined, cur: string) =>
  n == null ? "—" : `${cur} ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
