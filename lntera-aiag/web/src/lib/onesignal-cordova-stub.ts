// Web/Electron stub for the native-only `onesignal-cordova-plugin`. The web Vite build aliases
// the plugin to this file so its cordova code never bundles into the browser app. It is never
// executed (initPush guards on Capacitor.isNativePlatform()); the native build uses the real plugin.
const noop = (): void => {};

export default {
  initialize: noop,
  login: noop,
  logout: noop,
  User: { addTag: noop, removeTag: noop },
  Notifications: { requestPermission: async (): Promise<boolean> => false, addEventListener: noop },
};
