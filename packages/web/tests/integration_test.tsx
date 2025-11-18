import { assertEquals, assertExists } from "jsr:@std/assert";
import { App } from "fresh";
import { define } from "../utils.ts";
import IndexRoute from "../routes/index.tsx";
import AppWrapper from "../routes/_app.tsx";

Deno.test("Fresh app - route integration tests", async (t) => {
  await t.step("index route component exists and is defined", () => {
    assertExists(IndexRoute, "Index route should exist");
    assertEquals(typeof IndexRoute, "function", "Route should be a function");
  });

  await t.step("app wrapper component exists", () => {
    assertExists(AppWrapper, "App wrapper should exist");
    assertEquals(typeof AppWrapper, "function", "App wrapper should be a function");
  });

  await t.step("can create app instance with routes", () => {
    const testApp = new App();
    assertExists(testApp, "Should be able to create App instance");
  });

  await t.step("define utility creates page definitions", () => {
    assertExists(define, "Define utility should exist");
    assertExists(define.page, "Define should have page method");
    assertEquals(typeof define.page, "function", "define.page should be a function");
  });

  await t.step("test route renders without serialization errors", async () => {
    // Create a test app with just the app wrapper
    const handler = new App()
      .get("/test", (ctx) => {
        return ctx.render(
          <div>
            <h1>Test Page</h1>
            <p>Testing basic rendering</p>
          </div>
        );
      })
      .handler();

    const request = new Request("http://localhost/test");
    const response = await handler(request);

    assertEquals(response.status, 200, "Should return 200 OK");
    const html = await response.text();
    assertEquals(html.includes("Test Page"), true, "Should contain test content");
  });

  await t.step("static routes return proper responses", async () => {
    const handler = new App()
      .get("/health", () => new Response("OK", { status: 200 }))
      .handler();

    const request = new Request("http://localhost/health");
    const response = await handler(request);

    assertEquals(response.status, 200, "Health check should return 200");
    const text = await response.text();
    assertEquals(text, "OK", "Health check should return OK");
  });

  await t.step("404 handling works correctly", async () => {
    const handler = new App()
      .get("/exists", () => new Response("exists"))
      .handler();

    const request = new Request("http://localhost/nonexistent");
    const response = await handler(request);

    assertEquals(response.status, 404, "Should return 404 for non-existent routes");
  });

  await t.step("app handles different HTTP methods", async () => {
    const handler = new App()
      .get("/resource", () => new Response("GET"))
      .post("/resource", () => new Response("POST"))
      .handler();

    const getReq = new Request("http://localhost/resource", { method: "GET" });
    const getRes = await handler(getReq);
    assertEquals(await getRes.text(), "GET", "GET method should work");

    const postReq = new Request("http://localhost/resource", { method: "POST" });
    const postRes = await handler(postReq);
    assertEquals(await postRes.text(), "POST", "POST method should work");
  });
});
