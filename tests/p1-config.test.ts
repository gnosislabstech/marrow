// P1 — src/config.ts is the genericization layer. The PUBLIC defaults must be
// neutral (no baked-in brand/owner) and default embedding to voyage-4; env
// overrides let an operator restore their own values. The name isn't load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

test("P1-config: public defaults are neutral and default to voyage-4", () => {
  // Positive assertions on the known-neutral defaults. We don't name any forbidden
  // brand/owner here — naming a value to assert its absence would itself leak it.
  assert.equal(DEFAULT_CONFIG.productName, "Marrow", "default product name (Marrow rename, 2026-07-23)");
  assert.equal(DEFAULT_CONFIG.cliName, "cb", "neutral cli name");
  assert.equal(DEFAULT_CONFIG.defaultOwner, "owner", "neutral owner key");
  assert.equal(DEFAULT_CONFIG.embeddingModel, "voyage-4", "default embedding = voyage-4");
});

test("P1-config: env overrides win over the defaults", () => {
  const keys = ["CB_PRODUCT_NAME", "DEFAULT_OWNER", "EMBEDDING_MODEL"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.env.CB_PRODUCT_NAME = "Acme";
    process.env.DEFAULT_OWNER = "alice";
    process.env.EMBEDDING_MODEL = "voyage-test";
    const c = loadConfig();
    assert.equal(c.productName, "Acme");
    assert.equal(c.defaultOwner, "alice");
    assert.equal(c.embeddingModel, "voyage-test");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
