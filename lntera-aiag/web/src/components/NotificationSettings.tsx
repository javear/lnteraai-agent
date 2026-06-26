import { useEffect, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { getPushState, onPushChange, subscribePush, unsubscribePush, type PushState } from '@/lib/push';

export function NotificationSettings({
  open,
  onOpenChange,
  inAppEnabled,
  setInAppEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inAppEnabled: boolean;
  setInAppEnabled: (value: boolean) => void;
}) {
  const [push, setPush] = useState<PushState>(() => getPushState());
  const [busy, setBusy] = useState(false);
  const t = useT();

  // Refresh state while the dialog is open (and react to changes from other tabs).
  useEffect(() => {
    if (!open) return;
    setPush(getPushState());
    return onPushChange(() => setPush(getPushState()));
  }, [open]);

  const denied = push.permission === 'denied';
  const pushUnavailable = !push.ready || !push.supported;

  async function togglePush(next: boolean) {
    setBusy(true);
    try {
      setPush(next ? await subscribePush() : await unsubscribePush());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('notif.title')}</DialogTitle>
          <DialogDescription>{t('notif.desc')}</DialogDescription>
        </DialogHeader>

        <div className="mt-5 flex flex-col gap-5">
          <Row
            title={t('notif.push.title')}
            desc={denied ? t('notif.push.blocked') : pushUnavailable ? t('notif.push.unavailable') : t('notif.push.desc')}
          >
            <Switch
              checked={push.optedIn}
              disabled={busy || pushUnavailable || denied}
              onCheckedChange={(v) => void togglePush(v)}
              aria-label={t('notif.push.title')}
            />
          </Row>

          <Row title={t('notif.inapp.title')} desc={t('notif.inapp.desc')}>
            <Switch checked={inAppEnabled} onCheckedChange={setInAppEnabled} aria-label={t('notif.inapp.title')} />
          </Row>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{desc}</p>
      </div>
      <div className="mt-0.5 shrink-0">{children}</div>
    </div>
  );
}
