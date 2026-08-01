import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeActiveBrowser } from "./session.ts";
import { registerBrowserTools, registerConnectCommand } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	registerBrowserTools(pi);
	registerConnectCommand(pi);
	pi.on("session_shutdown", () => {
		void closeActiveBrowser();
	});
}
