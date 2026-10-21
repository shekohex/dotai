export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
}

export interface TreeRow {
  key: string;
  path: string;
  /** Display name; collapsed single-child directory chains read `a/b/c`. */
  name: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
}

export function buildTrie(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: new Map() };
  for (const entry of paths) {
    // A trailing slash marks a directory listed without its contents.
    const endsInDir = entry.endsWith("/");
    const path = endsInDir ? entry.slice(0, -1) : entry;
    const parts = path.split("/");
    let node = root;
    let current = "";
    parts.forEach((part, index) => {
      current = current === "" ? part : `${current}/${part}`;
      const isDir = endsInDir || index < parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: current, isDir, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}

/** Flattens the trie into visible rows, given which directories are open. */
export function flattenTrie(root: TreeNode, isExpanded: (dirPath: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (node: TreeNode, depth: number) => {
    for (const child of sortedChildren(node)) {
      let current = child;
      let name = child.name;
      while (current.isDir && current.children.size === 1) {
        const only = current.children.values().next().value as TreeNode;
        if (!only.isDir) break;
        name = `${name}/${only.name}`;
        current = only;
      }
      const expanded = current.isDir && isExpanded(current.path);
      rows.push({ key: current.path, path: current.path, name, isDir: current.isDir, depth, expanded });
      if (expanded) visit(current, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}
