/** SSRF: in production a webhook must never reach a non-public address. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { checkWebhookDestination, isPublicAddress } from "./destinationGuard.js";
import { validateWebhookUrl } from "./create.js";
import { createFetchTransport } from "./transport.js";

test("non-public addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.18.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("a public hostname that resolves inward is refused at delivery time", async () => {
  const rebinding = async () => ["93.184.216.34", "10.0.0.7"];
  assert.match((await checkWebhookDestination("https://hooks.example.com/x", rebinding))!, /non-public address 10\.0\.0\.7/);
  assert.equal(await checkWebhookDestination("https://hooks.example.com/x", async () => ["93.184.216.34"]), null);
  assert.match((await checkWebhookDestination("https://[::1]/x"))!, /non-public/);
});

test("production refuses internal URLs when an endpoint is saved", () => {
  const prod = { nodeEnv: "production" as const };
  for (const url of ["https://127.0.0.1/hook", "https://169.254.169.254/latest", "https://localhost/x",
    "https://[::1]/x", "https://api.internal/x", "https://10.0.0.5:3000/x"]) {
    assert.throws(() => validateWebhookUrl(url, prod), /invalid_url/, url);
  }
  assert.equal(validateWebhookUrl("https://hooks.example.com/x", prod).hostname, "hooks.example.com");
  assert.equal(validateWebhookUrl("http://localhost:9/x", { nodeEnv: "development" }).hostname, "localhost");
});

test("the guarded transport never sends to a local receiver; the dev transport does", async () => {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  try {
    const guarded = await createFetchTransport({ blockNonPublicDestinations: true })({ url, headers: {}, body: "{}", timeoutMs: 2000 });
    assert.equal(guarded.statusCode, null);
    assert.match(guarded.errorMessage!, /blocked_destination/);
    assert.equal(hits, 0, "nothing reached the internal receiver");

    const dev = await createFetchTransport()({ url, headers: {}, body: "{}", timeoutMs: 2000 });
    assert.equal(dev.statusCode, 200);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
