// Agent-callable: switch the user's language preference (English ⇄ Indonesian). Use when the user asks
// to change language ("reply in Indonesian", "pakai bahasa Indonesia", "switch to English"). Persists the
// per-tenant preference so the app UI + future replies + notifications all follow it.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import {
  SUPPORTED_LANGUAGES,
  languageLabel,
  normalizeLanguage,
  setTenantLanguage,
} from '../../integrations/shared/language-prefs';

export const setLanguageTool = createTool({
  id: 'set-language',
  strict: false,
  description:
    'Change the user\'s language preference for the whole app (assistant replies AND UI labels). Use when the user asks to switch language, e.g. "reply in Indonesian", "ganti ke bahasa Indonesia", "use English". `language`: a code or name — "id"/"indonesian"/"bahasa" or "en"/"english". After calling, reply in the NEW language to confirm.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.object({ language: z.string().describe('Language code or name (e.g. "id", "indonesian", "en", "english").') }),
  inputExamples: [{ input: { language: 'indonesian' } }, { input: { language: 'en' } }],
  outputSchema: z.object({ success: z.boolean(), language: z.string().optional(), message: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const lang = normalizeLanguage((input as { language?: unknown })?.language);
    if (!lang) {
      return {
        success: false,
        message: `Supported languages: ${Object.values(SUPPORTED_LANGUAGES).join(', ')}.`,
      };
    }
    await setTenantLanguage(tenantId, lang);
    return {
      success: true,
      language: lang,
      message: `Language set to ${languageLabel(lang)}. Reply to the user in ${languageLabel(lang)} from now on.`,
    };
  },
});
