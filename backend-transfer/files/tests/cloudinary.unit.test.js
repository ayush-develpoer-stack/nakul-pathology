/**
 * services/cloudinary.service.js — real service logic, no network.
 * FAKE credentials only; cloudinary.uploader.upload is mocked, and
 * private_download_url only computes a signature locally.
 */
require("./helpers/setup");
const { test, describe, mock, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FAKE_SECRET = "fake_cloudinary_secret_for_tests_0000";

function freshService(configured) {
  Object.assign(process.env, {
    CLOUDINARY_CLOUD_NAME: configured ? "fake-cloud" : "",
    CLOUDINARY_API_KEY: configured ? "000000000000000" : "",
    CLOUDINARY_API_SECRET: configured ? FAKE_SECRET : "",
  });
  for (const k of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](config[\\/](env|cloudinary)|services[\\/]cloudinary\.service)\.js$/.test(k)) delete require.cache[k];
  }
  const svc = require("../src/services/cloudinary.service");
  const { cloudinary } = require("../src/config/cloudinary");
  return { svc, cloudinary };
}

function tempFile() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cld-")), "report.pdf");
  fs.writeFileSync(p, "%PDF-1.4 synthetic");
  return p;
}
const gone = async (p) => {
  for (let i = 0; i < 50 && fs.existsSync(p); i += 1) await new Promise((r) => setTimeout(r, 10));
  return !fs.existsSync(p);
};

afterEach(() => mock.restoreAll());

describe("Cloudinary service (configured with fake credentials)", () => {
  test("upload: authenticated delivery by default, mapped result, temp file removed", async () => {
    const { svc, cloudinary } = freshService(true);
    const calls = [];
    mock.method(cloudinary.uploader, "upload", async (p, opts) => {
      calls.push(opts);
      return { secure_url: "https://res.example.test/x", public_id: "nakul/reports/x", resource_type: "image", type: "authenticated", format: "pdf" };
    });
    const p = tempFile();
    const out = await svc.uploadFile(p, "nakul/reports");
    assert.deepEqual(calls[0], { folder: "nakul/reports", resource_type: "auto", type: "authenticated" });
    assert.deepEqual(out, { url: "https://res.example.test/x", publicId: "nakul/reports/x", resourceType: "image", deliveryType: "authenticated", format: "pdf" });
    assert.ok(await gone(p), "temp file deleted after success");
  });

  test("upload failure: error propagates and the temp file is still removed", async () => {
    const { svc, cloudinary } = freshService(true);
    mock.method(cloudinary.uploader, "upload", async () => {
      throw new Error("network down");
    });
    const p = tempFile();
    await assert.rejects(svc.uploadFile(p), /network down/);
    assert.ok(await gone(p), "temp file deleted after failure");
  });

  test("signed download URL: short expiry, signed, never contains the API secret", () => {
    const { svc } = freshService(true);
    const before = Math.floor(Date.now() / 1000);
    const url = svc.generateSignedDownloadUrl({ publicId: "nakul/reports/x", format: "pdf" });
    const u = new URL(url);
    const exp = Number(u.searchParams.get("expires_at"));
    assert.ok(exp >= before + 299 && exp <= before + 302, `expires_at ${exp}`);
    assert.ok(u.searchParams.get("signature"), "signed");
    assert.equal(u.searchParams.get("type"), "authenticated");
    assert.ok(!url.includes(FAKE_SECRET), "secret never in the URL");
    assert.equal(svc.generateSignedDownloadUrl({ publicId: "" }), "", "no public id → no URL");
    const longer = new URL(svc.generateSignedDownloadUrl({ publicId: "a", expiresInSeconds: 60 }));
    assert.ok(Number(longer.searchParams.get("expires_at")) <= before + 62);
  });
});

describe("Cloudinary service (not configured)", () => {
  test("upload gives a clear error without calling Cloudinary; signed URL is empty; delete is a no-op", async () => {
    const { svc, cloudinary } = freshService(false);
    const upload = mock.method(cloudinary.uploader, "upload", async () => ({}));
    const destroy = mock.method(cloudinary.uploader, "destroy", async () => ({}));
    await assert.rejects(svc.uploadFile(tempFile()), /not configured/);
    assert.equal(upload.mock.callCount(), 0);
    assert.equal(svc.generateSignedDownloadUrl({ publicId: "x" }), "");
    await svc.deleteFile("x");
    assert.equal(destroy.mock.callCount(), 0);
  });
});
