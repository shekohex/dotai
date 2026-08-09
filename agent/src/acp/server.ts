import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { AcpCommandOptions } from "./command.js";
import { createAcpV1Agent } from "./v1/agent.js";
import { createAcpV2Agent } from "./v2/agent.js";
import { AcpAgentCore } from "./core.js";
import { createProductionAcpDependencies } from "./session-store.js";

export async function runAcpServer(options: AcpCommandOptions): Promise<void> {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        protocolWrite(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  });
  const restoreStdout = redirectProcessStdoutToStderr();
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      process.stdin.once("end", () => {
        controller.close();
      });
      process.stdin.once("error", (error) => {
        controller.error(error);
      });
    },
    cancel() {
      process.stdin.pause();
    },
  });
  const stream = v1.ndJsonStream(output, input);
  const core = new AcpAgentCore(createProductionAcpDependencies());
  const router = v2.agentProtocolRouter().withV1(createAcpV1Agent(core));
  if (options.experimentalV2) {
    router.withV2(createAcpV2Agent(core));
  }
  const connection = router.connect(stream);
  try {
    await connection.closed;
  } finally {
    try {
      await core.dispose();
    } finally {
      restoreStdout();
    }
  }
}

function redirectProcessStdoutToStderr(): () => void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    if (typeof encodingOrCallback === "function") {
      return process.stderr.write(chunk, encodingOrCallback);
    }
    if (typeof chunk === "string") {
      return process.stderr.write(chunk, encodingOrCallback, callback);
    }
    return process.stderr.write(chunk, callback);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = originalWrite;
  };
}
