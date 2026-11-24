/** Marks a chat message as being about one open question, so the exchange can be shown under that question. */
export const QREF = (questionId: string) => `[about question ${questionId}]`;
export const QREF_RE = /^\[about question ([0-9a-f-]{36})\]/;
/** The person's own words from such a message (the context added for the assistant left out). */
export const askedPart = (body: string) => /My question: ([\s\S]*?)\n\nPlease explain/.exec(body)?.[1] ?? body.replace(QREF_RE, "").trim();
