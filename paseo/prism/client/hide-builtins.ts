import { useSettings } from "@getpaseo/plugin/client";
import { useEffect } from "react";

import { prismSettings } from "../shared/settings.js";
import { setBuiltinHiding } from "./web.js";

/** Keeps the injected CSS in step with the host setting whenever a Prism surface is on screen. */
export function useSyncBuiltinHiding(): void {
  const settings = useSettings(prismSettings);
  const hide = settings.status === "ready" ? settings.values.hideBuiltinPanels : null;
  useEffect(() => {
    if (hide !== null) setBuiltinHiding(hide);
  }, [hide]);
}
