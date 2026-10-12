import test from "node:test";
import assert from "node:assert/strict";
import apiError from "../api-error.js";

test("only actual rate-limit responses pause polling", () => {
  const notQuota = 'Webull OPRA snapshot failed: {"traceId":"f724291-c598-46a5-afc3-a262c40bbb46","httpCode":404,"code":"INTERNAL_SERVER_ERROR"}';
  assert.equal(apiError.isRateLimited(notQuota), false);
  assert.equal(apiError.isRateLimited({ status: 404, message: "429 inside traceId" }), false);
  assert.equal(apiError.isRateLimited('Webull failed: {"httpCode":429,"code":"TOO_MANY_REQUESTS"}'), true);
  assert.equal(apiError.isRateLimited("HTTP 429 Too Many Requests"), true);
  assert.equal(apiError.isRateLimited("rate limit exceeded"), true);
});

test("unavailable option API is explained without exposing a trace ID", () => {
  const failure = 'Webull option contracts failed: {"traceId":"private-trace","httpCode":404,"code":"INTERNAL_SERVER_ERROR"}';
  assert.match(apiError.describe(failure), /Webull OpenAPI.*Option.*404/);
  assert.doesNotMatch(apiError.describe(failure), /private-trace/);
  assert.equal(apiError.describe("Other source failure"), "Other source failure");
  assert.match(apiError.describe('QQQ: Webull bars failed: {"traceId":"private-trace","httpCode":404}'), /แท่งราคาหุ้นชุดใหม่.*404/);
});
