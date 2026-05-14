import { describe, expect, it } from "vitest";

import { dispatchReviewServerRequest } from "../src/extensions/plannotator/server/review-server-dispatch.ts";

function createJsonResponse(): {
  response: { statusCode: number; body: unknown };
  res: { writeHead: (status: number) => void; end: (chunk: string) => void };
} {
  const response = { statusCode: 200, body: undefined as unknown };
  return {
    response,
    res: {
      writeHead(status) {
        response.statusCode = status;
      },
      end(chunk) {
        response.body = JSON.parse(chunk);
      },
    },
  };
}

describe("plannotator AI capability route", () => {
  it("returns JSON unavailable instead of falling through to HTML", async () => {
    const { response, res } = createJsonResponse();

    await dispatchReviewServerRequest({
      req: { method: "GET" } as never,
      res: res as never,
      url: new URL("http://localhost/api/ai/capabilities"),
      state: {} as never,
      hasLocalAccess: true,
      isPRMode: () => false,
      isPRModeValue: false,
      prMetaPresent: false,
      prRefPresent: false,
      detectedCompareTarget: () => "main",
      options: {},
      prSwitchCache: new Map(),
      prStackTreeCache: new Map(),
      sharingPayload: {},
      diffPayload: { htmlContent: "<html>fallback</html>" },
      tour: { getTour: () => null, saveChecklist() {} },
      tourChecklistSchema: {} as never,
      syncStateFromLocals() {},
      syncLocalsFromState() {},
      agentJobs: { handle: async () => false },
      editorAnnotations: { handle: async () => false },
      externalAnnotations: { handle: async () => false },
      aiEndpoints: null,
      resolveAgentCwd: () => process.cwd(),
      getCurrentPatch: () => "",
      currentDiffType: "uncommitted" as never,
      draftKey: "draft",
      deleteDraft() {},
      resolveDecision() {},
    });

    expect(response).toEqual({
      statusCode: 200,
      body: { available: false, providers: [] },
    });
  });
});
