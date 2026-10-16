import type { ReactNode } from "react";

export interface NodeProps<P = Record<string, any>> {
  props: P;
  renderNode: (value: unknown) => ReactNode;
}

export type NodeComponent = (node: NodeProps) => ReactNode;
