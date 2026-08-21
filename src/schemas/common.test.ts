/**
 * Tests for the shared Zod fragments.
 *
 * These fields are the boundary between the model and the API: their defaults
 * are what a tool gets when the model omits an argument, and their bounds are
 * what stops a bad argument reaching Atlassian.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import {
  ResponseFormat,
  alertIdField,
  limitField,
  noteField,
  offsetField,
  responseFormatField,
  sourceField,
  userField,
} from "./common.js";

describe("limitField", () => {
  it("defaults to DEFAULT_LIMIT when the model omits it", () => {
    assert.equal(limitField.parse(undefined), DEFAULT_LIMIT);
  });

  it("accepts the full documented range", () => {
    assert.equal(limitField.parse(1), 1);
    assert.equal(limitField.parse(MAX_LIMIT), MAX_LIMIT);
  });

  it("rejects values outside the range the API accepts", () => {
    assert.throws(() => limitField.parse(0), z.ZodError);
    assert.throws(() => limitField.parse(MAX_LIMIT + 1), z.ZodError);
  });

  it("rejects a fractional limit", () => {
    assert.throws(() => limitField.parse(10.5), z.ZodError);
  });
});

describe("offsetField", () => {
  it("defaults to the first page", () => {
    assert.equal(offsetField.parse(undefined), 0);
  });

  it("rejects a negative offset", () => {
    assert.throws(() => offsetField.parse(-1), z.ZodError);
  });

  it("has no upper bound of its own — the window guard owns that", () => {
    assert.equal(offsetField.parse(19_999), 19_999);
  });
});

describe("responseFormatField", () => {
  it("defaults to markdown, the compact form", () => {
    assert.equal(responseFormatField.parse(undefined), ResponseFormat.MARKDOWN);
  });

  it("accepts json", () => {
    assert.equal(responseFormatField.parse("json"), ResponseFormat.JSON);
  });

  it("rejects an unknown format", () => {
    assert.throws(() => responseFormatField.parse("yaml"), z.ZodError);
  });
});

describe("alertIdField", () => {
  it("accepts a full uuid-timestamp id", () => {
    const id = "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350";
    assert.equal(alertIdField.parse(id), id);
  });

  it("rejects an empty id", () => {
    assert.throws(() => alertIdField.parse(""), z.ZodError);
  });

  it("says in its description that tinyId is not accepted", () => {
    // The model reads this description; it is the main defence against
    // repeated 404s from passing the short id shown in the JSM UI.
    assert.match(alertIdField.description ?? "", /NOT the short tinyId/);
  });
});

describe("noteField", () => {
  it("rejects an empty note", () => {
    assert.throws(() => noteField.parse(""), z.ZodError);
  });

  it("accepts a note at the 25,000 character cap", () => {
    assert.equal(noteField.parse("x".repeat(25_000)).length, 25_000);
  });

  it("rejects a note over the cap rather than letting the API reject it", () => {
    assert.throws(() => noteField.parse("x".repeat(25_001)), z.ZodError);
  });
});

describe("userField / sourceField", () => {
  it("are optional, defaulting to the credential owner and no source label", () => {
    assert.equal(userField.parse(undefined), undefined);
    assert.equal(sourceField.parse(undefined), undefined);
  });

  it("pass a supplied value through", () => {
    assert.equal(userField.parse("ada@example.com"), "ada@example.com");
    assert.equal(sourceField.parse("claude-mcp"), "claude-mcp");
  });
});
