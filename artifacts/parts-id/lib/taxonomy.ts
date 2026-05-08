/**
 * Pure helpers for the BrowseTaxonomy drill-down state machine.
 *
 * Lives in a non-`.tsx` file so jest's node environment can import it
 * without needing a JSX transform or React Native runtime.
 */

export interface CategoryTreeNode {
  id: number;
  slug: string;
  name: string;
  level: string;
  sortOrder: number;
  itemCount: number;
  children: CategoryTreeNode[];
}

/** Walk `path` (array of slugs) down the tree and return the node, or null. */
export function nodeAtPath(tree: CategoryTreeNode[], path: string[]): CategoryTreeNode | null {
  let level = tree;
  let node: CategoryTreeNode | null = null;
  for (const slug of path) {
    const found = level.find((n) => n.slug === slug);
    if (!found) return null;
    node = found;
    level = found.children;
  }
  return node;
}

/** Children visible at the current drill depth (roots when path is empty). */
export function visibleChildren(tree: CategoryTreeNode[], path: string[]): CategoryTreeNode[] {
  if (path.length === 0) return tree;
  const node = nodeAtPath(tree, path);
  return node?.children ?? [];
}
