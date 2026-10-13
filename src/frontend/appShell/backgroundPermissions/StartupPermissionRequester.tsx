import Constants from 'expo-constants';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { usePreference } from '@/frontend/data/hooks';
import { loggerService } from '@/shared/core/logger/LoggerService';

const logger = loggerService.withContext('StartupPermissions');

/**
 * Android asks for the two grants a background agent run depends on as soon as the
 * shell mounts: notification permission, which the foreground-service notification
 * needs, and the battery-optimisation exemption, without which the OS may kill a long
 * reply once the app is hidden. Both are best effort — a refusal only limits background
 * execution, never foreground chat, so nothing here may throw into the render tree.
 *
 * The exemption sheet is offered once per install; the notification sheet is only
 * raised while the OS still reports it as askable.
 */
export function StartupPermissionRequester(): null {
  const [hasPrompted, setHasPrompted] = usePreference('app.background_permissions.prompted');
  const started = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'android' || started.current || hasPrompted) return;
    started.current = true;
    void (async () => {
      try {
        const Notifications = await import('expo-notifications');
        const current = await Notifications.getPermissionsAsync();
        if (!current.granted && current.canAskAgain) await Notifications.requestPermissionsAsync();
      } catch (error) {
        logger.warn('Notification permission request failed', error as Error);
      }
      try {
        const packageName = Constants.expoConfig?.android?.package;
        if (packageName) {
          const { startActivityAsync } = await import('expo-intent-launcher');
          await startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', {
            data: `package:${packageName}`,
          });
        }
      } catch (error) {
        logger.warn('Battery optimisation prompt failed', error as Error);
      }
      await setHasPrompted(true).catch(() => {});
    })();
  }, [hasPrompted, setHasPrompted]);

  return null;
}
