/**
 * The token the extension host finds `DeviceAccessService` by at the time of use (`ModuleRef`):
 * a symbol in a file of its own, so the host never imports the service's module graph (which
 * imports the host back).
 */
export const DEVICE_ACCESS_BACKEND = Symbol("DEVICE_ACCESS_BACKEND");
