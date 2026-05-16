import { describe, expect, it } from "vitest";
import { extractImageFromEvent } from "../src/extensions/openai-better/image.js";

describe("openai better image parsing", () => {
  it("ignores streaming partial image chunks", () => {
    const image = extractImageFromEvent(
      { type: "response.image_generation_call.partial_image", partial_image_b64: "partial" },
      "image/png",
    );

    expect(image).toBeUndefined();
  });

  it("extracts final image_generation_call result", () => {
    const image = extractImageFromEvent(
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_final",
          status: "completed",
          result: "final",
        },
      },
      "image/png",
    );

    expect(image).toMatchObject({
      id: "ig_final",
      status: "completed",
      data: "final",
      mimeType: "image/png",
    });
  });
});
