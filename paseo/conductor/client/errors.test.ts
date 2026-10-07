import { describe, expect, it } from "vitest";

import { errorMessage } from "./errors.js";

describe("errorMessage", () => {
  it("strips the plugin RPC envelope", () => {
    expect(
      errorMessage(
        new Error(
          "Request failed: notes.md changed since you opened it. Reload it and try again requestType=plugin.rpc.invoke.request code=handler_error",
        ),
      ),
    ).toBe("notes.md changed since you opened it. Reload it and try again");
    expect(errorMessage("plain")).toBe("plain");
  });
});
