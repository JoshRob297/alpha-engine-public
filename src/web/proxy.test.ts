import { test, expect } from "bun:test";

test("Proxy headers X-Forwarded-For y Host son aceptados correctamente", async () => {
  const reqHeaders = new Headers({
    "X-Forwarded-For": "203.0.113.195",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "alpha.joceslab.com",
    "X-Forwarded-User": "joshua",
    "X-Forwarded-Email": "joshua@joceslab.com",
  });

  expect(reqHeaders.get("X-Forwarded-Email")).toBe("joshua@joceslab.com");
  expect(reqHeaders.get("X-Forwarded-Proto")).toBe("https");
});
