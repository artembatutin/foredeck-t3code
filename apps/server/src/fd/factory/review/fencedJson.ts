import { FactoryReview } from "@t3tools/contracts/fd/factory";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The review in a reviewer's final message, for providers without t3 MCP tools. A decode
 * failure's message goes back to the reviewer like a submission's validation problems.
 */
export type FactoryFencedReview =
  | { readonly status: "none" }
  | { readonly status: "decoded"; readonly review: FactoryReview }
  | { readonly status: "decode_failed"; readonly message: string };

const MAX_MESSAGE = 1000;

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
// Every issue at once: the reviewer gets one corrected retry.
const decodeReview = Schema.decodeUnknownResult(FactoryReview, { errors: "all" });

const fenceOpen = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>.*)$/;
const fenceClose = /^ {0,3}(?<fence>`{3,}|~{3,})\s*$/;

/**
 * The body of the last fenced block whose info string is `json`. Fences follow CommonMark, so a
 * ```json line inside a longer or other fence is content, and an unclosed block runs to the end.
 */
const lastJsonBlock = (message: string): string | undefined => {
  let last: string | undefined;
  let open: { readonly fence: string; readonly json: boolean; readonly body: string[] } | null =
    null;
  for (const line of message.split(/\r?\n/)) {
    if (open === null) {
      const { fence = "", info = "" } = fenceOpen.exec(line)?.groups ?? {};
      // A backtick fence's info string cannot contain a backtick (inline code, not a fence).
      if (fence === "" || (fence.startsWith("`") && info.includes("`"))) continue;
      open = { fence, json: info.trim().split(/\s+/)[0]?.toLowerCase() === "json", body: [] };
      continue;
    }
    const close = fenceClose.exec(line)?.groups?.fence ?? "";
    if (close.startsWith(open.fence.charAt(0)) && close.length >= open.fence.length) {
      if (open.json) last = open.body.join("\n");
      open = null;
    } else {
      open.body.push(line);
    }
  }
  if (open?.json) last = open.body.join("\n");
  return last;
};

const bounded = (message: string) =>
  message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;

/** Decodes the last ```json block of `message` as a review; never throws. */
export const parseFencedReview = (message: string): FactoryFencedReview => {
  const block = lastJsonBlock(message);
  if (block === undefined) return { status: "none" };
  const json = decodeJson(block);
  if (Result.isFailure(json)) {
    return {
      status: "decode_failed",
      message: bounded(`The last json block is not valid JSON: ${json.failure.message}`),
    };
  }
  const review = decodeReview(json.success);
  if (Result.isFailure(review)) {
    return {
      status: "decode_failed",
      message: bounded(`The last json block is not a valid review: ${review.failure.message}`),
    };
  }
  return { status: "decoded", review: review.success };
};
