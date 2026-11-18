/**
 * ClamAV scanner over clamd's TCP protocol (INSTREAM). The file is streamed in chunks; clamd answers
 * "stream: OK" or "stream: <Signature> FOUND". Configure with CLAMD_HOST (and CLAMD_PORT, default 3310).
 */
import { connect } from "node:net";

export interface ScanResult { status: "clean" | "infected" | "error"; signature: string | null; engine: string | null; detail: string | null }
export interface Scanner { id: string; scan(data: Uint8Array): Promise<ScanResult>; version(): Promise<string> }

function talk(host: string, port: number, timeoutMs: number, write: (send: (b: Uint8Array) => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`clamd at ${host}:${port} did not answer in ${timeoutMs} ms`)); }, timeoutMs);
    sock.on("connect", () => { write((b) => sock.write(b)); });
    sock.on("data", (d) => chunks.push(d));
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    sock.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8").replace(/\0+$/, "").trim()); });
  });
}

export class ClamdScanner implements Scanner {
  readonly id = "clamav";
  private host: string;
  private port: number;
  private timeoutMs: number;
  private chunk: number;
  constructor(host: string, port = 3310, timeoutMs = 120_000, chunk = 64 * 1024) {
    this.host = host; this.port = port; this.timeoutMs = timeoutMs; this.chunk = chunk;
  }

  async version(): Promise<string> {
    return talk(this.host, this.port, 10_000, (send) => send(Buffer.from("zVERSION\0")));
  }

  async scan(data: Uint8Array): Promise<ScanResult> {
    let engine: string | null = null;
    try { engine = await this.version(); } catch { /* reported by the scan itself */ }
    try {
      const reply = await talk(this.host, this.port, this.timeoutMs, (send) => {
        send(Buffer.from("zINSTREAM\0"));
        for (let o = 0; o < data.length; o += this.chunk) {
          const part = data.subarray(o, Math.min(o + this.chunk, data.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          send(len); send(part);
        }
        send(Buffer.alloc(4));   // zero-length chunk ends the stream
      });
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (found) return { status: "infected", signature: found[1]!, engine, detail: null };
      if (/^stream: OK$/.test(reply)) return { status: "clean", signature: null, engine, detail: null };
      return { status: "error", signature: null, engine, detail: reply || "no answer" };
    } catch (e) {
      return { status: "error", signature: null, engine, detail: (e as Error).message };
    }
  }
}

export function scannerFromEnv(env: NodeJS.ProcessEnv = process.env): Scanner | null {
  if (!env.CLAMD_HOST) return null;
  return new ClamdScanner(env.CLAMD_HOST, Number(env.CLAMD_PORT ?? 3310));
}
