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
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',

  // Language
  'language.title': 'Language',
  'language.description': 'Language for the app and the assistant’s replies.',
  'language.save': 'Save language',
  'language.saved': 'Language updated.',
  'language.error': 'Could not change language.',

  // Active Agent settings modal
  'settings.title': 'Active Agent settings',

  // Chat / composer
  'chat.newChat': 'New chat',
  'chat.placeholder': 'Message the agent…',
  'chat.send': 'Send',
  'chat.stop': 'Stop',
  'chat.empty.title': 'How can I help?',
  'chat.empty.subtitle': 'Ask about your orders, products, sales, or finances.',
  'chat.noResponse': 'I didn’t get a response — please try again.',
  'chat.error.start': 'Could not start a new chat. Check your connection and try again.',
  'chat.loadingOlder': 'Loading older messages…',
};
