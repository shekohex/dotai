import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

import { webBundleRpc } from "../shared/contracts.js";
import type { FileIconProps, PierreApi, PierreView } from "../shared/pierre-api.js";

const CHUNK_CHARS = 512 * 1024;

/**
 * Pierre's DOM components, loaded from the daemon on web and desktop only. `null` while loading,
 * on native, or when this browser cannot run them; callers then draw the React Native renderers.
 */
export function usePierre(): PierreApi | null {
  const fetchChunk = useRpc(webBundleRpc);
  const query = useQuery({
    queryKey: ["prism", "pierre"],
    enabled: Platform.OS === "web",
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<PierreApi> => {
      let source = "";
      let total = Infinity;
      while (source.length < total) {
        const part = await fetchChunk({ offset: source.length, length: CHUNK_CHARS });
        total = part.total;
        source += part.chunk;
      }
      const loaded = new Function(`${source}\nreturn PrismPierre;`)() as { default: PierreApi };
      return loaded.default;
    },
  });
  return query.data?.supported ? query.data : null;
}

/** Hosts a Pierre view inside a View. Memoize `props`; the view is rebuilt only when `create` changes. */
export function PierreMount<Props>({
  create,
  props,
  style,
}: {
  create: (host: unknown, props: Props) => PierreView<Props>;
  props: Props;
  style?: StyleProp<ViewStyle>;
}): ReactElement {
  const nodeRef = useRef<View>(null);
  const viewRef = useRef<PierreView<Props> | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!nodeRef.current) return;
    const view = create(nodeRef.current, latest.current);
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [create]);

  useEffect(() => {
    viewRef.current?.update(props);
  }, [props]);

  return <View ref={nodeRef} style={style} />;
}

/** A file-type icon from Pierre's icon set. */
export function PierreFileIcon({ api, ...props }: { api: PierreApi } & FileIconProps): ReactElement {
  const create = useCallback(
    (host: unknown, initial: FileIconProps) => api.createFileIcon(host, initial),
    [api],
  );
  const { name, size, appearance, muted } = props;
  const iconProps = useMemoProps({ name, size, appearance, muted });
  return <PierreMount create={create} props={iconProps} style={{ width: size, height: size }} />;
}

function useMemoProps<T extends object>(value: T): T {
  const ref = useRef(value);
  if (Object.keys(value).some((key) => (value as Record<string, unknown>)[key] !== (ref.current as Record<string, unknown>)[key])) {
    ref.current = value;
  }
  return ref.current;
}
