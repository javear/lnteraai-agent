// English strings. Keys are namespaced by area (common.*, nav.*, chat.*, settings.*, …). Keep this file
// and id.ts in lockstep — every key here should have an entry in id.ts. Missing keys fall back to English
// then to the key itself, so the app never shows a blank label.
export const en: Record<string, string> = {
  // Common / shared
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.saving': 'Saving…',
  'common.retry': 'Retry',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.back': 'Back',
  'common.online': 'Online',
  'common.offline': 'Offline',
  'common.offlineBanner': 'You’re offline — showing cached data',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',

  // Language
  'language.title': 'Language',
  'language.description': 'Language for the app and the assistant’s replies.',
  'language.save': 'Save language',
  'language.saved': 'Language updated.',
  'language.error': 'Could not change language.',

  // Navigation / app chrome
  'nav.chat': 'Chat',
  'nav.integrations': 'Integrations',
  'nav.navigation': 'Navigation',
  'nav.openMenu': 'Open menu',
  'nav.theme': 'Theme',
  'nav.account': 'Account',
  'nav.settings': 'Settings',
  'nav.notificationSettings': 'Notification settings',
  'nav.signOut': 'Sign out',
  'nav.notifications': 'Notifications',
  'nav.chats': 'Chats',
  'nav.connections': 'Connections',
  'nav.connected': 'Connected',
  'nav.noChats': 'No chats yet. Start a new one.',
  'nav.deleteChat': 'Delete chat',
  'nav.chatDeleted': 'Chat deleted',
  'nav.chatDeleteError': 'Could not delete chat',
  'nav.notConnected': 'Not connected',
  'nav.integrationsConnected': 'Integrations connected',
  'nav.noIntegrationsConnected': 'No integrations connected',

  // Active Agent settings modal
  'settings.title': 'Active Agent settings',

  // Chat / composer
  'chat.newChat': 'New chat',
  'chat.placeholder': 'Message the agent…',
  'chat.send': 'Send',
  'chat.stop': 'Stop',
  'chat.empty.title': 'How can I help with your business?',
  'chat.empty.subtitle': 'Ask about orders, products, fulfillment, and your connected shops.',
  'chat.noResponse': 'I didn’t get a response — please try again.',
  'chat.error.start': 'Could not start a new chat. Check your connection and try again.',
  'chat.loadingOlder': 'Loading older messages…',
  'chat.placeholder.offline': 'You’re offline — reconnect to chat',
  'chat.composer.settings': 'Automatic analysis',
  'chat.hint.send': 'Enter to send · Shift+Enter for a new line',
  'chat.hint.offline': 'Reconnect to send messages',
  'chat.example.shops': 'List my connected shops',
  'chat.example.orders': 'Show today’s orders',
  'chat.example.products': 'Search my products',
};
