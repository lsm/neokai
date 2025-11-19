import { describe, test, expect } from "bun:test";
import { App } from "fresh";
import { define } from "../utils.ts";
import IndexRoute from "../routes/index.tsx";
import AppWrapper from "../routes/_app.tsx";

describe("Fresh app - route integration tests", () => {
  test("index route component exists and is defined", () => {
    expect(IndexRoute).toBeDefined();
    expect(typeof IndexRoute).toBe("function");
  });

  test("app wrapper component exists", () => {
    expect(AppWrapper).toBeDefined();
    expect(typeof AppWrapper).toBe("function");
  });

  test("can create app instance with routes", () => {
    const testApp = new App();
    expect(testApp).toBeDefined();
  });

  test("define utility creates page definitions", () => {
    expect(define).toBeDefined();
    expect(define.page).toBeDefined();
    expect(typeof define.page).toBe("function");
  });

  test("test route renders without serialization errors", async () => {
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

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.includes("Test Page")).toBe(true);
  });

  test("static routes return proper responses", async () => {
    const handler = new App()
      .get("/health", () => new Response("OK", { status: 200 }))
      .handler();

    const request = new Request("http://localhost/health");
    const response = await handler(request);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK");
  });

  test("404 handling works correctly", async () => {
    const handler = new App()
      .get("/exists", () => new Response("exists"))
      .handler();

    const request = new Request("http://localhost/nonexistent");
    const response = await handler(request);

    expect(response.status).toBe(404);
  });

  test("app handles different HTTP methods", async () => {
    const handler = new App()
      .get("/resource", () => new Response("GET"))
      .post("/resource", () => new Response("POST"))
      .handler();

    const getReq = new Request("http://localhost/resource", { method: "GET" });
    const getRes = await handler(getReq);
    expect(await getRes.text()).toBe("GET");

    const postReq = new Request("http://localhost/resource", { method: "POST" });
    const postRes = await handler(postReq);
    expect(await postRes.text()).toBe("POST");
  });
});
