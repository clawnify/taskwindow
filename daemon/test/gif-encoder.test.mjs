#!/usr/bin/env node
/**
 * Round-trip tests for the GIF89a encoder: encode synthetic frames, decode
 * the LZW stream back, and verify pixel indices and file structure.
 */
import assert from "node:assert";
import { createRequire } from "node:module";
import { encodeGif, lzwDecode } from "../../extension/offscreen/gif-encoder.js";

// gif-encoder.js is an ES module with no DOM dependencies, so it runs in Node;
// the test-only helpers below use CJS builtins via createRequire.
const require = createRequire(import.meta.url);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

function frameFromIndices(indices, width, height) {
  // Map palette indices back to web-safe RGB so encodeGif re-quantizes to the
  // same indices (the palette map is deterministic).
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = indices[i];
    rgba[i * 4 + 0] = Math.floor(idx / 36) * 51;
    rgba[i * 4 + 1] = (Math.floor(idx / 6) % 6) * 51;
    rgba[i * 4 + 2] = (idx % 6) * 51;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, width, height };
}

function extractLzwStreams(gif) {
  // Walk the GIF structure and pull out each frame's LZW byte stream.
  const streams = [];
  let p = 13; // header + LSD
  while (p < gif.length) {
    const b = gif[p++];
    if (b === 0x3b) break; // trailer
    if (b === 0x21) {
      p += 1; // label
      while (gif[p] !== 0) p += gif[p] + 1;
      p += 1;
    } else if (b === 0x2c) {
      p += 8; // left/top/w/h
      const packed = gif[p++];
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1)); // local color table
      const minCodeSize = gif[p++];
      const data = [];
      let size;
      while ((size = gif[p++]) !== 0) {
        for (let i = 0; i < size; i++) data.push(gif[p + i]);
        p += size;
      }
      streams.push({ minCodeSize, data: Uint8Array.from(data) });
    } else {
      throw new Error(`unexpected block 0x${b.toString(16)} at ${p - 1}`);
    }
  }
  return streams;
}

const B64 = (u8) => Buffer.from(u8).toString("base64");

test("header structure: signature, screen descriptor, trailer", () => {
  const gif = encodeGif([frameFromIndices(new Uint8Array(4 * 4).fill(0), 4, 4)], { delayMs: 100 });
  assert.equal(Buffer.from(gif.slice(0, 6)).toString(), "GIF89a");
  assert.equal(gif[6] | (gif[7] << 8), 4); // width
  assert.equal(gif[8] | (gif[9] << 8), 4); // height
  assert.equal(gif[10], 0x70); // no global color table
  assert.equal(gif[gif.length - 1], 0x3b); // trailer
});

test("round-trip: solid color frame", () => {
  const w = 16, h = 16;
  const indices = new Uint8Array(w * h).fill(120);
  const gif = encodeGif([frameFromIndices(indices, w, h)]);
  const [stream] = extractLzwStreams(gif);
  const decoded = lzwDecode(stream.minCodeSize, stream.data, w * h);
  assert.deepEqual(Buffer.from(decoded).compare(Buffer.from(indices)), 0);
});

test("round-trip: gradient + patterns (multi code-size growth)", () => {
  const w = 128, h = 128;
  const indices = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      indices[y * w + x] = (x * 6 + y * 3) % 216;
    }
  }
  const gif = encodeGif([frameFromIndices(indices, w, h)]);
  const [stream] = extractLzwStreams(gif);
  const decoded = lzwDecode(stream.minCodeSize, stream.data, w * h);
  assert.deepEqual(Buffer.from(decoded).compare(Buffer.from(indices)), 0);
});

test("round-trip: random noise crossing the 512-entry code-width boundary", () => {
  const w = 64, h = 64; // 4096 px, 6-color random noise -> short runs -> big table
  const indices = Uint8Array.from({ length: w * h }, (_, i) => (i * 7919) % 6);
  const gif = encodeGif([frameFromIndices(indices, w, h)]);
  const [stream] = extractLzwStreams(gif);
  assert.equal(stream.minCodeSize, 8);
  const decoded = lzwDecode(stream.minCodeSize, stream.data, w * h);
  assert.deepEqual(Buffer.from(decoded).compare(Buffer.from(indices)), 0);
});

test("round-trip: random bytes force table-full CLEAR codes", () => {
  const w = 100, h = 100; // 10000 random 216-color pixels -> dictionary overflows 4096
  const indices = Uint8Array.from({ length: w * h }, (_, i) => (i * 127 + 11) % 216);
  const gif = encodeGif([frameFromIndices(indices, w, h)]);
  const [stream] = extractLzwStreams(gif);
  const decoded = lzwDecode(stream.minCodeSize, stream.data, w * h);
  assert.deepEqual(Buffer.from(decoded).compare(Buffer.from(indices)), 0);
});

test("multi-frame animation: frame count, ordering, delay", () => {
  const w = 8, h = 8;
  const frames = [0, 100, 200].map((v) => frameFromIndices(new Uint8Array(w * h).fill(v), w, h));
  const gif = encodeGif(frames, { delayMs: 250 });
  // Two GCE blocks expected; delay 250ms -> 25cs little-endian.
  let gces = 0;
  for (let i = 0; i < gif.length - 1; i++) {
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9) {
      gces++;
      const delay = gif[i + 4] | (gif[i + 5] << 8);
      assert.equal(delay, 25, "GCE delay in centiseconds");
    }
  }
  assert.equal(gces, 3);
  const streams = extractLzwStreams(gif);
  assert.equal(streams.length, 3);
  for (const [i, stream] of streams.entries()) {
    const decoded = lzwDecode(stream.minCodeSize, stream.data, w * h);
    const expected = new Uint8Array(w * h).fill([0, 100, 200][i]);
    assert.deepEqual(Buffer.from(decoded).compare(Buffer.from(expected)), 0);
  }
});

test("macOS sips decodes the generated GIF (real-world decoder check)", () => {
  if (process.platform !== "darwin") {
    console.log("    skipped (sips is macOS-only)");
    return;
  }
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const w = 32, h = 32;
  const indices = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) indices[y * w + x] = (x * 21 + y * 7) % 216;
  const gif = encodeGif([frameFromIndices(indices, w, h)]);
  const tmp = fs.mkdtempSync("/tmp/agenttab-gif-");
  const file = `${tmp}/frame.gif`;
  fs.writeFileSync(file, gif);
  execFileSync("sips", ["-s", "format", "png", file, "--out", `${tmp}/frame.png`], { stdio: "pipe" });
  const png = fs.readFileSync(`${tmp}/frame.png`);
  assert.equal(png.readUInt32BE(16), w); // PNG IHDR width — sips really decoded it
  assert.equal(png.readUInt32BE(20), h);
});
