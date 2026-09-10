import test from "node:test";
import assert from "node:assert/strict";
import { PairingManager } from "../src/pairing.js";

test("pairing codes are short-lived and single-use", () => {
  let now = 1_000;
  const pairing = new PairingManager({
    ttlMs: 5_000,
    now: () => now,
    generateCode: () => "ABC234",
  });
  const issued = pairing.issue();
  assert.equal(issued.code, "ABC234");
  assert.equal(pairing.claim("wrong2"), false);
  assert.equal(pairing.claim("abc234"), true);
  assert.equal(pairing.claim("ABC234"), false);

  pairing.issue();
  now += 5_000;
  assert.equal(pairing.claim("ABC234"), false);
});

test("issuing a code invalidates the one before it", () => {
  // Why the installer never mints a fallback code on the unpacked path: the
  // code it wrote into the extension's folder would stop working.
  const codes = ["FIRST2", "SECOND"];
  const pairing = new PairingManager({ generateCode: () => codes.shift() });
  assert.equal(pairing.issue().code, "FIRST2");
  assert.equal(pairing.issue().code, "SECOND");
  assert.equal(pairing.claim("FIRST2"), false);
  assert.equal(pairing.claim("SECOND"), true);
});

