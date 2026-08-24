import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8934;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

interface ExportFile {
  relativePath: string;
  content: unknown;
}

interface ExportRequestBody {
  dir: string;
  files: ExportFile[];
}

interface ReadFilesRequestBody {
  dir: string;
  files: string[];
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw) {
    throw new Error("Empty request body");
  }
  return JSON.parse(raw) as T;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function chooseFolder(prompt: string): Promise<string | null> {
  const script = `POSIX path of (choose folder with prompt "${escapeAppleScriptString(prompt)}")`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (error, stdout, stderr) => {
      if (error) {
        if (/User canceled/i.test(stderr) || /User canceled/i.test(error.message)) {
          resolve(null);
          return;
        }
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function writeExportFiles(dir: string, files: ExportFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const fullPath = path.join(dir, file.relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, `${JSON.stringify(file.content, null, 2)}\n`, "utf8");
    written.push(file.relativePath);
  }
  return written;
}

async function handleChooseFolder(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let prompt = "Select tokens folder";
  try {
    const body = await readJsonBody<{ prompt?: string }>(req).catch(() => ({}) as { prompt?: string });
    if (body.prompt) prompt = body.prompt;
  } catch {
    // no body sent — use default prompt
  }
  try {
    const chosen = await chooseFolder(prompt);
    sendJson(res, 200, { path: chosen });
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

async function handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody<ExportRequestBody>(req);
    if (!body.dir || !Array.isArray(body.files)) {
      sendJson(res, 400, { error: "Expected { dir, files: [{ relativePath, content }] }" });
      return;
    }
    const written = writeExportFiles(body.dir, body.files);
    sendJson(res, 200, { written });
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

function handleListFiles(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "", `http://localhost:${PORT}`);
  const dir = url.searchParams.get("dir");
  if (!dir) {
    sendJson(res, 400, { error: "Missing ?dir= query param" });
    return;
  }
  if (!fs.existsSync(dir)) {
    sendJson(res, 200, { files: [] });
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".tokens.json"))
    .sort();
  sendJson(res, 200, { files });
}

async function handleReadFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody<ReadFilesRequestBody>(req);
    if (!body.dir || !Array.isArray(body.files)) {
      sendJson(res, 400, { error: "Expected { dir, files: string[] }" });
      return;
    }
    const result: Record<string, unknown> = {};
    for (const name of body.files) {
      const fullPath = path.join(body.dir, name);
      try {
        result[name] = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch (error) {
        result[name] = { __error: (error as Error).message };
      }
    }
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/choose-folder") {
    void handleChooseFolder(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/export") {
    void handleExport(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/list-files") {
    handleListFiles(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/read-files") {
    void handleReadFiles(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`figma-token-bridge server listening on http://127.0.0.1:${PORT}`);
});
