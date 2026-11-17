import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchNanoFlowNotes, fetchToolkitState, HostApiError, setToolEnabled } from "./host-api.js";

const tool = (id: string, enabled: boolean) => ({
  id,
  title: id,
  description: `${id} tool`,
  enabled,
});

const json = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("host api", () => {
  it("reads the catalog from a document-relative route", async () => {
    const fetchMock = vi.fn(async () => json({ tools: [tool("nested-skill", true)] }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = await fetchToolkitState();
    expect(tools).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("api/toolkit/state", expect.anything());
  });

  it("posts a toggle as JSON", async () => {
    const fetchMock = vi.fn(async () => json({ tools: [tool("nano-flow", false)] }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = await setToolEnabled("nano-flow", false);
    expect(tools[0]?.enabled).toBe(false);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"id":"nano-flow","enabled":false}');
  });

  it("reads the nano-flow notes snapshot with an encoded session id", async () => {
    const snapshot = {
      planName: "2026-11-08-演示",
      planPath: ".agents/domains/dsh/plans/active/2026-11-08-演示",
      notes: [
        { name: "001-第一个", status: "pending", description: "概述" },
        {
          name: "002-阻塞",
          status: "blocked",
          description: "卡住的概述",
          reason: "等待用户验收",
          nextStep: "重启后确认",
        },
      ],
    };
    const fetchMock = vi.fn(async () => json({ snapshot }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNanoFlowNotes("session a/b")).resolves.toEqual(snapshot);
    const [target] = fetchMock.mock.calls[0] as unknown as [string];
    expect(target).toBe("api/toolkit/nano-flow/notes?sessionId=session%20a%2Fb");
  });

  it("treats a null notes snapshot as empty and rejects malformed statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ snapshot: null })),
    );
    await expect(fetchNanoFlowNotes("s1")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          snapshot: {
            planName: "p",
            planPath: "p",
            notes: [{ name: "n", status: "unknown", description: "d" }],
          },
        }),
      ),
    );
    await expect(fetchNanoFlowNotes("s1")).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("drops a non-string reason or next step instead of failing the snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          snapshot: {
            planName: "p",
            planPath: "p",
            notes: [{ name: "n", status: "blocked", description: "d", reason: 42, nextStep: null }],
          },
        }),
      ),
    );
    await expect(fetchNanoFlowNotes("s1")).resolves.toEqual({
      planName: "p",
      planPath: "p",
      notes: [{ name: "n", status: "blocked", description: "d" }],
    });
  });

  it("surfaces host error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "unknown-tool", message: "nope" }, 400)),
    );
    await expect(setToolEnabled("nope", true)).rejects.toMatchObject({
      code: "unknown-tool",
      status: 400,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 502 })),
    );
    await expect(fetchToolkitState()).rejects.toBeInstanceOf(HostApiError);
  });

  it("rejects payloads that do not match the catalog shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ tools: "nope" })),
    );
    await expect(fetchToolkitState()).rejects.toMatchObject({ code: "invalid-response" });
  });
});
