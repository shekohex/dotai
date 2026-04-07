#!/usr/bin/env node

import {
	DefaultResourceLoader,
	type ExtensionFactory,
	main,
} from "@mariozechner/pi-coding-agent";
import { bundledExtensionFactories } from "./extensions/index.js";

const prototypePatched = Symbol.for("@shekohex/agent/default-resource-loader-patched");

type LoaderPatchState = {
	extensionFactories?: ExtensionFactory[];
	__shekohexBundledExtensionsInstalled?: boolean;
};

type LoaderPrototype = {
	reload(this: LoaderPatchState): Promise<void>;
	[prototypePatched]?: boolean;
};

process.title = "pi";

installBundledExtensionFactories(bundledExtensionFactories);

await main(process.argv.slice(2));

function installBundledExtensionFactories(factories: ExtensionFactory[]): void {
	const loaderPrototype = DefaultResourceLoader.prototype as unknown as LoaderPrototype;

	if (loaderPrototype[prototypePatched]) {
		return;
	}

	const originalReload = loaderPrototype.reload;
	loaderPrototype.reload = async function patchedReload(this: LoaderPatchState): Promise<void> {
		if (!this.__shekohexBundledExtensionsInstalled) {
			this.extensionFactories = [...(this.extensionFactories ?? []), ...factories];
			this.__shekohexBundledExtensionsInstalled = true;
		}

		await originalReload.call(this);
	};

	loaderPrototype[prototypePatched] = true;
}
