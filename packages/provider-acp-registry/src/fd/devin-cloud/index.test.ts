import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DEFAULT_DEVIN_CLOUD_SETTINGS, DevinCloudSettings } from "./index.ts";

const decode = Schema.decodeUnknownSync(DevinCloudSettings);
const encode = Schema.encodeSync(DevinCloudSettings);

describe("Devin Cloud settings", () => {
  it("keeps credentials out of config and bounds default session consumption", () => {
    expect(DEFAULT_DEVIN_CLOUD_SETTINGS).toEqual({
      enabled: false,
      organizationId: "",
      maxAcuLimit: 10,
      repos: [],
      devinMode: "normal",
    });
    expect(decode({ DEVIN_API_KEY: "test-only-secret" })).not.toHaveProperty("DEVIN_API_KEY");
  });

  it("accepts native settings and generic form strings with an editable round trip", () => {
    const native = decode({
      organizationId: " org-test ",
      maxAcuLimit: 25,
      repos: ["owner/first", " owner/second "],
      devinMode: "fast",
    });
    const form = {
      enabled: false,
      organizationId: "org-test",
      maxAcuLimit: "25",
      repos: "owner/first\nowner/second",
      devinMode: "fast",
    };

    expect(decode({ ...form, repos: " owner/first,\n owner/second \n" })).toEqual(native);
    expect(encode(native)).toEqual(form);
    expect(decode(encode(native))).toEqual(native);
  });

  it.each([0, -1, 1.5, Infinity, Number.NaN, "", "many", "1.5", "0", "-1"])(
    "rejects an invalid cloud spend limit: %s",
    (maxAcuLimit) => {
      expect(() => decode({ maxAcuLimit })).toThrow();
    },
  );
});
