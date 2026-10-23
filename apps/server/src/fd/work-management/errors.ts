import {
  type WorkItemSummary,
  WorkError,
  type WorkTransition,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

import { WorkPermissionDenied } from "./authority.ts";

/**
 * Domain errors shared by the service and every source adapter. Messages are built from
 * attributes, never from a cause; a host's own message is bounded before it travels. Transport
 * handlers map all of them to the wire `WorkError` with `toWorkError`.
 */

export class WorkSourceNotFound extends Schema.TaggedError<WorkSourceNotFound>()(
  "WorkSourceNotFound",
  { sourceId: WorkSourceId },
) {
  override get message(): string {
    return `Work source ${this.sourceId} does not exist on this environment.`;
  }
}

export class WorkItemNotFound extends Schema.TaggedError<WorkItemNotFound>()("WorkItemNotFound", {
  itemId: Schema.String,
  /** Where the item went, when the source said (a transferred GitHub issue). */
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail === undefined
      ? `Work item ${this.itemId} was not found.`
      : `Work item ${this.itemId} was not found: ${this.detail}`;
  }
}

/** The caller's revision no longer matches; `current` is the item as it is now. */
export class WorkStale extends Schema.TaggedError<WorkStale>()("WorkStale", {
  itemId: Schema.String,
  current: Schema.optionalKey(Schema.Unknown),
}) {
  override get message(): string {
    return `Work item ${this.itemId} changed since it was loaded; reload it and apply the edit again.`;
  }
}

/** The caller's source version no longer matches; reload the source and try again. */
export class WorkSourceStale extends Schema.TaggedError<WorkSourceStale>()("WorkSourceStale", {
  sourceId: WorkSourceId,
}) {
  override get message(): string {
    return `Work source ${this.sourceId} changed since it was loaded; reload it and try again.`;
  }
}

/** The request is ambiguous or collides with existing state. */
export class WorkConflict extends Schema.TaggedError<WorkConflict>()("WorkConflict", {
  detail: Schema.String,
  candidates: Schema.optionalKey(Schema.Unknown),
}) {
  override get message(): string {
    return this.detail;
  }
}

export class WorkUnsupported extends Schema.TaggedError<WorkUnsupported>()("WorkUnsupported", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class WorkInvalid extends Schema.TaggedError<WorkInvalid>()("WorkInvalid", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** The source is disconnected, unreadable or unreachable right now. */
export class WorkUnavailable extends Schema.TaggedError<WorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export class WorkUnauthenticated extends Schema.TaggedError<WorkUnauthenticated>()(
  "WorkUnauthenticated",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The source refused the credential this request (a permission, not an expired token). */
export class WorkForbidden extends Schema.TaggedError<WorkForbidden>()("WorkForbidden", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class WorkRateLimited extends Schema.TaggedError<WorkRateLimited>()("WorkRateLimited", {
  retryAt: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.retryAt === undefined
      ? "The source is rate limiting requests; try again later."
      : `The source is rate limiting requests until ${this.retryAt}.`;
  }
}

export type WorkDomainError =
  | WorkPermissionDenied
  | WorkSourceNotFound
  | WorkItemNotFound
  | WorkStale
  | WorkSourceStale
  | WorkConflict
  | WorkUnsupported
  | WorkInvalid
  | WorkUnavailable
  | WorkUnauthenticated
  | WorkForbidden
  | WorkRateLimited;

const HOST_MESSAGE_LIMIT = 500;

/** Bounds a host's own message before it becomes an attribute. */
export const boundedHostMessage = (message: string): string =>
  message.length > HOST_MESSAGE_LIMIT ? `${message.slice(0, HOST_MESSAGE_LIMIT)}…` : message;

/** The wire error for one domain error. The transport is the only caller. */
export const toWorkError = (error: WorkDomainError): WorkError => {
  switch (error._tag) {
    case "WorkPermissionDenied":
      return new WorkError({ reason: "forbidden", message: error.message });
    case "WorkSourceNotFound":
    case "WorkItemNotFound":
      return new WorkError({ reason: "not_found", message: error.message });
    case "WorkStale":
      return new WorkError({
        reason: "stale",
        message: error.message,
        ...(error.current === undefined ? {} : { current: error.current as WorkItemSummary }),
      });
    case "WorkSourceStale":
      return new WorkError({ reason: "stale", message: error.message });
    case "WorkConflict":
      return new WorkError({
        reason: "conflict",
        message: error.message,
        ...(error.candidates === undefined
          ? {}
          : { candidates: error.candidates as ReadonlyArray<WorkTransition> }),
      });
    case "WorkUnsupported":
      return new WorkError({ reason: "unsupported", message: error.message });
    case "WorkInvalid":
      return new WorkError({ reason: "invalid_request", message: error.message });
    case "WorkUnavailable":
      return new WorkError({ reason: "unavailable", message: error.message });
    case "WorkUnauthenticated":
      return new WorkError({ reason: "unauthenticated", message: error.message });
    case "WorkForbidden":
      return new WorkError({ reason: "forbidden", message: error.message });
    case "WorkRateLimited":
      return new WorkError({
        reason: "rate_limited",
        message: error.message,
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      });
  }
};
