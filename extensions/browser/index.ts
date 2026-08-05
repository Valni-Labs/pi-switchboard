import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConnectCommand } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	registerConnectCommand(pi);
}
