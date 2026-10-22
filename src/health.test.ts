import { expect, it, vi } from "vitest";
import { healthServer } from "./health.js";
it("keeps Railway readiness false until polling and the database are ready", async () => {
  let ready = false;
  const check = vi.fn().mockResolvedValue(undefined);
  const server = healthServer(check, () => ready);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    expect((await fetch(url + "/healthz")).status).toBe(200);
    expect((await fetch(url + "/readyz")).status).toBe(503);
    ready = true;
    expect((await fetch(url + "/readyz")).status).toBe(200);
    check.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await fetch(url + "/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect((await fetch(url + "/unknown")).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
