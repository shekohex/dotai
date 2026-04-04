import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { renderMermaidASCII } from "beautiful-mermaid"

const MERMAID_BLOCK_REGEX = /```mermaid\n([\s\S]*?)```/g

export const MermaidRenderer: Plugin = async () => {
  return {
    "experimental.text.complete": async (
      _input: { sessionID: string; messageID: string; partID: string },
      output: { text: string }
    ) => {
      try {
        output.text = renderMermaidBlocks(output.text)
      } catch (error) {
        output.text =
          output.text +
          "\n\n<!-- mermaid-renderer: unexpected error - " +
          (error as Error).message +
          " -->"
      }
    },
  } as Hooks
}

function renderMermaidBlocks(text: string): string {
  return text.replace(MERMAID_BLOCK_REGEX, (_match, mermaidCode: string) => {
    return renderSingleBlock(mermaidCode.trim())
  })
}

function renderSingleBlock(mermaidCode: string): string {
  try {
    const ascii = renderMermaidASCII(mermaidCode, { colorMode: "none" })

    return `\`\`\`\n${ascii}\n\`\`\``
  } catch (error) {
    const errorMessage = (error as Error).message || "Unknown error"
    return (
      "```mermaid\n" +
      mermaidCode +
      "\n```\n<!-- mermaid render failed: " +
      escapeHtmlComment(errorMessage) +
      " -->"
    )
  }
}

function escapeHtmlComment(text: string): string {
  return text.replace(/--/g, "- -").replace(/>/g, "&gt;")
}

export default MermaidRenderer
