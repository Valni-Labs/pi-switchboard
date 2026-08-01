import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConnectCommand } from "./connect.ts";
import { closeActiveBrowser, HEADED_FLAG, LOCAL_FLAG, registerBrowserTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	pi.registerFlag(LOCAL_FLAG, {
		description: "Drive browser connections with the local Playwright dev harness instead of Switchboard-hosted sessions",
		type: "boolean",
		default: false,
	});
	pi.registerFlag(HEADED_FLAG, {
		description: "Show the local browser harness window instead of running headless",
		type: "boolean",
		default: false,
	});
	registerBrowserTools(pi);
	registerConnectCommand(pi);
	pi.on("session_shutdown", () => {
		void closeActiveBrowser();
	});
}
