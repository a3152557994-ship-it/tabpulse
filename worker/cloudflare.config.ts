import { bindings, defineConfig, exports } from "@cloudflare/config";

export default defineConfig({
	worker: {
		name: "replyradar-edge",
		compatibilityDate: "2026-10-01",
		entrypoint: "./index.mjs",
		workersDev: true,
		env: {
			TUNNEL_BOX: bindings.durableObject({
				worker: "replyradar-edge",
				exportName: "TunnelBox",
			}),
		},
		exports: {
			TunnelBox: exports.durableObject({
				storage: "sqlite",
			}),
		},
	},
});
