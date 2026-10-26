// C source to flow models (tree-sitter-c trees). The statement shapes are shared with C++.
import type { Node } from "web-tree-sitter";
import { chartCFamily } from "./cfamily";
import type { FlowFile } from "./model";

export const chartC = (root: Node, _source: string): FlowFile => chartCFamily(root, { cpp: false });
