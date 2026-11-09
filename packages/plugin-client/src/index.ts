export { PluginClientContextError } from "./context.js";
export {
  CLIENT_API_VERSION,
  type ClientComponent,
  type ClientExtension,
  type ClientExtensionDefinition,
  type ComponentProps,
  defineClientExtension,
  defineComponent,
} from "./define.js";
export {
  Badge,
  Button,
  Icon,
  Kbd,
  KeyValue,
  Logo,
  PropertySection,
  Spinner,
  Stack,
  Text,
  Tooltip,
  ViewBlocks,
} from "./design.js";
export {
  useAccess,
  useAction,
  useAssetUrl,
  useCapybaraEvents,
  useClientStorage,
  useLocale,
  usePrefersReducedMotion,
  useRunState,
  useTheme,
  useView,
} from "./hooks.js";
export type { ComponentSlotId } from "./slots.generated.js";
export type {
  BaseComponentProps,
  CapybaraEvent,
  CapybaraEventOf,
  CapybaraEventType,
  ClientApi,
  ClientStorage,
  RunState,
  SlotComponentProps,
} from "./types.js";
