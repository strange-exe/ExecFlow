// C source to flow models (tree-sitter-c trees). The statement shapes are shared with C++.
import type { Node } from "web-tree-sitter";
import { chartCFamily } from "./cfamily";
import type { FlowFile } from "./model";
import type { Pick } from "./pick";

export const chartC = (root: Node, _source: string, pick: Pick | null | "all" = "all"): FlowFile => chartCFamily(root, { cpp: false }, pick);
