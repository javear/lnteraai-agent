// Inngest Cloud client. Event/signing keys are read from env (INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY)
// by the serve handler — Inngest Cloud invokes our deployed /api/inngest endpoint; nothing runs in
// local dev. Keep this module import-light so it can be tree-shaken away from non-Inngest paths.
import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'lntera' });
