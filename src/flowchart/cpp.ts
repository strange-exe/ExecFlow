// C++ source to flow models (tree-sitter-cpp trees): C's statements plus range for, try/catch and
// lambdas (one step each), throw (an end), classes, namespaces and templates (their functions get
// charts), and std::cout / std::cin as input and output.
import type { Node } from "web-tree-sitter";
import { chartCFamily } from "./cfamily";
import type { FlowFile } from "./model";
import type { Pick } from "./pick";

export const chartCpp = (root: Node, _source: string, pick: Pick | null | "all" = "all"): FlowFile => chartCFamily(root, { cpp: true }, pick);
