import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveMobileMarkdownMediaSource } from "./markdownMediaSource";

describe("mobile Markdown draft media", () => {
  it("authorizes relative images and videos against the draft directory", () => {
    for (const name of ["diagram.svg", "clip.mp4"]) {
      expect(
        resolveMobileMarkdownMediaSource(`./${name}`, {
          threadId: undefined,
          workspaceRoot: "/project/docs",
          imageEmbed: true,
        }),
      ).toMatchObject({
        access: "environment",
        resource: {
          _tag: "draft-workspace-file",
          cwd: "/project/docs",
          path: `/project/docs/./${name}`,
        },
      });
    }
  });

  it("keeps thread authorization when a thread exists", () => {
    const threadId = ThreadId.make("markdown-thread");
    expect(
      resolveMobileMarkdownMediaSource("image.png", { threadId, workspaceRoot: "/project" }),
    ).toMatchObject({ resource: { _tag: "media-file", threadId, path: "/project/image.png" } });
  });

  it("keeps an explicit repository on nested file media and draft previews", () => {
    const target = {
      type: "thread" as const,
      threadId: ThreadId.make("thread"),
      repositoryId: "client",
    };
    expect(
      resolveMobileMarkdownMediaSource("diagram.svg", {
        workspaceRoot: "/separate/client/docs",
        repositoryTarget: target,
        threadId: undefined,
      }),
    ).toMatchObject({
      access: "environment",
      resource: {
        _tag: "repository-file",
        repositoryTarget: target,
        path: "/separate/client/docs/diagram.svg",
      },
    });
  });

  it("keeps direct URLs direct and rejects unresolvable or blocked references", () => {
    const input = { threadId: undefined, workspaceRoot: "/project" };
    expect(resolveMobileMarkdownMediaSource("https://example.com/image.png", input)).toMatchObject({
      access: "direct",
      uri: "https://example.com/image.png",
    });
    expect(resolveMobileMarkdownMediaSource("javascript:alert(1)", input)).toBeNull();
    expect(resolveMobileMarkdownMediaSource("image.png", { threadId: undefined })).toBeNull();
  });
});
