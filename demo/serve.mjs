// Tiny static server for the demo page (content scripts can't run on file://).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, "..");
const port = process.env.PORT ? Number(process.env.PORT) : 8797;

createServer(async (req, res) => {
  try {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    // /ext/* serves repo files so the demo can load the real content script + lib as modules
    const fromRepo = path.startsWith("/ext/");
    const body = await readFile(join(fromRepo ? repoRoot : root, fromRepo ? path.slice(4) : path));
    const js = path.endsWith(".js") || path.endsWith(".mjs");
    res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html" : js ? "text/javascript" : "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`demo on http://127.0.0.1:${port}`));
