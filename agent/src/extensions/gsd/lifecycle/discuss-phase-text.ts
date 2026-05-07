export function buildTextSelectPrompt(title: string, options: string[]): string {
  return [
    title,
    "Reply in plain text with one option name exactly as written:",
    ...options.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

export function buildTextInputPrompt(title: string, placeholder: string): string {
  return [title, "Reply in plain text.", `Hint: ${placeholder}`].join("\n");
}

export function createTextReplyReader(initialReply: string | undefined): {
  consume: () => string | undefined;
} {
  let pendingReply = initialReply?.trim();
  return {
    consume() {
      if (pendingReply === undefined || pendingReply.length === 0) {
        const emptyReply = pendingReply;
        pendingReply = undefined;
        return emptyReply;
      }
      const reply = pendingReply;
      pendingReply = undefined;
      return reply;
    },
  };
}

export function parseTextSelectReply(reply: string, options: string[]): string | undefined {
  const normalizedReply = reply.trim();
  const numericSelection = Number(normalizedReply);
  if (
    Number.isInteger(numericSelection) &&
    numericSelection >= 1 &&
    numericSelection <= options.length
  ) {
    return options[numericSelection - 1];
  }
  return options.find((option) => option.toLowerCase() === normalizedReply.toLowerCase());
}
