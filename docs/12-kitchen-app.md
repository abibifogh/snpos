# 12, The kitchen app (native Android)

**In plain terms:** the kitchen screen becomes a proper installed app rather
than a web page. That's what guarantees the alarm actually sounds when an order
arrives, at full volume, even if the tablet is locked, minimised, or was just
restarted. Web pages get quietened by the browser when they're not in front;
an app doesn't.

You'll need one **Android** tablet per kitchen station (a cheap 10" one is
fine). Everything else in the system stays a normal web app.

---

## 12.1 What the wrapper adds

Built with **Capacitor**, wrapping the same KDS web app, so the screen itself
never drifts out of step with the rest of the system. Only the alarm and device
behaviour are native.

| Capability | What it fixes |
| --- | --- |
| **Foreground service** | Android keeps the app alive and the connection open even when it's not on screen. A browser tab gets suspended |
| **Alarm-stream audio** | Plays on the alarm channel, which ignores the ringer/media volume and Do Not Disturb. Nobody can accidentally silence the kitchen |
| **Full-volume override** | The app raises alarm volume to maximum while a ticket is unacknowledged, and restores it afterwards |
| **Wake + turn screen on** | A new order wakes and unlocks the display, so the ticket is visible, not just audible |
| **Boot receiver** | If the tablet reboots mid-service (power cut, update), the app restarts itself and reconnects. This is the failure that hurts most |
| **Persistent notification** | Full-screen intent notification for a pending order, so it appears over whatever else is showing |
| **Screen pinning / kiosk** | Staff can't navigate away or close it |
| **Vibration + external speaker routing** | For loud kitchens |
| **Silent failure detection** | If audio can't be acquired, the app reports itself as degraded to the manager dashboard rather than sitting there mute |

## 12.2 The alarm, precisely

1. New order arrives (server push, or local peer sync when offline).
2. Alarm starts: repeating tone on the alarm stream, screen wakes, ticket shown
   full-screen, tablet vibrates.
3. The alarm **does not stop on its own** and has no snooze. It stops only when
   the order leaves `PENDING`, which includes another station accepting it,
   because the stop is driven by the shared order state, not by the local
   button.
4. Escalation matches doc 04: louder and more frequent at each level, and past
   level 3 the manager's device is notified too. Escalation is computed on the
   server, so a dead kitchen tablet still raises the alarm somewhere.
5. Rejecting requires a reason, exactly as in doc 04; the modal can't be
   dismissed without one.

## 12.3 Build and install

Added to the deployment guide as **Stage 8b**:

```bash
pnpm --filter kitchen build          # builds the web app
npx cap sync android                 # copies it into the Android shell
npx cap open android                 # opens Android Studio
```

Then either:

- **Sideload (simplest for a few tablets):** build a signed APK, copy it to the
  tablet, allow "install from unknown sources", install. No Play Store account
  needed, no review delay. Recommended for you.
- **Play Store internal testing:** if you'd rather have automatic updates across
  many venues. Needs a one-off $25 developer account and a day or two of review.

**Keep the signing keystore safe and backed up.** Lose it and you can't update
the installed apps, only reinstall from scratch.

## 12.4 Tablet setup checklist

1. Install the app; grant notification, alarm and "display over other apps"
   permissions.
2. Sign in with the station's device account, pick the station (hot / cold /
   bar / all).
3. Turn off battery optimisation for the app, Android will otherwise kill it
   overnight. This is the single most common cause of "the alarm stopped
   working after a few days".
4. Turn off screen timeout; keep it on mains power.
5. Enable screen pinning.
6. Pair a loud external speaker. Tablet speakers lose to an extractor fan.
7. Fire a test order and confirm the alarm sounds with the screen off.
8. Reboot the tablet and confirm the app comes back by itself.

Steps 3, 7 and 8 are the ones people skip and later regret.

## 12.5 What stays web

POS terminals, the admin dashboard and the customer QR menu remain normal web
apps, installable to the home screen, updated by deploying, no app store
involved. Only the kitchen needed the native treatment, and only because of the
alarm.
