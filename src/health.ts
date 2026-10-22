import { createServer } from "node:http";
export function healthServer(
  checkDatabase: () => Promise<unknown>,
  isReady: () => boolean,
) {
  return createServer(async (req, res) => {
    if (!["/healthz", "/readyz"].includes(req.url ?? "")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let ok = true;
    if (req.url === "/readyz") {
      try {
        if (!isReady()) throw new Error("Not ready");
        await checkDatabase();
      } catch {
        ok = false;
      }
    }
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok }));
  });
}
