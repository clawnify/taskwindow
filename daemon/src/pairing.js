import { randomBytes } from "node:crypto";

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function createCode() {
  return Array.from(randomBytes(6))
    .map((byte) => PAIR_ALPHABET[byte % PAIR_ALPHABET.length])
    .join("");
}

/** Short-lived, single-use codes for exchanging the daemon token. */
export class PairingManager {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), generateCode = createCode } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.generateCode = generateCode;
    this.code = null;
    this.expiresAt = 0;
  }

  issue() {
    this.code = this.generateCode();
    this.expiresAt = this.now() + this.ttlMs;
    return {
      code: this.code,
      expiresAt: new Date(this.expiresAt).toISOString(),
      expiresInSeconds: Math.ceil(this.ttlMs / 1000),
    };
  }

  claim(candidate) {
    const normalized = String(candidate || "").trim().toUpperCase();
    if (!this.code || this.now() >= this.expiresAt || normalized !== this.code) return false;
    this.code = null;
    this.expiresAt = 0;
    return true;
  }
}

