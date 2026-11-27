/**
 * The token the extension host finds `PluginReadsService` by at the time of use (`ModuleRef`): a
 * symbol in a file of its own, so the host never imports the service's module graph.
 */
export const PLUGIN_READS_BACKEND = Symbol("PLUGIN_READS_BACKEND");
